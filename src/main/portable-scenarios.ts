import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  RecordedRun,
  RecordedScenario,
  RecordedScenarioConfig,
} from '../shared/recorded-scenario-contract';
import { validatePreferences } from '../shared/session-contract';
import { supportedRecordedMediaPath } from './recorded-media-access';
import { makeArchive, openArchive } from './portable-archive';
import { RecordedScenarioStore, validateScenarioConfig } from './recorded-scenarios';

const MAX_SOURCE = 128 * 1024 * 1024;
type Source = { key: string; filename: string; entry: string | null; kind: 'video' | 'audio' };
type PortableConfig = { config: RecordedScenarioConfig; sources: Source[] };
type MutableConfig = { -readonly [K in keyof RecordedScenarioConfig]: RecordedScenarioConfig[K] };

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid portable Scenario metadata.');
  return value as Record<string, unknown>;
}
function safeFilename(file: string): string {
  const base = path.basename(file);
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._ ()-]{0,149}$/.test(base) ||
    base === '.' ||
    base === '..' ||
    base.includes('..')
  )
    return 'source' + path.extname(base).replace(/[^a-zA-Z0-9.]/g, '');
  return base;
}

/** Never serialize source directory locations, even when media is not included. */
export function portableConfig(config: RecordedScenarioConfig): PortableConfig {
  const snapshot: MutableConfig = structuredClone(config);
  const sources: Source[] = [];
  if (snapshot.video) {
    sources.push({
      key: 'video',
      filename: safeFilename(snapshot.video.path),
      entry: null,
      kind: 'video',
    });
    snapshot.video = { path: 'portable-source:video' };
  }
  snapshot.audio = snapshot.audio.map((track, index) => {
    if (track.kind !== 'file' || !track.path) return track;
    const key = 'audio-' + index;
    sources.push({ key, filename: safeFilename(track.path), entry: null, kind: 'audio' });
    return { ...track, path: 'portable-source:' + key };
  });
  return { config: snapshot, sources };
}

export async function packageScenario(
  scenario: RecordedScenario,
  includeMedia: boolean,
): Promise<string> {
  const { config, sources } = portableConfig(scenario.config);
  const files = new Map<string, Buffer>();
  if (includeMedia) {
    for (const source of sources) {
      const original =
        source.key === 'video'
          ? scenario.config.video!.path
          : scenario.config.audio[Number(source.key.slice(6))].path!;
      if (!supportedRecordedMediaPath(original, source.kind))
        throw new Error('Unsupported original media format: ' + source.filename);
      const details = await stat(original);
      if (!details.isFile() || details.size === 0 || details.size > MAX_SOURCE)
        throw new Error(
          'Media source is empty or exceeds portable archive size limit: ' + source.filename,
        );
      const entry = 'media/' + String(sources.indexOf(source) + 1).padStart(3, '0');
      files.set(entry, await readFile(original));
      source.entry = entry;
    }
  }
  return makeArchive('scenario', { name: scenario.name, config, sources }, files);
}

export function parsePortableConfig(value: unknown): PortableConfig {
  const portable = object(value);
  const config = structuredClone(object(portable.config)) as unknown as MutableConfig;
  if (!Array.isArray(portable.sources) || portable.sources.length > 33)
    throw new Error('Invalid portable source list.');
  const sources = portable.sources.map((item) => {
    const source = object(item);
    if (
      typeof source.key !== 'string' ||
      !/^(video|audio-(?:0|[1-9][0-9]{0,2}))$/.test(source.key) ||
      typeof source.filename !== 'string' ||
      safeFilename(source.filename) !== source.filename ||
      !['video', 'audio'].includes(String(source.kind)) ||
      (source.entry !== null &&
        (typeof source.entry !== 'string' || !/^media\/\d{3}$/.test(source.entry)))
    )
      throw new Error('Unsafe or invalid portable source reference.');
    return source as Source;
  });
  if (
    new Set(sources.map((source) => source.key)).size !== sources.length ||
    new Set(sources.map((source) => source.entry).filter(Boolean)).size !==
      sources.filter((source) => source.entry).length
  )
    throw new Error('Duplicate portable source reference.');
  if (config.video) {
    if (
      !sources.some((source) => source.key === 'video' && source.kind === 'video') ||
      config.video.path !== 'portable-source:video'
    )
      throw new Error('Invalid portable video reference.');
  } else if (sources.some((source) => source.key === 'video')) {
    throw new Error('Unreferenced portable video source.');
  }
  for (const [index, track] of config.audio.entries()) {
    if (track.kind !== 'file') continue;
    if (
      !sources.some((source) => source.key === 'audio-' + index && source.kind === 'audio') ||
      track.path !== 'portable-source:audio-' + index
    )
      throw new Error('Invalid portable audio reference.');
  }
  if (
    sources.length !==
    (config.video ? 1 : 0) + config.audio.filter((track) => track.kind === 'file').length
  )
    throw new Error('Unreferenced portable source.');
  return { config, sources };
}

