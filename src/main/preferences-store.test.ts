import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PreferencesStore } from './preferences-store';
import { DEFAULT_PREFERENCES } from '../shared/session-contract';

const dirs: string[] = [];
const pace = (cycleIntervalMs: number) => ({ ...DEFAULT_PREFERENCES, cycleIntervalMs });
async function store(): Promise<{ store: PreferencesStore; directory: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), 'lonely-chat-prefs-'));
  dirs.push(directory);
  return { store: new PreferencesStore(directory), directory };
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('current-only simulation preferences', () => {
  it('starts with defaults, saves approved values, and reloads the exact current schema', async () => {
    const { store: settings, directory } = await store();
    expect(await settings.read()).toEqual(DEFAULT_PREFERENCES);
    const chosen = { ...pace(1500), videoCaptureMaxWidth: 1280, contextTokens: 42000 };
    expect(await settings.write(chosen)).toEqual(chosen);
    const data = JSON.parse(await readFile(path.join(directory, 'preferences.json'), 'utf8'));
    expect(data).toEqual({ version: 9, simulation: chosen });
    expect(await settings.read()).toEqual(chosen);
    expect(await readdir(directory)).toEqual(['preferences.json']);
    expect(JSON.stringify(data)).not.toContain('manual context');
  });

  it('serializes simultaneous saves without losing the last value', async () => {
    const { store: settings, directory } = await store();
    expect(await Promise.all([
      settings.write(pace(1500)), settings.write(pace(3000)), settings.write(pace(5000)),
    ])).toEqual([pace(1500), pace(3000), pace(5000)]);
    expect(await settings.read()).toEqual(pace(5000));
    expect(await readdir(directory)).toEqual(['preferences.json']);
  });

  it('refuses obsolete, future and incomplete preference documents instead of migrating', async () => {
    const { store: settings, directory } = await store();
    const file = path.join(directory, 'preferences.json');
    for (const document of [
      { version: 1, simulation: { cycleIntervalMs: 1500 } },
      { version: 8, simulation: DEFAULT_PREFERENCES },
      { version: 10, simulation: DEFAULT_PREFERENCES },
      { version: 9, simulation: { cycleIntervalMs: 1500 } },
      { version: 9, simulation: { ...DEFAULT_PREFERENCES, obsoleteFlag: true } },
    ]) {
      await writeFile(file, JSON.stringify(document));
      await expect(settings.read()).rejects.toThrow(/Unsupported|Incomplete|Invalid/);
    }
    await settings.write(pace(2500));
    expect(await settings.read()).toEqual(pace(2500));
  });

  it('rejects invalid numeric caps, modes and unapproved private fields', async () => {
    const { store: settings } = await store();
    const invalid = [
      { cycleIntervalMs: 100 }, { audienceCount: 0 }, { audienceCount: 1.5 },
      { chatActivity: 'extreme' }, { ramBudgetMiB: 0 }, { vramBudgetMiB: -1 },
      { gpuComputeTargetPercent: 101 }, { computeBackend: 'directx' },
      { cpuThreads: 0 }, { contextTokens: 511 }, { contextTokens: 262400 },
      { gpuOffloadLayers: -1 }, { baselineMs: 61000 }, { historyMaxCount: 300 },
      { historyMaxAgeMs: 0 }, { inferenceTimeoutMs: 9999 },
      { inferenceTimeoutMs: Number.POSITIVE_INFINITY }, { videoCaptureIntervalMs: 249 },
      { videoCaptureMaxWidth: 63 }, { videoCaptureMaxWidth: 640.5 },
      { videoCaptureMaxHeight: 1081 }, { videoCoverageMs: 61000 },
      { videoMinFrames: 0 }, { videoMaxFrames: 33 },
      { videoMinFrames: 25, videoMaxFrames: 24 }, { videoSamplingStrategy: 'random' },
      { imageMaxTokens: -1 }, { imageMaxTokens: 8193 }, { imageMaxTokens: 32.5 },
      { manualContext: 'private' },
    ];
    for (const field of invalid)
      await expect(settings.write({ ...DEFAULT_PREFERENCES, ...field })).rejects.toThrow(
        /Invalid simulation preferences/,
      );
  });
});
