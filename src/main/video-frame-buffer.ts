import {
  MAX_SIMULATION_FRAME_WIDTH,
  MAX_SIMULATION_FRAME_HEIGHT,
  MAX_SIMULATION_FRAME_DATA_URL,
  type VideoFrame,
} from '../shared/video-contract';
import { DEFAULT_PREFERENCES, type SessionPreferences } from '../shared/session-contract';
import { VIDEO_SAMPLERS, type VideoSampler } from './video-sampler';

const MAX_BUFFERED_FRAMES = 260; // 60 s at the fastest allowed 250 ms cadence plus baseline.
const MAX_BUFFERED_BYTES = 32 * 1024 * 1024;
const BASELINE_LOOKBACK_MS = 2000;
const DATA_URL = /^data:image\/jpeg;base64,([a-zA-Z0-9+/]+={0,2})$/;

export type VideoSamplingPreferences = Pick<
  SessionPreferences,
  | 'videoCaptureIntervalMs'
  | 'videoCoverageMs'
  | 'videoMinFrames'
  | 'videoMaxFrames'
  | 'videoSamplingStrategy'
>;

export interface SampledVideoWindow {
  /** Actual media range (not necessarily the entire unbounded inference interval). */
  readonly fromMs: number;
  readonly throughMs: number;
  readonly truncated: boolean;
  readonly frames: readonly VideoFrame[];
}

/** Ephemeral capture ring, independent of inference success or model lifecycle. */
export class VideoFrameBuffer {
  private frames: VideoFrame[] = [];
  private sourceId: string | null = null;
  private options: VideoSamplingPreferences;

  constructor(
    options: VideoSamplingPreferences = DEFAULT_PREFERENCES,
    private readonly samplers: Record<
      SessionPreferences['videoSamplingStrategy'],
      VideoSampler
    > = VIDEO_SAMPLERS,
  ) {
    this.options = options;
  }

  configure(options: VideoSamplingPreferences, now: number): void {
    this.options = options;
    this.prune(now);
  }

  selectSource(sourceId: string | null): void {
    if (sourceId !== this.sourceId) {
      this.sourceId = sourceId;
      this.frames = [];
    }
  }

  push(frame: VideoFrame, now: number): void {
    if (
      !this.sourceId ||
      frame.sourceId !== this.sourceId ||
      !Number.isFinite(frame.observedAt) ||
      (frame.mediaTimeMs !== undefined &&
        (!Number.isFinite(frame.mediaTimeMs) ||
          frame.mediaTimeMs < 0 ||
          frame.mediaTimeMs > 1e12)) ||
      frame.observedAt < now - this.options.videoCoverageMs - BASELINE_LOOKBACK_MS ||
      frame.observedAt > now + 1000 ||
      !Number.isSafeInteger(frame.width) ||
      !Number.isSafeInteger(frame.height) ||
      frame.width < 1 ||
      frame.width > MAX_SIMULATION_FRAME_WIDTH ||
      frame.height < 1 ||
      frame.height > MAX_SIMULATION_FRAME_HEIGHT ||
      typeof frame.dataUrl !== 'string' ||
      frame.dataUrl.length > MAX_SIMULATION_FRAME_DATA_URL ||
      !DATA_URL.test(frame.dataUrl)
    ) {
      throw new Error('Invalid, expired, or inactive video frame.');
    }
    // Strictly increasing timestamps avoid duplicate data at inference boundaries.
    if (this.frames.length && frame.observedAt <= this.frames[this.frames.length - 1].observedAt) {
      return;
    }
    this.frames.push({ ...frame });
    this.prune(now);
  }

  sample(
    fromMs: number,
    throughMs: number,
    firstCycle: boolean,
    frameCap = this.options.videoMaxFrames,
  ): SampledVideoWindow {
    if (!Number.isFinite(fromMs) || !Number.isFinite(throughMs) || throughMs < fromMs) {
      throw new Error('Invalid video inference interval.');
    }
    this.prune(throughMs);
    const requestedFrom = firstCycle ? fromMs - BASELINE_LOOKBACK_MS : fromMs;
    const start = Math.max(requestedFrom, throughMs - this.options.videoCoverageMs);
    // Each later cycle owns (previous snapshot, current snapshot] without overlap.
    // A clipped range may include its new start because that frame was not consumed.
    // The first cycle may include preview frames acquired before Start.
    const eligible = this.frames.filter(
      (frame) =>
        (firstCycle || start > fromMs ? frame.observedAt >= start : frame.observedAt > start) &&
        frame.observedAt <= throughMs,
    );
    const elapsedMs = throughMs - start;
    const target = Math.max(
      Math.min(this.options.videoMinFrames, frameCap),
      Math.min(
        Math.min(this.options.videoMaxFrames, frameCap),
        Math.ceil(elapsedMs / this.options.videoCaptureIntervalMs),
      ),
    );
    const frames = this.samplers[this.options.videoSamplingStrategy](
      eligible,
      Math.min(eligible.length, target),
      start,
      throughMs,
    ).map((frame) => ({ ...frame }));
    return {
      fromMs: start,
      throughMs,
      truncated: start > requestedFrom,
      frames,
    };
  }

  get size(): number {
    return this.frames.length;
  }

  get active(): boolean {
    return this.sourceId !== null;
  }

  private prune(now: number): void {
    const oldest = now - this.options.videoCoverageMs - BASELINE_LOOKBACK_MS;
    this.frames = this.frames.filter((frame) => frame.observedAt >= oldest);
    this.frames = this.frames.slice(-MAX_BUFFERED_FRAMES);
    let bytes = this.frames.reduce((sum, frame) => sum + frame.dataUrl.length, 0);
    while (bytes > MAX_BUFFERED_BYTES && this.frames.length) {
      bytes -= this.frames.shift()!.dataUrl.length;
    }
  }
}
