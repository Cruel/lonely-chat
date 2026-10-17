import type { ComputeBackend, SessionPreferences } from '../shared/session-contract';

export interface ResourceMeasurements {
  /** Resident memory of the llama.cpp worker, where the platform exposes it. */
  readonly ramUsedMiB: number | null;
  readonly vramUsedMiB: number | null;
  readonly gpuComputePercent: number | null;
}

export interface WorkloadDecision {
  readonly frameLimit: number;
  readonly minimumIntervalMs: number;
  readonly reason: string | null;
}

/**
 * Advisory policy only: sampling fewer frames and spacing requests cannot impose hard
 * GPU-utilization or memory limits. Missing OS metrics never block inference.
 */
export function chooseWorkload(
  settings: Pick<
    SessionPreferences,
    | 'videoMinFrames'
    | 'videoMaxFrames'
    | 'cycleIntervalMs'
    | 'ramBudgetMiB'
    | 'vramBudgetMiB'
    | 'gpuComputeTargetPercent'
  >,
  estimatedMs: number | null,
  observed: ResourceMeasurements | null,
): WorkloadDecision {
  let fraction = 1;
  const reasons: string[] = [];
  const pressure = (used: number | null | undefined, budget: number, label: string) => {
    if (used === null || used === undefined || !Number.isFinite(used) || budget <= 0) return;
    const ratio = used / budget;
    if (ratio >= 0.85) {
      fraction = Math.min(fraction, ratio >= 1 ? 0.35 : 0.6);
      reasons.push(`${label} is approaching its best-effort target`);
    }
  };
  pressure(observed?.ramUsedMiB, settings.ramBudgetMiB, 'Worker RAM');
  pressure(observed?.vramUsedMiB, settings.vramBudgetMiB, 'VRAM');
  pressure(observed?.gpuComputePercent, settings.gpuComputeTargetPercent, 'GPU activity');

  if (settings.gpuComputeTargetPercent > 0 && settings.gpuComputeTargetPercent < 100) {
    fraction = Math.min(fraction, Math.max(0.25, settings.gpuComputeTargetPercent / 100));
    reasons.push('GPU-compute preference reduces visual work, not hardware utilization');
  }
  const adaptiveTargetActive = reasons.length > 0;
  if (
    adaptiveTargetActive &&
    estimatedMs !== null &&
    Number.isFinite(estimatedMs) &&
    estimatedMs > settings.cycleIntervalMs * 0.85
  ) {
    fraction = Math.min(fraction, estimatedMs >= settings.cycleIntervalMs ? 0.5 : 0.75);
    reasons.push('Inference duration is approaching the configured interval');
  }
  const frameLimit = Math.max(
    settings.videoMinFrames,
    Math.min(settings.videoMaxFrames, Math.floor(settings.videoMaxFrames * fraction)),
  );
  const minimumIntervalMs = Math.max(
    settings.cycleIntervalMs,
    adaptiveTargetActive &&
      estimatedMs !== null &&
      Number.isFinite(estimatedMs) &&
      estimatedMs > settings.cycleIntervalMs
      ? Math.ceil(estimatedMs * 1.2)
      : settings.cycleIntervalMs,
  );
  return { frameLimit, minimumIntervalMs, reason: reasons.length ? reasons.join('; ') : null };
}

/** Only probed runtime devices, never the host OS alone, establish GPU availability. */
export interface BackendDevice {
  readonly name: string;
  readonly backend: Exclude<ComputeBackend, 'auto'>;
}

export interface BackendDecision {
  readonly selected: Exclude<ComputeBackend, 'auto'>;
  readonly device: string | null;
  readonly available: readonly Exclude<ComputeBackend, 'auto'>[];
  readonly warning: string | null;
}

export function chooseBackend(
  requested: ComputeBackend,
  devices: readonly BackendDevice[],
): BackendDecision {
  const available = [...new Set(['cpu' as const, ...devices.map((device) => device.backend)])];
  const gpu = devices.find((device) => device.backend !== 'cpu');
  const selected =
    requested === 'auto'
      ? (gpu?.backend ?? 'cpu')
      : available.includes(requested)
        ? requested
        : 'cpu';
  const device = devices.find((item) => item.backend === selected)?.name ?? null;
  return {
    selected,
    device,
    available,
    warning:
      requested !== 'auto' && requested !== 'cpu' && selected === 'cpu'
        ? `${requested.toUpperCase()} is not available in this installed llama.cpp build; using CPU. Install a verified GPU-capable backend to enable it.`
        : null,
  };
}

export function parseBackendDevices(output: string): BackendDevice[] {
  const lines = output.split(/\r?\n/);
  const devices: BackendDevice[] = [];
  for (const line of lines) {
    // Do not mistake diagnostic lines such as ggml_cuda_init: for physical devices.
    const match = /^\s*((?:CUDA|Vulkan|Metal)\d+):\s+(.+)$/i.exec(line);
    if (!match) continue;
    const name = match[1];
    const description = `${name} ${match[2]}`.toLowerCase();
    const backend = /cuda/.test(description)
      ? 'cuda'
      : /vulkan|ggml_vk/.test(description)
        ? 'vulkan'
        : /metal/.test(description)
          ? 'metal'
          : null;
    if (backend) devices.push({ name, backend });
  }
  return devices;
}
