import type { VideoFrame } from '../shared/video-contract';
import type { VideoSamplingStrategy } from '../shared/session-contract';

/** Replaceable temporal selection policy; always select distinct frames in capture order. */
export type VideoSampler = (
  frames: readonly VideoFrame[],
  count: number,
  fromMs: number,
  throughMs: number,
) => readonly VideoFrame[];

/** Prefer the closest available image to each time target rather than to an array index. */
function selectTimeline(
  frames: readonly VideoFrame[],
  count: number,
  fromMs: number,
  throughMs: number,
  weighting: (fraction: number) => number,
): VideoFrame[] {
  if (count <= 0 || frames.length === 0) return [];
  if (count === 1) return [frames[frames.length - 1]];
  if (frames.length <= count) return [...frames];
  const selected: VideoFrame[] = [];
  let first = 0;
  for (let index = 0; index < count; index++) {
    // Leave at least one unique frame per remaining target, including the final frame.
    const last = frames.length - (count - index);
    const target = fromMs + (throughMs - fromMs) * weighting(index / (count - 1));
    let best = first;
    for (let candidate = first + 1; candidate <= last; candidate++) {
      if (
        Math.abs(frames[candidate].observedAt - target) < Math.abs(frames[best].observedAt - target)
      )
        best = candidate;
    }
    selected.push(frames[best]);
    first = best + 1;
  }
  return selected;
}

export const VIDEO_SAMPLERS: Record<VideoSamplingStrategy, VideoSampler> = {
  uniform: (frames, count, fromMs, throughMs) =>
    selectTimeline(frames, count, fromMs, throughMs, (fraction) => fraction),
  'recent-weighted': (frames, count, fromMs, throughMs) =>
    selectTimeline(frames, count, fromMs, throughMs, Math.sqrt),
};
