import type { TimerClock } from '../chat-scheduler';

export class FakeClock implements TimerClock {
  time = 10000;
  private nextId = 0;
  private timers = new Map<number, { due: number; callback: () => void }>();
  now = () => this.time;
  wallNow = () => this.time + 1700000000000;

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = ++this.nextId;
    this.timers.set(id, { due: this.time + delayMs, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      const next = [...this.timers.entries()].sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
      if (!next || next[1].due > end) break;
      this.time = next[1].due;
      this.timers.delete(next[0]);
      next[1].callback();
    }
    this.time = end;
  }
}

export async function flushMicrotasks(): Promise<void> {
  // Flush nested transport/coordinator/validation and Session completion queues.
  for (let index = 0; index < 32; index++) await Promise.resolve();
}
