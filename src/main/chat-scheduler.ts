import { observationNow } from '../shared/observation-clock';
import type { ChatMessage } from '../shared/chat-contract';
import type { ChatService } from './chat-service';

export interface TimerClock {
  /** Monotonic scheduling clock, independent of the calendar clock. */
  now(): number;
  /** Epoch-shaped monotonic observation time (legacy name; not the mutable wall clock). */
  wallNow(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: TimerClock = {
  now: () => performance.now(),
  wallNow: observationNow,
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface ScheduledChat {
  readonly author: string;
  readonly text: string;
  readonly color: string;
  readonly offsetMs: number;
}

interface PendingMessage {
  due: number;
  order: number;
  message: Omit<ChatMessage, 'id' | 'presentedAt'>;
}

/** One authoritative deadline queue across all overlapping inference batches. */
export class ChatScheduler {
  private queue: PendingMessage[] = [];
  private nextOrder = 0;
  private timer: unknown = null;
  private active = false;

  constructor(
    private readonly chat: ChatService,
    private readonly clock: TimerClock = systemClock,
    private readonly onChange: () => void = () => {},
  ) {}

  get pendingCount(): number {
    return this.queue.length;
  }

  start(): void {
    this.clear();
    this.active = true;
  }

  enqueue(batch: readonly ScheduledChat[], baseTime = this.clock.now()): void {
    if (!this.active) return;
    for (const message of batch) {
      this.queue.push({
        due: baseTime + message.offsetMs,
        order: this.nextOrder++,
        message: { author: message.author, text: message.text, color: message.color },
      });
    }
    this.queue.sort((a, b) => a.due - b.due || a.order - b.order);
    this.pump();
  }

  stop(): void {
    this.active = false;
    this.clear();
  }

  private clear(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.queue = [];
    this.onChange();
  }

  private pump(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    if (!this.active) return;
    const now = this.clock.now();
    while (this.active && this.queue.length && this.queue[0].due <= now) {
      const next = this.queue.shift()!;
      this.chat.publish(next.message, this.clock.wallNow());
    }
    this.onChange();
    if (this.queue.length) {
      this.timer = this.clock.setTimeout(
        () => {
          this.timer = null;
          this.pump();
        },
        Math.max(0, this.queue[0].due - this.clock.now()),
      );
    }
  }
}
