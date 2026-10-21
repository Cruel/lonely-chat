import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validatePreferences } from '../shared/session-contract';
import { validateProfileSnapshot, type InferenceProfile } from '../shared/inference-profile-contract';
import { supportedRecordedMediaPath } from './recorded-media-access';
import type {
  RecordedRun,
  RecordedScenario,
  RecordedScenarioConfig,
} from '../shared/recorded-scenario-contract';

const FILE = 'recorded-scenarios.json';
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_SCENARIOS = 100;
const MAX_RUNS = 1000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (value: unknown, max: number) => typeof value === 'string' && value.length <= max;
const filePath = (value: unknown) =>
  typeof value === 'string' && value.length > 0 && value.length <= 4096 && path.isAbsolute(value);
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid recorded Scenario data.');
  return value as Record<string, unknown>;
};
const integer = (value: unknown, min: number, max: number) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;

export function validateScenarioConfig(value: unknown): RecordedScenarioConfig {
  const config = object(value);
  const video = config.video === null ? null : object(config.video);
  if (
    !text(config.context, 2000) ||
    (config.mode !== 'fake' && config.mode !== 'native' && config.mode !== 'remote') ||
    (video &&
      (!filePath(video.path) ||
        (video.offsetMs !== undefined && !integer(video.offsetMs, -86400000, 86400000)))) ||
    !Array.isArray(config.audio) ||
    config.audio.length > 32 ||
    !['transcribe', 'save', 'cached'].includes(String(config.transcriptMode)) ||
    typeof config.publishToOverlay !== 'boolean' ||
    (config.seed !== null && !integer(config.seed, 0, 2147483647)) ||
    (config.presetId !== null && (!text(config.presetId, 100) || config.presetId === '')) ||
    (config.presetRevision !== null &&
      (!integer(config.presetRevision, 1, 1000000) || config.presetId === null)) ||
    (config.modelId !== null && (!text(config.modelId, 200) || config.modelId === '')) ||
    (config.profileId !== undefined &&
      config.profileId !== null &&
      (!text(config.profileId, 100) || !config.profileId)) ||
    (config.profileRevision !== undefined &&
      config.profileRevision !== null &&
      (!integer(config.profileRevision, 1, 1000000) || !config.profileId)) ||
    (config.profileSnapshot !== undefined &&
      config.profileSnapshot !== null &&
      !config.profileId) ||
    (config.settingsPolicy !== 'saved' && config.settingsPolicy !== 'current')
  )
    throw new Error('Invalid recorded Scenario configuration.');
  const profileSnapshot =
    config.profileSnapshot === undefined || config.profileSnapshot === null
      ? (config.profileSnapshot as null | undefined)
      : validateProfileSnapshot(config.profileSnapshot);
  if (
    profileSnapshot &&
    (profileSnapshot.id !== config.profileId || profileSnapshot.revision !== config.profileRevision)
  )
    throw new Error('Scenario Inference Profile snapshot does not match its selected revision.');
  const seen = new Set<string>();
  for (const item of config.audio) {
    const track = object(item);
    if (
      !text(track.id, 100) ||
      !track.id ||
      seen.has(track.id as string) ||
      !['file', 'video', 'device'].includes(String(track.kind)) ||
      (track.kind === 'file'
        ? !filePath(track.path)
        : track.kind === 'video'
          ? track.path !== null || !video
          : track.path !== null ||
            (track.deviceId !== null &&
              (typeof track.deviceId !== 'string' ||
                !track.deviceId ||
                /\s/.test(track.deviceId) ||
                track.deviceId.length > 180)) ||
            (track.enabled && !track.deviceId)) ||
      !text(track.label, 80) ||
      (track.enabled && !String(track.label).trim()) ||
      typeof track.enabled !== 'boolean' ||
      !integer(track.offsetMs, -86400000, 86400000) ||
      (track.embeddedTrackIndex !== null && !integer(track.embeddedTrackIndex, 0, 32))
    )
      throw new Error('Invalid recorded audio source definition.');
    seen.add(track.id as string);
  }
  const segment = object(config.segment);
  if (
    !integer(segment.startMs, 0, 86400000) ||
    (segment.endMs !== null &&
      (!integer(segment.endMs, 1, 86400000) ||
        (segment.endMs as number) <= (segment.startMs as number)))
  )
    throw new Error('Invalid recorded segment boundaries.');
  return {
    context: config.context as string,
    mode: config.mode as RecordedScenarioConfig['mode'],
    video: video
      ? { path: video.path as string, offsetMs: (video.offsetMs as number | undefined) ?? 0 }
      : null,
    audio: (config.audio as RecordedScenarioConfig['audio']).map((track) => ({
      id: track.id,
      kind: track.kind,
      path: track.path,
      label: track.label,
      enabled: track.enabled,
      offsetMs: track.offsetMs,
      embeddedTrackIndex: track.embeddedTrackIndex,
      ...(track.kind === 'device' ? { deviceId: track.deviceId ?? null } : {}),
    })),
    segment: { startMs: segment.startMs as number, endMs: segment.endMs as number | null },
    transcriptMode: config.transcriptMode as RecordedScenarioConfig['transcriptMode'],
    publishToOverlay: config.publishToOverlay as boolean,
    seed: config.seed as number | null,
    presetId: config.presetId as string | null,
    presetRevision: config.presetRevision as number | null,
    ...(config.profileId !== undefined ? { profileId: config.profileId as string | null } : {}),
    ...(config.profileRevision !== undefined
      ? { profileRevision: config.profileRevision as number | null }
      : {}),
    ...(config.profileSnapshot !== undefined ? { profileSnapshot: profileSnapshot ?? null } : {}),
    modelId: config.modelId as string | null,
    settingsSnapshot: validatePreferences(config.settingsSnapshot),
    settingsPolicy: config.settingsPolicy as RecordedScenarioConfig['settingsPolicy'],
  };
}

