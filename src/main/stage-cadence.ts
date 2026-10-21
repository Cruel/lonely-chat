/** Monotonic, start-to-start rate limiter for independent inference stages. */
export class StageCadence {
  private lastStarted: number | null = null;
  private busy = false;

  constructor(private minimumIntervalMs: number) {
    if (!Number.isFinite(minimumIntervalMs) || minimumIntervalMs < 0)
      throw new Error('Invalid stage minimum interval.');
  }

  /** Apply a new interval at stage admission, preserving the last start and busy state. */
  configure(minimumIntervalMs: number): void {
    if (!Number.isFinite(minimumIntervalMs) || minimumIntervalMs < 0)
      throw new Error('Invalid stage minimum interval.');
    this.minimumIntervalMs = minimumIntervalMs;
  }

  /** Busy work never queues a catch-up attempt. */
  nextDelay(now: number): number {
    if (this.busy) return Infinity;
    return this.lastStarted === null
      ? 0
      : Math.max(0, this.lastStarted + this.minimumIntervalMs - now);
  }

  start(now: number): boolean {
    if (this.nextDelay(now) !== 0) return false;
    this.lastStarted = now;
    this.busy = true;
    return true;
  }

  finish(): void {
    this.busy = false;
  }

  get inFlight(): boolean {
    return this.busy;
  }
}

/** A completed observation may be reused, but never after its configured TTL. */
export class LatestStageResult<T> {
  private value: { result: T; completedAt: number; observedAt: number; identity: string } | null =
    null;

  publish(result: T, completedAt: number, observedAt: number, identity: string): void {
    if (
      !this.value ||
      this.value.identity !== identity ||
      (observedAt >= this.value.observedAt && completedAt >= this.value.completedAt)
    )
      this.value = { result, completedAt, observedAt, identity };
  }

  eligible(now: number, maximumAgeMs: number, identity: string): T | null {
    if (
      !this.value ||
      this.value.identity !== identity ||
      now < this.value.completedAt ||
      now - this.value.observedAt > maximumAgeMs
    )
      return null;
    return this.value.result;
  }

  clear(): void {
    this.value = null;
  }
}
