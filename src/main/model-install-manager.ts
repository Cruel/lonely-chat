import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { constants } from 'node:fs';
import {
  mkdir,
  lstat,
  open,
  readFile,
  realpath,
  rename,
  rm,
  statfs,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import type { ModelFile, ModelRole } from '../shared/model-contract';
import type {
  InstalledModel,
  InstalledModelFile,
  ModelInstallRequest,
  ModelManagerSnapshot,
  InstallProgress,
} from '../shared/model-install-contract';
import { ModelDiscovery, parseHuggingFaceInput } from './model-discovery';

type Configuration = {
  version: 1;
  storageDirectory: string;
  installations: InstalledModel[];
  active: Record<ModelRole, string | null>;
};
const VERSION = 1;
const CONFIG = 'model-manager.json';
const MANIFEST = '.lonely-chat-install.json';
const ID_PATTERN = /^[a-f0-9]{32}$/;
const EMPTY_PROGRESS: InstallProgress = {
  phase: 'idle',
  file: null,
  receivedBytes: 0,
  totalBytes: null,
};
const SHA = /^[a-f0-9]{64}$/;

function safeFilePath(value: string): boolean {
  return (
    value.length > 0 &&
    value
      .split('/')
      .every(
        (part) =>
          part !== '.' &&
          part !== '..' &&
          part !== '' &&
          !/[<>:"|?*\\\\]/.test(part) &&
          !/[. ]$/.test(part) &&
          !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\\.|$)/i.test(part) &&
          [...part].every((c) => c.charCodeAt(0) >= 32),
      )
  );
}

function checkedPath(base: string, relative: string): string {
  if (!safeFilePath(relative)) throw new Error('Invalid model file path.');
  const resolved = path.resolve(base, ...relative.split('/'));
  if (!resolved.startsWith(base + path.sep)) throw new Error('Model file escapes managed storage.');
  return resolved;
}

async function maybeStat(file: string) {
  try {
    return await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function safeDirectory(directory: string, root: string): Promise<void> {
  if (!directory.startsWith(root + path.sep) && directory !== root) {
    throw new Error('Storage path escapes managed storage.');
  }
  const parent = path.dirname(directory);
  if (directory !== root) await safeDirectory(parent, root);
  const existing = await maybeStat(directory);
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
    throw new Error('Managed storage contains an unsafe symbolic link or non-directory.');
  }
  if (!existing) await mkdir(directory);
}

async function safeFile(file: string, root: string): Promise<void> {
  await safeDirectory(path.dirname(file), root);
  const existing = await maybeStat(file);
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new Error('Managed storage contains an unsafe symbolic link or non-file.');
  }
}

async function digest(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function validateInstall(value: unknown): InstalledModel {
  if (!value || typeof value !== 'object') throw new Error('Invalid installed-model entry.');
  const item = value as InstalledModel;
  if (
    !ID_PATTERN.test(item.id) ||
    typeof item.repo !== 'string' ||
    typeof item.revision !== 'string' ||
    typeof item.candidateId !== 'string' ||
    (item.role !== 'vision-language' && item.role !== 'speech-to-text') ||
    (item.projectorId !== null && typeof item.projectorId !== 'string') ||
    !Array.isArray(item.files) ||
    !item.files.length ||
    !Number.isFinite(item.installedAt)
  ) {
    throw new Error('Invalid installed-model registry entry.');
  }
  const seen = new Set<string>();
  for (const file of item.files) {
    if (
      !safeFilePath(file.path) ||
      !file.relativePath.startsWith('files/') ||
      !safeFilePath(file.relativePath) ||
      seen.has(file.relativePath) ||
      !Number.isSafeInteger(file.sizeBytes) ||
      file.sizeBytes < 0 ||
      !SHA.test(file.sha256)
    ) {
      throw new Error('Invalid installed-model file metadata.');
    }
    seen.add(file.relativePath);
  }
  return item;
}

/**
 * Owns model storage, verified packages and activation choices.
 * Nothing is registered until every file is verified and the directory is published atomically.
 */
export class ModelInstallManager {
  private config: Configuration;
  private progress: InstallProgress = EMPTY_PROGRESS;
  private readonly listeners = new Set<(snapshot: ModelManagerSnapshot) => void>();
  private abort: AbortController | null = null;
  private busy = false;
  private opened = false;

  constructor(
    private readonly userData: string,
    private readonly discovery: ModelDiscovery = new ModelDiscovery(),
    private readonly fetcher: typeof fetch = fetch,
    private readonly freeBytes: (directory: string) => Promise<number> = async (directory) => {
      const stats = await statfs(directory);
      return Number(stats.bavail) * Number(stats.bsize);
    },
  ) {
    this.config = {
      version: VERSION,
      storageDirectory: path.join(userData, 'models'),
      installations: [],
      active: { 'vision-language': null, 'speech-to-text': null },
    };
  }

  async open(): Promise<ModelManagerSnapshot> {
    if (this.opened) return this.snapshot();
    await mkdir(this.userData, { recursive: true });
    let existing: unknown;
    try {
      existing = JSON.parse(await readFile(path.join(this.userData, CONFIG), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (existing !== undefined) {
      const state = existing as Configuration;
      if (
        state?.version !== VERSION ||
        typeof state.storageDirectory !== 'string' ||
        !Array.isArray(state.installations) ||
        !state.active ||
        !(['vision-language', 'speech-to-text'] as const).every(
          (role) => state.active[role] === null || typeof state.active[role] === 'string',
        )
      ) {
        throw new Error('Unsupported or invalid model-manager configuration.');
      }
      const installations = state.installations.map(validateInstall);
      if (new Set(installations.map((item) => item.id)).size !== installations.length) {
        throw new Error('Duplicate model registry entries.');
      }
      this.config = { ...state, installations };
    }
    await mkdir(this.config.storageDirectory, { recursive: true });
    this.config.storageDirectory = await realpath(this.config.storageDirectory);
    await this.ensureRoots();
    // An installed entry is usable only if the on-disk manifest and all bytes still match.
    const verified: InstalledModel[] = [];
    for (const entry of this.config.installations) {
      try {
        await this.verifyInstallation(entry);
        verified.push(entry);
      } catch {
        // Leave the original files alone: never delete or activate an unverified package.
      }
    }
    let changed = verified.length !== this.config.installations.length;
    this.config.installations = verified;
    for (const role of ['vision-language', 'speech-to-text'] as const) {
      if (
        this.config.active[role] &&
        !verified.some((entry) => entry.id === this.config.active[role] && entry.role === role)
      ) {
        this.config.active[role] = null;
        changed = true;
      }
    }
    if (changed) await this.save();
    this.opened = true;
    return this.snapshot();
  }

  snapshot(): ModelManagerSnapshot {
    return {
      storageDirectory: this.config.storageDirectory,
      installations: this.config.installations.map((entry) => ({
        ...entry,
        files: [...entry.files],
      })),
      active: { ...this.config.active },
      progress: { ...this.progress },
    };
  }

  subscribe(listener: (snapshot: ModelManagerSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    const current = this.snapshot();
    for (const listener of this.listeners) listener(current);
  }

  private setProgress(progress: InstallProgress): void {
    this.progress = progress;
    this.notify();
  }

  async changeDirectory(selected: string): Promise<ModelManagerSnapshot> {
    this.requireReady();
    if (this.busy || this.config.installations.length) {
      throw new Error(
        'Remove installed models and finish downloads before changing the model directory.',
      );
    }
    if (typeof selected !== 'string' || !path.isAbsolute(selected)) {
      throw new Error('Select an existing model directory.');
    }
    const actual = await realpath(selected);
    if (!(await lstat(actual)).isDirectory())
      throw new Error('Select an existing model directory.');
    const before = this.config.storageDirectory;
    this.config.storageDirectory = actual;
    try {
      await this.ensureRoots();
      await this.save();
    } catch (error) {
      this.config.storageDirectory = before;
      throw error;
    }
    this.notify();
    return this.snapshot();
  }

  private requireReady(): void {
    if (!this.opened) throw new Error('Model manager has not been initialized.');
  }

  private async ensureRoots(): Promise<void> {
    const base = this.config.storageDirectory;
    await safeDirectory(path.join(base, 'installed'), base);
    await safeDirectory(path.join(base, '.partial'), base);
  }

  private async save(): Promise<void> {
    const target = path.join(this.userData, CONFIG);
    const temporary = target + '.tmp';
    try {
      await writeFile(temporary, JSON.stringify(this.config, null, 2) + '\n', { mode: 0o600 });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async setActive(role: ModelRole, id: string | null): Promise<ModelManagerSnapshot> {
    this.requireReady();
    if (this.busy) throw new Error('Wait for the current download to finish.');
    if (role !== 'vision-language' && role !== 'speech-to-text')
      throw new Error('Invalid model role.');
    const chosen =
      id === null
        ? null
        : this.config.installations.find((entry) => entry.id === id && entry.role === role);
    if (id !== null && !chosen) throw new Error('Select an installed model of the requested role.');
    if (chosen) await this.verifyInstallation(chosen);
    const previous = this.config.active[role];
    this.config.active[role] = id;
    try {
      await this.save();
    } catch (error) {
      this.config.active[role] = previous;
      throw error;
    }
    this.notify();
    return this.snapshot();
  }

  /** Resolve only manager-verified bytes for a new native inference session. */
  async activeVisionFiles(): Promise<{ modelPath: string; projectorPath: string | null }> {
    this.requireReady();
    const active = this.config.active['vision-language'];
    if (!active) throw new Error('Activate an installed vision/language GGUF model first.');
    return this.visionFiles(active);
  }

  /** A Playground run may select any installed VLM without changing the active Simulation model. */
  async visionFiles(id: string): Promise<{ modelPath: string; projectorPath: string | null }> {
    this.requireReady();
    const entry = this.config.installations.find(
      (item) => item.id === id && item.role === 'vision-language',
    );
    if (!entry) throw new Error('Select an installed vision/language GGUF model.');
    await this.verifyInstallation(entry);
    const root = path.join(this.config.storageDirectory, 'installed', entry.id);
    const base = (value: string) => value.replace(/-\d{5}-of-\d{5}(?=\.gguf$)/i, '');
    const model = entry.files.find((file) => base(file.path) === entry.candidateId);
    if (!model) throw new Error('Installed GGUF model files do not match their selection.');
    const projector = entry.projectorId
      ? entry.files.find((file) => base(file.path) === entry.projectorId)
      : null;
    if (entry.projectorId && !projector) {
      throw new Error('The selected vision projector is missing from this installation.');
    }
    return {
      modelPath: checkedPath(root, model.relativePath),
      projectorPath: projector ? checkedPath(root, projector.relativePath) : null,
    };
  }

  /** Resolve manager-verified native whisper.cpp GGML model bytes. */
  async activeSpeechFile(): Promise<string> {
    this.requireReady();
    const id = this.config.active['speech-to-text'];
    const entry = this.config.installations.find(
      (item) => item.id === id && item.role === 'speech-to-text',
    );
    if (!entry || entry.files.length !== 1 || entry.files[0].path !== entry.candidateId) {
      throw new Error('Activate an installed whisper.cpp speech model first.');
    }
    await this.verifyInstallation(entry);
    return checkedPath(
      path.join(this.config.storageDirectory, 'installed', entry.id),
      entry.files[0].relativePath,
    );
  }

  async remove(id: string): Promise<ModelManagerSnapshot> {
    this.requireReady();
    if (this.busy) throw new Error('Wait for the current download to finish.');
    const chosen = this.config.installations.find((entry) => entry.id === id);
    if (!chosen) throw new Error('Model is not registered in managed storage.');
    const destination = path.join(this.config.storageDirectory, 'installed', chosen.id);
    // Refuse deletion of a directory without our matching manifest or with symlink contents.
    await this.checkManifest(chosen);
    await this.verifySafeTree(destination, chosen);
    const old = this.config;
    this.config = {
      ...old,
      installations: old.installations.filter((item) => item.id !== id),
      active: {
        'vision-language':
          old.active['vision-language'] === id ? null : old.active['vision-language'],
        'speech-to-text': old.active['speech-to-text'] === id ? null : old.active['speech-to-text'],
      },
    };
    try {
      await this.save();
    } catch (error) {
      this.config = old;
      throw error;
    }
    this.notify();
    await rm(destination, { recursive: true });
    return this.snapshot();
  }

  cancel(): void {
    this.abort?.abort();
  }

  async install(raw: ModelInstallRequest): Promise<ModelManagerSnapshot> {
    this.requireReady();
    if (this.busy) throw new Error('Another model installation is already in progress.');
    if (
      !raw ||
      typeof raw.source !== 'string' ||
      typeof raw.candidateId !== 'string' ||
      (raw.projectorId !== null && typeof raw.projectorId !== 'string')
    ) {
      throw new Error('Invalid model selection.');
    }
    this.busy = true;
    this.setProgress({ phase: 'downloading', file: null, receivedBytes: 0, totalBytes: null });
    const abort = new AbortController();
    this.abort = abort;
    try {
      // Always re-discover on the trusted main process; renderer-supplied paths are never trusted.
      const found = await this.discovery.discover(raw.source);
      const candidate = found.candidates.find((item) => item.id === raw.candidateId);
      if (!candidate) throw new Error('The selected GGUF/speech model is no longer available.');
      let projectorId = raw.projectorId;
      if (candidate.role === 'speech-to-text' && projectorId !== null) {
        throw new Error('Speech models cannot have vision projectors.');
      }
      if (candidate.role === 'vision-language') {
        if (projectorId === null && candidate.compatibleProjectorIds.length > 1) {
          throw new Error('Choose a vision projector or explicitly select text-only.');
        }
        if (projectorId === null) projectorId = candidate.suggestedProjectorId;
      }
      const projector =
        projectorId && projectorId !== 'none'
          ? found.projectors.find(
              (item) =>
                item.id === projectorId && candidate.compatibleProjectorIds.includes(item.id),
            )
          : null;
      if (projectorId && projectorId !== 'none' && !projector) {
        throw new Error('The selected projector does not match the model.');
      }
      const files: ModelFile[] = [...candidate.files, ...(projector?.files ?? [])];
      if (
        new Set(files.map((file) => file.path.toLowerCase())).size !== files.length ||
        files.some((file) => !safeFilePath(file.path))
      ) {
        throw new Error('Duplicate or unsafe model files in Hugging Face repository.');
      }
      const source = parseHuggingFaceInput(raw.source);
      const normalizedProjector = projector?.id ?? null;
      const identity = createHash('sha256')
        .update(JSON.stringify([source.repo, source.revision, candidate.id, normalizedProjector]))
        .digest('hex')
        .slice(0, 32);
      if (this.config.installations.some((entry) => entry.id === identity)) {
        throw new Error('This model package is already installed.');
      }
      const root = this.config.storageDirectory;
      const staged = path.join(root, '.partial', identity);
      const installed = path.join(root, 'installed', identity);
      if (await maybeStat(installed)) {
        // Power loss between publishing the verified package and saving the registry.
        // Adopt only a complete, matching and freshly verified manager-owned package.
        await safeDirectory(installed, root);
        await safeFile(path.join(installed, MANIFEST), root);
        const orphan = validateInstall(
          JSON.parse(await readFile(path.join(installed, MANIFEST), 'utf8')),
        );
        if (
          orphan.id !== identity ||
          orphan.repo !== source.repo ||
          orphan.revision !== source.revision ||
          orphan.candidateId !== candidate.id ||
          orphan.projectorId !== normalizedProjector ||
          orphan.role !== candidate.role ||
          orphan.files.length !== files.length ||
          files.some(
            (file, index) =>
              orphan.files[index].path !== file.path ||
              (file.sizeBytes !== null && orphan.files[index].sizeBytes !== file.sizeBytes) ||
              (file.sha256 && orphan.files[index].sha256 !== file.sha256),
          )
        ) {
          throw new Error(
            'An existing package conflicts with the selected model; nothing was overwritten.',
          );
        }
        await this.verifyInstallation(orphan);
        await this.register(orphan);
        return this.snapshot();
      }
      await safeDirectory(staged, root);
      const totalBytes = files.every((item) => item.sizeBytes !== null)
        ? files.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0)
        : null;
      let receivedBytes = 0;
      this.setProgress({ phase: 'downloading', file: null, receivedBytes, totalBytes });
      const savedFiles: InstalledModelFile[] = [];
      for (const file of files) {
        if (abort.signal.aborted) throw new Error('Model download cancelled. Retry to resume.');
        const relativePath = 'files/' + file.path;
        const destination = checkedPath(staged, relativePath);
        await safeFile(destination, root);
        const available = await maybeStat(destination);
        if (available) {
          const hash = await digest(destination);
          if (file.sha256 && available.size === file.sizeBytes && hash === file.sha256) {
            savedFiles.push({
              path: file.path,
              relativePath,
              sizeBytes: available.size,
              sha256: hash,
            });
            receivedBytes += available.size;
            continue;
          }
          await rm(destination);
        }
        let lastUpdate = 0;
        const progress = (written: number) => {
          if (Date.now() - lastUpdate < 120 && written !== file.sizeBytes) return;
          lastUpdate = Date.now();
          this.setProgress({
            phase: 'downloading',
            file: file.path,
            receivedBytes: receivedBytes + written,
            totalBytes,
          });
        };
        const entry = await this.downloadFile(
          source.repo,
          source.revision,
          file,
          destination,
          abort.signal,
          progress,
        );
        savedFiles.push({ path: file.path, relativePath, ...entry });
        receivedBytes += entry.sizeBytes;
      }
      this.setProgress({ phase: 'verifying', file: null, receivedBytes, totalBytes });
      const record: InstalledModel = {
        id: identity,
        repo: source.repo,
        revision: source.revision,
        candidateId: candidate.id,
        projectorId: normalizedProjector,
        role: candidate.role,
        files: savedFiles,
        installedAt: Date.now(),
      };
      const stagedManifest = path.join(staged, MANIFEST);
      await safeFile(stagedManifest, root);
      // A previous config-write failure may have returned a published directory to staging.
      await rm(stagedManifest, { force: true });
      await writeFile(stagedManifest, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
      await rename(staged, installed);
      try {
        await this.register(record);
      } catch (error) {
        await rename(installed, staged);
        throw error;
      }
      this.setProgress(EMPTY_PROGRESS);
      return this.snapshot();
    } finally {
      this.busy = false;
      this.abort = null;
      this.setProgress(EMPTY_PROGRESS);
    }
  }

  private async register(entry: InstalledModel): Promise<void> {
    const before = this.config;
    this.config = { ...before, installations: [...before.installations, entry] };
    try {
      await this.save();
    } catch (error) {
      this.config = before;
      throw error;
    }
    this.notify();
  }

  private async downloadFile(
    repo: string,
    revision: string,
    file: ModelFile,
    destination: string,
    signal: AbortSignal,
    progress: (bytes: number) => void,
  ): Promise<{ sizeBytes: number; sha256: string }> {
    const partial = destination + '.part';
    const resumeFile = destination + '.resume.json';
    await safeFile(partial, this.config.storageDirectory);
    await safeFile(resumeFile, this.config.storageDirectory);
    let meta: { etag: string | null; expected: string | null } | null = null;
    try {
      meta = JSON.parse(await readFile(resumeFile, 'utf8'));
    } catch {
      meta = null;
    }
    if (meta?.expected !== (file.sha256 ?? null) || (!meta?.etag && !file.sha256)) {
      await rm(partial, { force: true });
      meta = null;
    }
    const partialInfo = await maybeStat(partial);
    let offset = meta && partialInfo ? partialInfo.size : 0;
    if (file.sizeBytes !== null && offset > file.sizeBytes) {
      await rm(partial, { force: true });
      offset = 0;
    }
    const url =
      'https://huggingface.co/' +
      repo.split('/').map(encodeURIComponent).join('/') +
      '/resolve/' +
      encodeURIComponent(revision) +
      '/' +
      file.path.split('/').map(encodeURIComponent).join('/');
    let response: Response | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers: Record<string, string> = {};
      if (offset > 0) {
        headers.Range = `bytes=${offset}-`;
        if (meta?.etag) headers['If-Range'] = meta.etag;
      }
      response = await this.fetcher(url, { headers, signal });
      const contentRange = response.headers.get('content-range');
      const start = contentRange?.match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/);
      if (
        offset > 0 &&
        (response.status === 416 ||
          (response.status === 206 &&
            (!start ||
              Number(start[1]) !== offset ||
              (meta?.etag && response.headers.get('etag') !== meta.etag))))
      ) {
        await response.body?.cancel();
        offset = 0;
        await rm(partial, { force: true });
        continue;
      }
      if (response.status !== 200 && response.status !== 206) {
        throw new Error(`Hugging Face download failed (HTTP ${response.status}) for ${file.path}.`);
      }
      if (response.status === 206 && (offset === 0 || !start)) {
        throw new Error('Hugging Face returned an unexpected partial download range.');
      }
      if (response.status === 200) offset = 0; // Server ignored Range; restart, never append.
      if (response.url && !response.url.startsWith('https://')) {
        throw new Error('Insecure model download redirect was rejected.');
      }
      break;
    }
    if (!response || (response.status !== 200 && response.status !== 206)) {
      throw new Error('Unable to resume Hugging Face download.');
    }
    const length = response.headers.get('content-length');
    const expectedTransfer = length && /^\d+$/.test(length) ? Number(length) : null;
    const contentRange = response.headers.get('content-range');
    const rangeTotal = contentRange?.match(/^bytes \d+-\d+\/(\d+)$/);
    const expectedSize = file.sizeBytes ?? (rangeTotal ? Number(rangeTotal[1]) : null);
    const remaining = expectedSize === null ? expectedTransfer : expectedSize - offset;
    if (remaining !== null && (await this.freeBytes(this.config.storageDirectory)) < remaining) {
      await response.body?.cancel();
      throw new Error(`Not enough free disk space to download ${file.path}.`);
    }
    await writeFile(
      resumeFile,
      JSON.stringify({
        etag: response.headers.get('etag'),
        expected: file.sha256 ?? null,
      }),
      { mode: 0o600 },
    );
    if (!response.body) throw new Error('Hugging Face did not send model file data.');
    const handle = await open(
      partial,
      constants.O_CREAT |
        constants.O_WRONLY |
        constants.O_NOFOLLOW |
        (offset > 0 ? constants.O_APPEND : constants.O_TRUNC),
      0o600,
    );
    let transferred = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        if (signal.aborted) throw new Error('Model download cancelled. Retry to resume.');
        const chunk = await reader.read();
        if (chunk.done) break;
        const data = Buffer.from(chunk.value);
        await handle.writeFile(data);
        transferred += data.length;
        progress(offset + transferred);
        if (file.sizeBytes !== null && offset + transferred > file.sizeBytes) {
          throw new Error(`Download exceeded expected size: ${file.path}.`);
        }
      }
      await handle.sync();
    } finally {
      reader.releaseLock();
      await handle.close();
    }
    if (expectedTransfer !== null && transferred !== expectedTransfer) {
      throw new Error(`Incomplete model download for ${file.path}; retry to resume.`);
    }
    const sizeBytes = offset + transferred;
    if (expectedSize !== null && sizeBytes !== expectedSize) {
      throw new Error(`Incomplete model download for ${file.path}; retry to resume.`);
    }
    const sha256 = await digest(partial);
    if (file.sha256 && sha256 !== file.sha256) {
      await rm(partial, { force: true });
      await rm(resumeFile, { force: true });
      throw new Error(`SHA-256 verification failed for ${file.path}; invalid download discarded.`);
    }
    await rename(partial, destination);
    await rm(resumeFile, { force: true });
    return { sizeBytes, sha256 };
  }

  private async checkManifest(entry: InstalledModel): Promise<string> {
    const directory = path.join(this.config.storageDirectory, 'installed', entry.id);
    const stats = await maybeStat(directory);
    if (!stats?.isDirectory() || stats.isSymbolicLink()) {
      throw new Error('Installed model directory is missing or unsafe.');
    }
    const manifest = path.join(directory, MANIFEST);
    await safeFile(manifest, this.config.storageDirectory);
    const saved: unknown = JSON.parse(await readFile(manifest, 'utf8'));
    if (JSON.stringify(saved) !== JSON.stringify(entry)) {
      throw new Error('Installed model ownership manifest does not match the registry.');
    }
    return directory;
  }

  private async verifyInstallation(entry: InstalledModel): Promise<void> {
    const directory = await this.checkManifest(entry);
    for (const file of entry.files) {
      const location = checkedPath(directory, file.relativePath);
      await safeFile(location, this.config.storageDirectory);
      const stats = await maybeStat(location);
      if (!stats || stats.size !== file.sizeBytes || (await digest(location)) !== file.sha256) {
        throw new Error(`Installed model file failed verification: ${file.path}.`);
      }
    }
  }

  private async verifySafeTree(root: string, installation: InstalledModel): Promise<void> {
    const { readdir } = await import('node:fs/promises');
    const files = new Set([MANIFEST, ...installation.files.map((file) => file.relativePath)]);
    const directories = new Set<string>();
    for (const file of files) {
      const parts = file.split('/');
      for (let length = 1; length < parts.length; length++) {
        directories.add(parts.slice(0, length).join('/'));
      }
    }
    const visit = async (relative: string): Promise<void> => {
      for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) throw new Error('Refusing to delete symlinked model files.');
        if (entry.isDirectory() && directories.has(name)) await visit(name);
        else if (!entry.isFile() || !files.has(name)) {
          throw new Error(`Refusing to delete unowned model installation content: ${name}`);
        }
      }
    };
    await visit('');
  }
}