/** Validate every enabled source at Start, independently of Chromium's decoder readiness. */
export async function verifyRecordedSources(config: RecordedScenarioConfig): Promise<void> {
  const inputs: { label: string; path: string; kind: 'audio' | 'video' }[] = [];
  if (config.video) inputs.push({ label: 'Video', path: config.video.path, kind: 'video' });
  for (const source of config.audio) {
    if (source.enabled && source.kind === 'file')
      inputs.push({ label: source.label, path: source.path!, kind: 'audio' });
  }
  for (const input of inputs) {
    if (!supportedRecordedMediaPath(input.path, input.kind))
      throw new Error(
        `${input.label}: unsupported ${input.kind} container (${input.path}). Relink or disable this source. Chromium must also be able to decode the codec.`,
      );
    try {
      const info = await stat(input.path);
      if (!info.isFile() || info.size === 0) throw new Error('Empty or not a regular file');
      // stat can succeed even when media cannot be opened for reading.
      const handle = await open(input.path, 'r');
      await handle.close();
    } catch {
      throw new Error(
        `${input.label}: source file is missing or unreadable (${input.path}). Relink it or explicitly disable/remove the source.`,
      );
    }
  }
}

interface Data {
  version: 1;
  scenarios: RecordedScenario[];
  runs: RecordedRun[];
}

/** Metadata-only snapshots: no media copies and no implicit transcript/chat archival. */
export class RecordedScenarioStore {
  private tail: Promise<unknown> = Promise.resolve();
  private activeRunIds = new Set<string>();
  constructor(private readonly root: string) {}

