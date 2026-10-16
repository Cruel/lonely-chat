import type { VideoFrame } from '../shared/video-contract';

const MAX_FRAME_BYTES = 120_000;
const MAX_FRAMES = 90;
const MAX_AGE_MS = 45_000;
const MAX_SAMPLED = 8;
const DATA_URL = /^data:image\/jpeg;base64,([a-zA-Z0-9+/]+={0,2})$/;

/** Bounded, ephemeral JPEG frames. A source switch immediately invalidates earlier images. */
export class VideoFrameBuffer {
  private frames: VideoFrame[] = [];
  private sourceId: string | null = null;

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
      frame.observedAt < now - MAX_AGE_MS ||
      frame.observedAt > now + 1000 ||
      !Number.isSafeInteger(frame.width) ||
      !Number.isSafeInteger(frame.height) ||
      frame.width < 1 ||
      frame.width > 640 ||
      frame.height < 1 ||
      frame.height > 360 ||
      typeof frame.dataUrl !== 'string' ||
      frame.dataUrl.length > MAX_FRAME_BYTES ||
      !DATA_URL.test(frame.dataUrl)
    ) {
      throw new Error('Invalid, expired, or inactive video frame.');
    }
    // Do not allow a stale async transfer to reorder frames.
    if (this.frames.length && frame.observedAt < this.frames[this.frames.length - 1].observedAt) {
      return;
    }
    this.frames.push({ ...frame });
    this.prune(now);
  }

  sample(fromMs: number, throughMs: number, firstCycle: boolean): readonly VideoFrame[] {
    this.prune(throughMs);
    // Before the first cycle, include a fresh preview frame even with zero baseline delay.
    const start = firstCycle ? Math.min(fromMs, throughMs - 2000) : fromMs;
    const eligible = this.frames.filter(
      (frame) => frame.observedAt >= start && frame.observedAt <= throughMs,
    );
    if (eligible.length <= MAX_SAMPLED) return eligible.map((frame) => ({ ...frame }));
    // Preserve the first and last observations and spread the others across the actual window.
    return Array.from({ length: MAX_SAMPLED }, (_, index) => ({
      ...eligible[Math.floor((index * (eligible.length - 1)) / (MAX_SAMPLED - 1))],
    }));
  }

  get size(): number {
    return this.frames.length;
  }

  get active(): boolean {
    return this.sourceId !== null;
  }

  private prune(now: number): void {
    this.frames = this.frames
      .filter((frame) => frame.observedAt >= now - MAX_AGE_MS)
      .slice(-MAX_FRAMES);
  }
}
