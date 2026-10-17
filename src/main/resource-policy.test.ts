import { describe, expect, it } from 'vitest';
import { chooseBackend, chooseWorkload, parseBackendDevices } from './resource-policy';
import { DEFAULT_PREFERENCES } from '../shared/session-contract';

describe('advisory resource policy', () => {
  it('keeps the full sampling schedule when runtime metrics are unavailable and targets disabled', () => {
    expect(chooseWorkload(DEFAULT_PREFERENCES, 30000, null)).toEqual({
      frameLimit: 24,
      minimumIntervalMs: 3000,
      reason: null,
    });
    expect(
      chooseWorkload(DEFAULT_PREFERENCES, 30000, {
        ramUsedMiB: null,
        vramUsedMiB: null,
        gpuComputePercent: null,
      }).frameLimit,
    ).toBe(24);
  });

  it('responds to synthetic pressure without dropping below useful minimum frames', () => {
    const settings = { ...DEFAULT_PREFERENCES, videoMinFrames: 3, gpuComputeTargetPercent: 40 };
    const pressured = chooseWorkload(settings, 7000, {
      ramUsedMiB: 4000,
      vramUsedMiB: null,
      gpuComputePercent: null,
    });
    expect(pressured.frameLimit).toBeGreaterThanOrEqual(3);
    expect(pressured.frameLimit).toBeLessThan(24);
    expect(pressured.minimumIntervalMs).toBe(8400);
    expect(pressured.reason).toContain('Worker RAM');
    expect(pressured.reason).toContain('GPU-compute preference');
    const noMemory = chooseWorkload(settings, 1000, null);
    expect(noMemory.frameLimit).toBe(9);
    expect(noMemory.minimumIntervalMs).toBe(3000);
    expect(
      chooseWorkload({ ...settings, videoMaxFrames: 3 }, 7000, {
        ramUsedMiB: 999999,
        vramUsedMiB: null,
        gpuComputePercent: null,
      }).frameLimit,
    ).toBe(3);
  });

  it('reduces work when observed GPU activity or VRAM approach targets; ignores bogus metrics', () => {
    const settings = { ...DEFAULT_PREFERENCES, vramBudgetMiB: 8192, gpuComputeTargetPercent: 60 };
    expect(
      chooseWorkload(settings, null, {
        ramUsedMiB: null,
        vramUsedMiB: 8000,
        gpuComputePercent: 59,
      }).reason,
    ).toContain('VRAM');
    expect(
      chooseWorkload(DEFAULT_PREFERENCES, null, {
        ramUsedMiB: Number.NaN,
        vramUsedMiB: 9999,
        gpuComputePercent: 100,
      }).reason,
    ).toBeNull();
  });

  it('detects only enumerated GPU devices and falls back to CPU explicitly', () => {
    expect(parseBackendDevices('Available devices:\n  (none)')).toEqual([]);
    expect(
      parseBackendDevices(
        'ggml_cuda_init: failed to find devices\nllama_backend_cuda: unavailable',
      ),
    ).toEqual([]);
    const devices = parseBackendDevices(
      'Available devices:\n  CUDA0: NVIDIA RTX\n  Vulkan0: Intel GPU\n  Metal0: Apple M4\n',
    );
    expect(devices.map((item) => item.backend)).toEqual(['cuda', 'vulkan', 'metal']);
    expect(chooseBackend('cuda', devices)).toMatchObject({
      selected: 'cuda',
      device: 'CUDA0',
      warning: null,
    });
    expect(chooseBackend('auto', devices).selected).toBe('cuda');
    expect(chooseBackend('metal', [])).toMatchObject({
      selected: 'cpu',
      available: ['cpu'],
    });
    expect(chooseBackend('metal', []).warning).toMatch(/not available.*using CPU/);
    expect(chooseBackend('cpu', devices).selected).toBe('cpu');
    expect(chooseBackend('vulkan', [{ name: 'CUDA0', backend: 'cuda' }]).warning).toMatch(/VULKAN/);
  });
});