  private async read(): Promise<Data> {
    let raw: string;
    try {
      raw = await readFile(path.join(this.root, FILE), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { version: 1, scenarios: [], runs: [] };
      throw error;
    }
    if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error('Scenario storage exceeds size limit.');
    const data = object(JSON.parse(raw));
    if (
      data.version !== 1 ||
      !Array.isArray(data.scenarios) ||
      !Array.isArray(data.runs) ||
      data.scenarios.length > MAX_SCENARIOS ||
      data.runs.length > MAX_RUNS
    )
      throw new Error('Invalid Scenario storage document.');
    const scenarios = data.scenarios.map((entry) => {
      const value = object(entry);
      if (
        !uuid.test(String(value.id)) ||
        !text(value.name, 80) ||
        !String(value.name).trim() ||
        typeof value.savedAt !== 'string'
      )
        throw new Error('Invalid saved Scenario metadata.');
      return {
        ...value,
        config: validateScenarioConfig(value.config),
      } as unknown as RecordedScenario;
    });
    const runs = data.runs.map((entry) => {
      const value = object(entry);
      if (
        !uuid.test(String(value.id)) ||
        !integer(value.sessionRunId, 1, Number.MAX_SAFE_INTEGER) ||
        !integer(value.cycles, 0, Number.MAX_SAFE_INTEGER) ||
        !['running', 'completed', 'stopped', 'failed', 'interrupted'].includes(
          String(value.status),
        ) ||
        typeof value.startedAt !== 'string' ||
        !integer(value.effectiveSeed, 0, 2147483647) ||
        (value.recordingIds !== undefined &&
          (!Array.isArray(value.recordingIds) ||
            value.recordingIds.length > 64 ||
            value.recordingIds.some(
              (id: unknown) =>
                typeof id !== 'string' || !/^recording-[A-Za-z0-9-]{15,110}$/.test(id),
            )))
      )
        throw new Error('Invalid saved Run metadata.');
      const prompt = object(value.effectivePrompt);
      if (
        !text(prompt.context, 2000) ||
        !['quiet', 'normal', 'busy'].includes(String(prompt.chatActivity))
      )
        throw new Error('Invalid frozen Run prompt.');
      return {
        ...value,
        ...(value.effectiveProfile !== undefined
          ? {
              effectiveProfile:
                value.effectiveProfile === null
                  ? null
                  : validateProfileSnapshot(value.effectiveProfile),
            }
          : {}),
        effective: validateScenarioConfig(value.effective),
        ...(value.appliedProfileRevisions === undefined ? {} : {
          appliedProfileRevisions: (() => {
            if (!Array.isArray(value.appliedProfileRevisions) || value.appliedProfileRevisions.length > 128)
              throw new Error('Invalid recorded Run profile revisions.');
            return value.appliedProfileRevisions.map((entry: unknown) => {
              const revision = object(entry);
              if (!integer(revision.cycle, 1, Number.MAX_SAFE_INTEGER))
                throw new Error('Invalid recorded Run profile admission.');
              return { cycle: revision.cycle as number, profile: validateProfileSnapshot(revision.profile) };
            });
          })(),
        }),
        effectiveSettings: validatePreferences(value.effectiveSettings),
      } as unknown as RecordedRun;
    });
    return { version: 1, scenarios, runs };
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  private async publish(value: Data): Promise<void> {
    const bytes = JSON.stringify(value, null, 2) + '\n';
    if (Buffer.byteLength(bytes) > MAX_BYTES)
      throw new Error('Scenario storage is full. Existing Runs will not be overwritten.');
    await mkdir(this.root, { recursive: true });
    const destination = path.join(this.root, FILE);
    const temporary = destination + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async list(): Promise<RecordedScenario[]> {
    return structuredClone((await this.read()).scenarios);
  }
  async runs(): Promise<RecordedRun[]> {
    return (await this.read()).runs.map((run) =>
      structuredClone(
        run.status === 'running' && !this.activeRunIds.has(run.id)
          ? { ...run, status: 'interrupted' as const }
          : run,
      ),
    );
  }
  /** Imported Run snapshots have new identities and cannot modify or resume existing Runs. */
  async importRun(snapshot: RecordedRun): Promise<RecordedRun> {
    return this.serialize(async () => {
      const data = await this.read();
      if (data.runs.length >= MAX_RUNS) throw new Error('Run history limit reached.');
      const run: RecordedRun = {
        ...structuredClone(snapshot),
        id: randomUUID(),
        scenarioId: null,
        status: snapshot.status === 'running' ? 'interrupted' : snapshot.status,
        effective: validateScenarioConfig(snapshot.effective),
        effectiveSettings: validatePreferences(snapshot.effectiveSettings),
      };
      data.runs.push(run);
      await this.publish(data);
      return structuredClone(run);
    });
  }

  async save(name: string, input: unknown, id?: string): Promise<RecordedScenario> {
    if (!text(name, 80) || !name.trim() || (id !== undefined && !uuid.test(id)))
      throw new Error('Scenario name must be 1–80 characters and the selected ID must be valid.');
    const config = validateScenarioConfig(input);
    return this.serialize(async () => {
      const data = await this.read();
      const index = id ? data.scenarios.findIndex((item) => item.id === id) : -1;
      if (id && index === -1) throw new Error('Scenario no longer exists.');
      if (index === -1 && data.scenarios.length >= MAX_SCENARIOS)
        throw new Error('Saved Scenario limit reached.');
      if (
        data.scenarios.some(
          (item) => item.name.toLowerCase() === name.trim().toLowerCase() && item.id !== id,
        )
      )
        throw new Error('Scenario names must be unique.');
      const scenario: RecordedScenario = {
        id: id ?? randomUUID(),
        name: name.trim(),
        savedAt: new Date().toISOString(),
        config,
      };
      if (index === -1) data.scenarios.push(scenario);
      else data.scenarios[index] = scenario;
      await this.publish(data);
      return structuredClone(scenario);
    });
  }
  async delete(id: string): Promise<void> {
    if (!uuid.test(id)) throw new Error('Invalid Scenario ID.');
    await this.serialize(async () => {
      const data = await this.read();
      if (!data.scenarios.some((item) => item.id === id)) throw new Error('Scenario not found.');
      data.scenarios = data.scenarios.filter((item) => item.id !== id);
      await this.publish(data); // Previously captured Run snapshots remain independent.
    });
  }
  async begin(
    input: Omit<RecordedRun, 'id' | 'startedAt' | 'endedAt' | 'status' | 'cycles' | 'error'>,
  ): Promise<RecordedRun> {
    return this.serialize(async () => {
      const data = await this.read();
      if (data.runs.length >= MAX_RUNS)
        throw new Error('Run history limit reached. Existing Run evidence will not be evicted.');
      const run: RecordedRun = {
        ...structuredClone(input),
        id: randomUUID(),
        startedAt: new Date().toISOString(),
        endedAt: null,
        status: 'running',
        cycles: 0,
        error: null,
      };
      data.runs.push(run);
      await this.publish(data);
      this.activeRunIds.add(run.id);
      return structuredClone(run);
    });
  }
  /** Record the exact saved profile only after its admission, not when merely queued. */
  async recordProfileAdmission(id: string, cycle: number, profile: InferenceProfile): Promise<void> {
    const snapshot = validateProfileSnapshot(profile);
    if (!uuid.test(id) || !integer(cycle, 1, Number.MAX_SAFE_INTEGER))
      throw new Error('Invalid profile admission.');
    await this.serialize(async () => {
      const data = await this.read();
      const index = data.runs.findIndex((run) => run.id === id);
      if (index < 0 || data.runs[index].status !== 'running') return;
      const prior = data.runs[index].appliedProfileRevisions ?? [];
      if (prior.length >= 128) throw new Error('Run profile revision evidence is full.');
      data.runs[index] = { ...data.runs[index],
        appliedProfileRevisions: [...prior, { cycle, profile: snapshot }] };
      await this.publish(data);
    });
  }

  async finish(
    id: string,
    status: RecordedRun['status'],
    cycles: number,
    error: string | null,
    recordingIds?: readonly string[],
  ): Promise<void> {
    if (
      !uuid.test(id) ||
      !integer(cycles, 0, Number.MAX_SAFE_INTEGER) ||
      !['completed', 'stopped', 'failed', 'interrupted'].includes(status)
    )
      throw new Error('Invalid Run completion.');
    await this.serialize(async () => {
      const data = await this.read();
      const index = data.runs.findIndex((run) => run.id === id);
      if (index < 0) throw new Error('Run not found.');
      if (data.runs[index].status !== 'running') return;
      data.runs[index] = {
        ...data.runs[index],
        status,
        cycles,
        error: error?.slice(0, 400) ?? null,
        endedAt: new Date().toISOString(),
        ...(recordingIds ? { recordingIds: [...recordingIds] } : {}),
      };
      await this.publish(data);
      this.activeRunIds.delete(id);
    });
  }
}
