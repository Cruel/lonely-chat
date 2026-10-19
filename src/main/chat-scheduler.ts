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
  attemptId?: string;
  scheduledIndex?: number;
}

/** One authoritative deadline queue across all overlapping inference batches. */
export class ChatScheduler {
  private queue: PendingMessage[] = [];
  private nextOrder = 0;
  private timer: unknown = null;
  private active = false;
  private pausedAt: number | null = null;

  constructor(
    private readonly chat: ChatService,
    private readonly clock: TimerClock = systemClock,
    private readonly onChange: () => void = () => {},
    private readonly shouldPublishExternally: () => boolean = () => true,
    private readonly onPresented: (
      attemptId: string,
      message: ChatMessage,
      index: number,
    ) => void = () => {},
  ) {}

  get pendingCount(): number {
    return this.queue.length;
  }

  start(): void {
    this.clear();
    this.active = true;
    this.pausedAt = null;
  }

  pause(): void {
    if (!this.active || this.pausedAt !== null) return;
    this.pausedAt = this.clock.now();
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  resume(): void {
    if (this.pausedAt === null) return;
    const elapsed = Math.max(0, this.clock.now() - this.pausedAt);
    this.pausedAt = null;
    for (const pending of this.queue) pending.due += elapsed;
    this.pump();
  }

  enqueue(batch: readonly ScheduledChat[], baseTime = this.clock.now(), attemptId?: string): void {
    if (!this.active) return;
    for (const [scheduledIndex, message] of batch.entries()) {
      this.queue.push({
        due: baseTime + message.offsetMs,
        order: this.nextOrder++,
        message: { author: message.author, text: message.text, color: message.color },
        attemptId,
        scheduledIndex,
      });
    }
    this.queue.sort((a, b) => a.due - b.due || a.order - b.order);
    this.pump();
  }

  stop(): void {
    this.active = false;
    this.pausedAt = null;
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
    if (!this.active || this.pausedAt !== null) return;
    const now = this.clock.now();
    while (this.active && this.queue.length && this.queue[0].due <= now) {
      const next = this.queue.shift()!;
      const published = this.chat.publish(
        next.message,
        this.clock.wallNow(),
        this.shouldPublishExternally(),
      );
      if (next.attemptId && next.scheduledIndex !== undefined)
        this.onPresented(next.attemptId, published, next.scheduledIndex);
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