export async function restorePortableConfig(
  value: unknown,
  files: Map<string, Buffer>,
  root: string,
): Promise<{ config: RecordedScenarioConfig; missing: string[]; directory: string }> {
  const parsed = parsePortableConfig(value);
  const config = structuredClone(parsed.config) as MutableConfig;
  const sources = parsed.sources;
  const expected = new Set(sources.flatMap((source) => (source.entry ? [source.entry] : [])));
  if ([...files.keys()].some((key) => !expected.has(key)) || expected.size !== files.size)
    throw new Error('Unexpected or missing portable media entry.');
  const directory = path.join(root, 'portable-media', randomUUID());
  const missing: string[] = [];
  // Each archive gets its own private folder; paths are generated, never extracted from the package.
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    for (const [index, source] of sources.entries()) {
      const target = path.join(
        directory,
        String(index + 1).padStart(3, '0') + '-' + source.filename,
      );
      if (!supportedRecordedMediaPath(target, source.kind))
        throw new Error('Unsupported portable media type: ' + source.filename);
      if (source.entry) {
        const bytes = files.get(source.entry);
        if (!bytes || bytes.length === 0 || bytes.length > MAX_SOURCE)
          throw new Error('Portable media is missing or oversized.');
        await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
      } else {
        missing.push(source.filename);
      }
      if (source.key === 'video') config.video = { path: target };
      else
        config.audio = config.audio.map((track, trackIndex) =>
          source.key === 'audio-' + trackIndex ? { ...track, path: target } : track,
        );
    }
    return {
      config: validateScenarioConfig({ ...config, publishToOverlay: false }),
      missing,
      directory,
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function importScenario(
  raw: string,
  store: RecordedScenarioStore,
  root: string,
): Promise<{ scenario: RecordedScenario; missing: string[] }> {
  const { metadata, files } = openArchive(raw, 'scenario');
  const value = object(metadata);
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 80)
    throw new Error('Invalid portable Scenario name.');
  const restored = await restorePortableConfig(value, files, root);
  try {
    const existing = await store.list();
    const names = new Set(existing.map((item) => item.name.toLowerCase()));
    let name = value.name;
    let suffix = 2;
    while (names.has(name.toLowerCase()))
      name = value.name.slice(0, 65) + ' (import ' + suffix++ + ')';
    const scenario = await store.save(name, restored.config);
    return { scenario, missing: restored.missing };
  } catch (error) {
    await rm(restored.directory, { recursive: true, force: true });
    throw error;
  }
}

export function portableRun(run: RecordedRun): unknown {
  const { recordingIds: _localRecordingIds, ...snapshot } = run;
  return { ...snapshot, scenarioId: null, effective: portableConfig(run.effective) };
}

export async function restoreRun(
  value: unknown,
  root: string,
): Promise<{ run: RecordedRun; directory: string }> {
  const snapshot = object(value);
  if (
    typeof snapshot.name !== 'string' ||
    snapshot.name.length > 80 ||
    typeof snapshot.startedAt !== 'string' ||
    !Number.isSafeInteger(snapshot.sessionRunId) ||
    (snapshot.sessionRunId as number) < 1 ||
    !Number.isSafeInteger(snapshot.cycles) ||
    (snapshot.cycles as number) < 0 ||
    !Number.isSafeInteger(snapshot.effectiveSeed) ||
    (snapshot.effectiveSeed as number) < 0 ||
    (snapshot.effectiveSeed as number) > 2147483647 ||
    !['running', 'completed', 'stopped', 'failed', 'interrupted'].includes(
      String(snapshot.status),
    ) ||
    (snapshot.endedAt !== null && typeof snapshot.endedAt !== 'string') ||
    (snapshot.error !== null &&
      (typeof snapshot.error !== 'string' || snapshot.error.length > 400)) ||
    (snapshot.effectiveModelId !== null && typeof snapshot.effectiveModelId !== 'string')
  )
    throw new Error('Invalid portable Run snapshot.');
  const settings = validatePreferences(snapshot.effectiveSettings);
  const prompt = object(snapshot.effectivePrompt);
  if (
    typeof prompt.context !== 'string' ||
    prompt.context.length > 2000 ||
    !['quiet', 'normal', 'busy'].includes(String(prompt.chatActivity))
  )
    throw new Error('Invalid portable Run prompt.');
  const restored = await restorePortableConfig(snapshot.effective, new Map(), root);
  return {
    run: {
      ...snapshot,
      effective: restored.config,
      effectiveSettings: settings,
      scenarioId: null,
    } as unknown as RecordedRun,
    directory: restored.directory,
  };
}
