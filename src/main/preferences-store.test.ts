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
  await Promise.all(
    dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('versioned preferences', () => {
  it('starts with defaults, saves only approved preferences, and reloads them', async () => {
    const { store: settings, directory } = await store();
    expect(await settings.read()).toEqual(DEFAULT_PREFERENCES);
    expect(await settings.write(pace(1500))).toEqual(pace(1500));
    const data = JSON.parse(await readFile(path.join(directory, 'preferences.json'), 'utf8'));
    expect(data).toEqual({ version: 5, simulation: pace(1500) });
    expect(await settings.read()).toEqual(pace(1500));
    expect(await readdir(directory)).toEqual(['preferences.json']);
    expect(JSON.stringify(data)).not.toContain('manual context');
  });

  it('serializes concurrent preference saves without colliding or losing the final value', async () => {
    const { store: settings, directory } = await store();
    const values = await Promise.all([
      settings.write(pace(1500)),
      settings.write(pace(3000)),
      settings.write(pace(5000)),
    ]);
    expect(values).toEqual([pace(1500), pace(3000), pace(5000)]);
    expect(await settings.read()).toEqual(pace(5000));
    expect(await readdir(directory)).toEqual(['preferences.json']);
  });

  it('migrates version-one cycle-only preferences to the expanded settings', async () => {
    const { store: settings, directory } = await store();
    await writeFile(
      path.join(directory, 'preferences.json'),
      JSON.stringify({
        version: 1,
        simulation: { cycleIntervalMs: 1500 },
      }),
    );
    expect(await settings.read()).toEqual(pace(1500));
    expect(
      await settings.write({
        ...pace(1500),
        baselineMs: 1000,
        historyMaxCount: 16,
        historyMaxAgeMs: 30000,
      }),
    ).toMatchObject({ baselineMs: 1000, historyMaxCount: 16, historyMaxAgeMs: 30000 });
    expect(
      JSON.parse(await readFile(path.join(directory, 'preferences.json'), 'utf8')).version,
    ).toBe(5);
  });

  it('migrates existing version-two preferences with reasoning disabled by default', async () => {
    const { store: settings, directory } = await store();
    const {
      reasoningEnabled: _ignoredReasoning,
      inferenceTimeoutMs: _ignoredTimeout,
      videoCaptureIntervalMs: _capture,
      videoCoverageMs: _coverage,
      videoMinFrames: _min,
      videoMaxFrames: _max,
      videoSamplingStrategy: _strategy,
      ...previous
    } = pace(5000);
    await writeFile(
      path.join(directory, 'preferences.json'),
      JSON.stringify({ version: 2, simulation: previous }),
    );
    expect(await settings.read()).toEqual(pace(5000));
    expect(await settings.write({ ...pace(5000), reasoningEnabled: true })).toMatchObject({
      reasoningEnabled: true,
    });
    expect(await settings.read()).toMatchObject({ reasoningEnabled: true });
  });

  it('migrates version-three settings and retains custom values', async () => {
    const { store: settings, directory } = await store();
    const {
      inferenceTimeoutMs: _ignoredTimeout,
      videoCaptureIntervalMs: _capture,
      videoCoverageMs: _coverage,
      videoMinFrames: _min,
      videoMaxFrames: _max,
      videoSamplingStrategy: _strategy,
      ...previous
    } = pace(7500);
    await writeFile(
      path.join(directory, 'preferences.json'),
      JSON.stringify({
        version: 3,
        simulation: { ...previous, reasoningEnabled: true, historyMaxCount: 45 },
      }),
    );
    expect(await settings.read()).toEqual({
      ...pace(7500),
      reasoningEnabled: true,
      historyMaxCount: 45,
    });
    const custom = {
      ...pace(2700),
      baselineMs: 2300,
      historyMaxCount: 45,
      historyMaxAgeMs: 90000,
      inferenceTimeoutMs: 180000,
    };
    expect(await settings.write(custom)).toEqual(custom);
    expect(await settings.read()).toEqual(custom);
  });

  it('upgrades v4 video defaults without changing existing inference settings', async () => {
    const { store: settings, directory } = await store();
    const {
      videoCaptureIntervalMs: _capture,
      videoCoverageMs: _coverage,
      videoMinFrames: _min,
      videoMaxFrames: _max,
      videoSamplingStrategy: _strategy,
      ...previous
    } = { ...pace(4800), inferenceTimeoutMs: 180000, reasoningEnabled: true };
    await writeFile(
      path.join(directory, 'preferences.json'),
      JSON.stringify({ version: 4, simulation: previous }),
    );
    expect(await settings.read()).toEqual({
      ...DEFAULT_PREFERENCES,
      ...previous,
    });
    const updated = {
      ...(await settings.read()),
      videoCaptureIntervalMs: 250,
      videoCoverageMs: 30000,
      videoMinFrames: 4,
      videoMaxFrames: 16,
      videoSamplingStrategy: 'recent-weighted' as const,
    };
    await settings.write(updated);
    expect(await settings.read()).toEqual(updated);
  });

  it('rejects out-of-range, fractional-count and malformed preferences', async () => {
    const { store: settings } = await store();
    for (const bad of [
      { cycleIntervalMs: 100 },
      { cycleIntervalMs: -1 },
      { baselineMs: 61000 },
      { historyMaxCount: 1.5 },
      { historyMaxCount: 300 },
      { historyMaxAgeMs: 0 },
      { inferenceTimeoutMs: 9999 },
      { inferenceTimeoutMs: 3601000 },
      { inferenceTimeoutMs: 12345 },
      { inferenceTimeoutMs: Number.POSITIVE_INFINITY },
      { videoCaptureIntervalMs: 249 },
      { videoCaptureIntervalMs: 525 },
      { videoCaptureIntervalMs: 5050 },
      { videoCoverageMs: 61000 },
      { videoMinFrames: 0 },
      { videoMaxFrames: 33 },
      { videoMinFrames: 25, videoMaxFrames: 24 },
      { videoSamplingStrategy: 'random' },
    ]) {
      await expect(settings.write({ ...DEFAULT_PREFERENCES, ...bad })).rejects.toThrow(
        /Invalid simulation preferences/,
      );
    }
  });

  it('refuses unexpected keys or future versions without overwriting existing values', async () => {
    const { store: settings, directory } = await store();
    await settings.write(pace(3000));
    await expect(settings.write({ ...pace(3000), manualContext: 'private' })).rejects.toThrow();
    expect(await settings.read()).toEqual(pace(3000));
    await writeFile(
      path.join(directory, 'preferences.json'),
      JSON.stringify({
        version: 6,
        simulation: { cycleIntervalMs: 3000 },
      }),
    );
    await expect(settings.read()).rejects.toThrow(/Unsupported/);
  });
});
