import type {
  CapturedObservation,
  InferredEvent,
  LabeledTranscript,
  SessionPreferences,
} from '../shared/session-contract';
import type { ChatMessage } from '../shared/chat-contract';
import type { InferenceInput } from './fake-inference';
import { AUDIENCE } from './fake-inference';

type CaptureEntry =
  | { readonly sequence: number; readonly kind: 'observation'; readonly data: CapturedObservation }
  | { readonly sequence: number; readonly kind: 'transcript'; readonly data: LabeledTranscript };

export interface InferenceBoundary {
  readonly fromSequence: number;
  readonly throughSequence: number;
  readonly fromMs: number;
  readonly throughMs: number;
}

export type CycleInput = InferenceInput & { readonly boundary: InferenceBoundary };

/**
 * Ephemeral, bounded input history. A cycle reads a fixed high-water mark; acknowledgement
 * moves only after full output validation. Captures arriving during inference belong to the
 * next window. Rejected requests can retry the exact same input without losing a boundary.
 */
export class InferenceHistory {
  private captures: CaptureEntry[] = [];
  private events: { readonly id: string; readonly data: InferredEvent }[] = [];
  private eventSequence = 0;
  private nextSequence = 0;
  private acknowledged = 0;
  private acknowledgedAt = 0;
  private dropped = 0;

  constructor(private limits: Pick<SessionPreferences, 'historyMaxCount' | 'historyMaxAgeMs'>) {}

  get droppedObservations(): number {
    return this.dropped;
  }

  reset(startMs: number): void {
    this.captures = [];
    this.events = [];
    this.eventSequence = 0;
    this.nextSequence = 0;
    this.acknowledged = 0;
    this.acknowledgedAt = startMs;
    this.dropped = 0;
  }

  configure(
    limits: Pick<SessionPreferences, 'historyMaxCount' | 'historyMaxAgeMs'>,
    now: number,
  ): void {
    this.limits = limits;
    this.prune(now);
  }

  recordObservation(value: CapturedObservation, now: number): void {
    this.verify(value.source, value.description, value.observedAt, now);
    if (value.kind !== 'visual' && value.kind !== 'audio') {
      throw new Error('Invalid observation kind.');
    }
    this.captures.push({ kind: 'observation', sequence: ++this.nextSequence, data: { ...value } });
    this.prune(now);
  }

  recordTranscript(value: LabeledTranscript, now: number): void {
    this.verify(value.source, value.text, value.observedAt, now);
    this.captures.push({ kind: 'transcript', sequence: ++this.nextSequence, data: { ...value } });
    this.prune(now);
  }

  commitEvents(events: readonly InferredEvent[], now: number): readonly InferredEvent[] {
    this.events.push(
      ...events.map((data) => ({ id: `event-${++this.eventSequence}`, data: { ...data } })),
    );
    this.prune(now);
    return this.recentEvents(now);
  }

  recentEvents(now: number): readonly InferredEvent[] {
    return this.bounded(this.events, (value) => value.data.observedAt, now).map((item) => ({
      ...item.data,
    }));
  }

  snapshot(
    context: string,
    cycle: number,
    now: number,
    playbackWindowMs: number,
    chat: readonly ChatMessage[],
    roster: readonly { author: string; color: string }[] = AUDIENCE,
  ): CycleInput {
    this.prune(now);
    const boundary: InferenceBoundary = {
      fromSequence: this.acknowledged,
      throughSequence: this.nextSequence,
      fromMs: this.acknowledgedAt,
      throughMs: now,
    };
    const eligible = this.captures.filter((item) => item.sequence <= boundary.throughSequence);
    const observations = eligible
      .filter(
        (item): item is Extract<CaptureEntry, { kind: 'observation' }> =>
          item.kind === 'observation' && item.sequence > this.acknowledged,
      )
      .map((item) => ({ ...item.data }));
    const recentTranscripts = eligible
      .filter(
        (item): item is Extract<CaptureEntry, { kind: 'transcript' }> => item.kind === 'transcript',
      )
      .map((item) => ({ ...item.data }))
      .sort((a, b) => a.observedAt - b.observedAt);
    return {
      context,
      cycle,
      boundary,
      captureSelection: {
        observations: eligible
          .filter((item) => item.kind === 'observation' && item.sequence > this.acknowledged)
          .map((item) => item.sequence),
        transcripts: eligible
          .filter((item) => item.kind === 'transcript')
          .map((item) => item.sequence),
        chat: this.bounded(chat, (item) => item.presentedAt, now).map((item) => item.id),
        events: this.bounded(this.events, (entry) => entry.data.observedAt, now).map(
          (entry) => entry.id,
        ),
      },
      playbackWindowMs,
      recentEvents: this.recentEvents(now),
      recentTranscripts,
      observations,
      recentChat: this.bounded(chat, (item) => item.presentedAt, now).map((item) => ({
        author: item.author,
        text: item.text,
        presentedAt: item.presentedAt,
      })),
      roster: roster.map((item) => ({ ...item })),
    };
  }

  acknowledge(boundary: InferenceBoundary): void {
    if (
      boundary.fromSequence !== this.acknowledged ||
      boundary.throughSequence > this.nextSequence
    ) {
      throw new Error('Invalid inference observation boundary.');
    }
    this.acknowledged = boundary.throughSequence;
    this.acknowledgedAt = boundary.throughMs;
  }

  private verify(source: string, text: string, at: number, now: number): void {
    if (
      typeof source !== 'string' ||
      !source.trim() ||
      source.length > 80 ||
      typeof text !== 'string' ||
      !text.trim() ||
      text.length > 2000 ||
      typeof at !== 'number' ||
      !Number.isFinite(at) ||
      at > now + 1000 ||
      at < now - this.limits.historyMaxAgeMs
    ) {
      throw new Error('Invalid or expired observation/transcript.');
    }
  }

  private bounded<T>(items: readonly T[], timestamp: (item: T) => number, now: number): T[] {
    return items
      .filter(
        (item) =>
          timestamp(item) >= now - this.limits.historyMaxAgeMs && timestamp(item) <= now + 1000,
      )
      .sort((left, right) => timestamp(left) - timestamp(right))
      .slice(-this.limits.historyMaxCount);
  }

  private prune(now: number): void {
    const age = now - this.limits.historyMaxAgeMs;
    const retained = this.captures.filter((entry) => entry.data.observedAt >= age);
    const kept = retained.slice(-this.limits.historyMaxCount);
    const removed = this.captures.filter(
      (item) => !kept.includes(item) && item.sequence > this.acknowledged,
    );
    this.dropped += removed.length;
    this.captures = kept;
    this.events = this.bounded(this.events, (item) => item.data.observedAt, now);
  }
}
