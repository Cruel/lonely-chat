import type { VideoFrame } from '../shared/video-contract';

/**
 * A native-video encoder receives only a bounded, single-source set of JPEGs.
 * Frames retain captured observation timestamps and recorded media positions.
 * The encoder is responsible for resampling to its output clock; it must never
 * treat wall-clock gaps (including a paused recording) as unbounded footage.
 */
export interface ContinuousVideoWindow {
  readonly sourceId: string;
  readonly fromMs: number;
  readonly throughMs: number;
  readonly frames: readonly VideoFrame[];
  readonly timeline: readonly {
    readonly observedAt: number;
    readonly mediaTimeMs?: number;
    readonly outputOffsetMs: number;
  }[];
}

/**
 * Choose a native clip from a cycle or stage's already-authorized frame window.
 * Mixed camera identities, invalid timestamps and gaps across a recorded seek
 * are rejected rather than silently concatenated into misleading footage.
 */
export function selectContinuousVideoWindow(
  frames: readonly VideoFrame[],
  fromMs: number,
  throughMs: number,
  maxDurationMs = 15_000,
  maxFrames = 32,
): ContinuousVideoWindow | null {
  if (
    !Number.isFinite(fromMs) ||
    !Number.isFinite(throughMs) ||
    throughMs < fromMs ||
    !Number.isSafeInteger(maxDurationMs) ||
    maxDurationMs < 250 ||
    maxDurationMs > 60_000 ||
    !Number.isSafeInteger(maxFrames) ||
    maxFrames < 1 ||
    maxFrames > 32
  )
    throw new Error('Invalid native-video window limits.');
  const start = Math.max(fromMs, throughMs - maxDurationMs);
  const selected = frames
    .filter((frame) => frame.observedAt >= start && frame.observedAt <= throughMs)
    .sort((a, b) => a.observedAt - b.observedAt);
  if (!selected.length) return null;
  if (selected.length > maxFrames) throw new Error('Native-video input exceeds the frame limit.');
  const sourceId = selected[0].sourceId;
  if (
    selected.some(
      (frame, index) =>
        !frame.sourceId ||
        frame.sourceId !== sourceId ||
        !Number.isFinite(frame.observedAt) ||
        (index > 0 && frame.observedAt <= selected[index - 1].observedAt) ||
        (frame.mediaTimeMs === undefined) !== (selected[0].mediaTimeMs === undefined) ||
        (frame.mediaTimeMs !== undefined &&
          (!Number.isFinite(frame.mediaTimeMs) ||
            frame.mediaTimeMs < 0 ||
            frame.mediaTimeMs - selected[0].mediaTimeMs! > maxDurationMs ||
            (index > 0 &&
              selected[index - 1].mediaTimeMs !== undefined &&
              frame.mediaTimeMs <= selected[index - 1].mediaTimeMs!))) ||
        !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(frame.dataUrl),
    )
  )
    throw new Error('Native-video input has mixed, discontinuous, or invalid frames.');
  const firstMediaTime = selected[0].mediaTimeMs;
  return {
    sourceId,
    fromMs: selected[0].observedAt,
    throughMs: selected[selected.length - 1].observedAt,
    frames: selected.map((frame) => ({ ...frame })),
    timeline: selected.map((frame) => ({
      observedAt: frame.observedAt,
      ...(frame.mediaTimeMs === undefined ? {} : { mediaTimeMs: frame.mediaTimeMs }),
      // Recorded clips prefer media-time alignment; live clips use capture time.
      outputOffsetMs:
        firstMediaTime !== undefined && frame.mediaTimeMs !== undefined
          ? frame.mediaTimeMs - firstMediaTime
          : frame.observedAt - selected[0].observedAt,
    })),
  };
}
