/**
 * File presentation time and authoritative observation time share a live 1× clock.
 * The decoder owns playback, not the inference worker. Dropped/late frames do not
 * pause or accelerate playback; sample timestamps remain monotonic.
 */
export class RecordedVideoTimeline {
  private lastMediaMs = -Infinity;
  private lastObservedMs = -Infinity;
  private firstMediaMs: number | null = null;
  private firstObservedMs = 0;

  constructor(
    private readonly originObservationMs: number,
    private readonly originMonotonicMs: number,
    private readonly intervalMs: number,
  ) {}

  sample(
    mediaTimeSeconds: number,
    nowMonotonicMs: number,
  ): { observedAt: number; mediaTimeMs: number } | null {
    const mediaTimeMs = Math.round(mediaTimeSeconds * 1000);
    // Anchor the first decoded frame to the shared observation clock. Thereafter
    // media PTS, not decoder callback jitter, determines observation timestamps.
    const observedAt =
      this.firstMediaMs === null
        ? this.originObservationMs + nowMonotonicMs - this.originMonotonicMs
        : this.firstObservedMs + (mediaTimeMs - this.firstMediaMs);
    if (
      !Number.isFinite(mediaTimeMs) ||
      mediaTimeMs < 0 ||
      !Number.isFinite(observedAt) ||
      mediaTimeMs <= this.lastMediaMs ||
      observedAt <= this.lastObservedMs ||
      observedAt - this.lastObservedMs < this.intervalMs
    )
      return null;
    if (this.firstMediaMs === null) {
      this.firstMediaMs = mediaTimeMs;
      this.firstObservedMs = observedAt;
    }
    this.lastMediaMs = mediaTimeMs;
    this.lastObservedMs = observedAt;
    return { observedAt, mediaTimeMs };
  }
}
