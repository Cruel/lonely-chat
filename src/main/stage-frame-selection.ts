import type { VideoFrame } from '../shared/video-contract';
import type { InferenceStageDefaults } from '../shared/inference-profile-contract';

/** Select already captured source frames; never fabricate resolution by upscaling. */
export function selectStageFrames(
  source: readonly VideoFrame[],
  throughMs: number,
  policy: InferenceStageDefaults['frameSampling'] | undefined,
  cap: number,
): VideoFrame[] {
  if (cap <= 0) return [];
  const windowMs = policy?.windowMs ?? 30000;
  const eligible = source.filter(
    (frame) =>
      frame.observedAt <= throughMs &&
      frame.observedAt >= throughMs - windowMs &&
      (!policy || (frame.width >= policy.maxWidth && frame.height >= policy.maxHeight)),
  );
  const count = Math.min(eligible.length, cap, policy?.maxFrames ?? cap);
  if (!count) return [];
  const sorted = [...eligible].sort((a, b) => a.observedAt - b.observedAt);
  if (policy?.strategy === 'latest') return sorted.slice(-count);
  if (count === 1) return [sorted.at(-1)!];
  return Array.from(
    { length: count },
    (_, i) => sorted[Math.round((i * (sorted.length - 1)) / (count - 1))],
  );
}
