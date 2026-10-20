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
    expect(data).toEqual({ version: 9, simulation: pace(1500) });
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
    ).toBe(9);
  });

  it('migrates existing version-two preferences with reasoning disabled by default', async () => {
    const { store: settings, directory } = await store();
    const {
      ramBudgetMiB: _ram,
      vramBudgetMiB: _vram,
      gpuComputeTargetPercent: _compute,
      computeBackend: _backend,
      cpuThreads: _threads,
      contextTokens: _context,
      imageMaxTokens: _imageTokens,
      videoCaptureMaxWidth: _width,
      videoCaptureMaxHeight: _height,
      gpuOffloadLayers: _layers,
      audienceCount: _audience,
      chatActivity: _activity,
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
      ramBudgetMiB: _ram,
      vramBudgetMiB: _vram,
      gpuComputeTargetPercent: _compute,
      computeBackend: _backend,
      cpuThreads: _threads,
      contextTokens: _context,
      imageMaxTokens: _imageTokens,
      videoCaptureMaxWidth: _width,
      videoCaptureMaxHeight: _height,
      gpuOffloadLayers: _layers,
      audienceCount: _audience,
      chatActivity: _activity,
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
      ramBudgetMiB: _ram,
      vramBudgetMiB: _vram,
      gpuComputeTargetPercent: _compute,
      computeBackend: _backend,
      cpuThreads: _threads,
      contextTokens: _context,
      imageMaxTokens: _imageTokens,
      videoCaptureMaxWidth: _width,
      videoCaptureMaxHeight: _height,
      gpuOffloadLayers: _layers,
      audienceCount: _audience,
      chatActivity: _activity,
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

  it('upgrades v5 video settings with new audience defaults', async () => {
    const { store: settings, directory } = await store();
    const {
      audienceCount: _size,
      chatActivity: _activity,
      ramBudgetMiB: _ram,
      vramBudgetMiB: _vram,
      gpuComputeTargetPercent: _compute,
      computeBackend: _backend,
      cpuThreads: _threads,
      contextTokens: _context,
      imageMaxTokens: _imageTokens,
      videoCaptureMaxWidth: _width,
      videoCaptureMaxHeight: _height,
      gpuOffloadLayers: _layers,
      ...previous
    } = pace(3500);
    await writeFile(
      path.join(directory, 'preferences.json'),
      JSON.stringify({ version: 5, simulation: previous }),
    );
    expect(await settings.read()).toEqual({ ...DEFAULT_PREFERENCES, ...previous });
  });

  it('upgrades v6 audience settings and persists resource targets in v7', async () => {
    const { store: settings, directory } = await store();
    const {
      ramBudgetMiB: _ram,
      vramBudgetMiB: _vram,
      gpuComputeTargetPercent: _compute,
      computeBackend: _backend,
      cpuThreads: _threads,
      contextTokens: _context,
      imageMaxTokens: _imageTokens,
      videoCaptureMaxWidth: _width,
      videoCaptureMaxHeight: _height,
      gpuOffloadLayers: _layers,
      ...previous
    } = pace(4800);
    await writeFile(
      path.join(directory, 'preferences.json'),
      JSON.stringify({ version: 6, simulation: previous }),
    );
    expect(await settings.read()).toEqual({ ...DEFAULT_PREFERENCES, ...previous });
    const customized = {
      ...pace(4800),
      ramBudgetMiB: 8192,
      vramBudgetMiB: 4096,
      gpuComputeTargetPercent: 40,
      computeBackend: 'vulkan' as const,
      cpuThreads: 8,
      contextTokens: 8192,
      gpuOffloadLayers: 16,
    };
    await settings.write(customized);
    expect(await settings.read()).toEqual(customized);
  });

  it('upgrades v7 settings without a visual budget to the safe model default', async () => {
    const { store: settings, directory } = await store();
    const {
      imageMaxTokens: _newField,
      videoCaptureMaxWidth: _width,
      videoCaptureMaxHeight: _height,
      ...prior
    } = DEFAULT_PREFERENCES;
    await writeFile(
      path.join(directory, 'preferences.json'),
      JSON.stringify({ version: 7, simulation: prior }),
    );
    expect(await settings.read()).toEqual(DEFAULT_PREFERENCES);
    await settings.write({ ...DEFAULT_PREFERENCES, imageMaxTokens: 128 });
    expect(await settings.read()).toMatchObject({ imageMaxTokens: 128 });
  });

  it('upgrades v8 preferences with 320×180 capture defaults and persists custom resolution', async () => {
    const { store: settings, directory } = await store();
    const {
      videoCaptureMaxWidth: _width,
      videoCaptureMaxHeight: _height,
      ...prior
    } = { ...DEFAULT_PREFERENCES, contextTokens: 42000, imageMaxTokens: 333 };
    await writeFile(
      path.join(directory, 'preferences.json'),
      JSON.stringify({
        version: 8,
        simulation: prior,
      }),
    );
    expect(await settings.read()).toMatchObject({
      videoCaptureMaxWidth: 320,
      videoCaptureMaxHeight: 180,
      contextTokens: 42000,
      imageMaxTokens: 333,
    });
    const customized = {
      ...(await settings.read()),
      videoCaptureMaxWidth: 1280,
      videoCaptureMaxHeight: 720,
    };
    expect(await settings.write(customized)).toEqual(customized);
    expect(await settings.read()).toEqual(customized);
  });

  it('persists the shared visual token budget and rejects invalid caps', async () => {
    const { store: settings } = await store();
    await settings.write({ ...DEFAULT_PREFERENCES, imageMaxTokens: 128 });
    expect((await settings.read()).imageMaxTokens).toBe(128);
    await settings.write({ ...DEFAULT_PREFERENCES, imageMaxTokens: 0 });
    expect((await settings.read()).imageMaxTokens).toBe(0);
    await settings.write({ ...DEFAULT_PREFERENCES, imageMaxTokens: 333 });
    expect((await settings.read()).imageMaxTokens).toBe(333);
    for (const imageMaxTokens of [-1, 8193, 32.5])
      await expect(settings.write({ ...DEFAULT_PREFERENCES, imageMaxTokens })).rejects.toThrow();
  });

  it('persists long-context sizes for native multimodal models', async () => {
    const { store: settings } = await store();
    await settings.write({ ...DEFAULT_PREFERENCES, contextTokens: 42000 });
    expect((await settings.read()).contextTokens).toBe(42000);
    await settings.write({ ...DEFAULT_PREFERENCES, contextTokens: 65536 });
    expect((await settings.read()).contextTokens).toBe(65536);
    await settings.write({ ...DEFAULT_PREFERENCES, contextTokens: 262144 });
    expect((await settings.read()).contextTokens).toBe(262144);
    await expect(
      settings.write({ ...DEFAULT_PREFERENCES, contextTokens: 262400 }),
    ).rejects.toThrow();
  });

  it('rejects out-of-range, fractional-count and malformed preferences', async () => {
    const { store: settings } = await store();
    for (const bad of [
      { cycleIntervalMs: 100 },
      { cycleIntervalMs: -1 },
      { audienceCount: 0 },
      { audienceCount: 101 },
      { audienceCount: 1.5 },
      { chatActivity: 'extreme' },
      { ramBudgetMiB: 0 },
      { ramBudgetMiB: 102.5 },
      { vramBudgetMiB: -1 },
      { gpuComputeTargetPercent: 101 },
      { gpuComputeTargetPercent: 40.5 },
      { computeBackend: 'directx' },
      { cpuThreads: 0 },
      { contextTokens: 511 },
      { contextTokens: 512.5 },
      { gpuOffloadLayers: -1 },
      { baselineMs: 61000 },
      { historyMaxCount: 1.5 },
      { historyMaxCount: 300 },
      { historyMaxAgeMs: 0 },
      { inferenceTimeoutMs: 9999 },
      { inferenceTimeoutMs: 3601000 },
      { inferenceTimeoutMs: 12345 },
      { inferenceTimeoutMs: Number.POSITIVE_INFINITY },
      { videoCaptureIntervalMs: 249 },
      { videoCaptureMaxWidth: 63 },
      { videoCaptureMaxWidth: 1921 },
      { videoCaptureMaxHeight: 63 },
      { videoCaptureMaxHeight: 1081 },
      { videoCaptureMaxWidth: 640.5 },
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
        version: 10,
        simulation: { cycleIntervalMs: 3000 },
      }),
    );
    await expect(settings.read()).rejects.toThrow(/Unsupported/);
  });
});
