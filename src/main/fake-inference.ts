import type { ScheduledChat } from './chat-scheduler';
import { CHAT_ACTIVITY_LIMITS, type ChatActivity } from '../shared/audience-contract';
import type { VideoFrame } from '../shared/video-contract';
import type { ResourceMeasurements } from './resource-policy';
import type {
  CapturedObservation,
  InferredEvent,
  LabeledTranscript,
} from '../shared/session-contract';

export interface InferenceInput {
  readonly context: string;
  readonly cycle: number;
  readonly playbackWindowMs?: number;
  readonly recentEvents?: readonly InferredEvent[];
  readonly recentTranscripts?: readonly LabeledTranscript[];
  readonly observations?: readonly CapturedObservation[];
  readonly frames?: readonly VideoFrame[];
  readonly videoWindow?: { fromMs: number; throughMs: number; truncated: boolean };
  readonly recentChat?: readonly { author: string; text: string; presentedAt: number }[];
  readonly roster?: readonly { author: string; color: string }[];
  readonly chatActivity?: ChatActivity;
  readonly boundary?: {
    fromSequence: number;
    throughSequence: number;
    fromMs: number;
    throughMs: number;
  };
}

export interface InferenceProvider {
  generate(input: InferenceInput, signal: AbortSignal): Promise<unknown>;
  prepare?(signal: AbortSignal): Promise<void>;
  generateRoster?(
    count: number,
    excluded: readonly string[],
    signal: AbortSignal,
  ): Promise<string[]>;
  stop?(): Promise<void> | void;
  resourceMeasurements?(): Promise<ResourceMeasurements>;
}

export const AUDIENCE = [
  { author: 'pixelpilot', color: '#bba5ff' },
  { author: 'lunar_fox', color: '#62d9b4' },
  { author: 'nightowl', color: '#ffbb78' },
] as const;

/** No hardware or model needed. Stable fixture output for a given cycle and context. */
export class FakeInference implements InferenceProvider {
  async generateRoster(
    count: number,
    excluded: readonly string[],
    _signal: AbortSignal,
  ): Promise<string[]> {
    const taken = new Set(excluded.map((value) => value.toLowerCase()));
    const names: string[] = [];
    for (let index = 1; names.length < count; index++) {
      const name = index <= AUDIENCE.length ? AUDIENCE[index - 1].author : `viewer_${index}`;
      if (!taken.has(name.toLowerCase())) names.push(name);
    }
    return names;
  }

  async generate(
    { context, cycle, roster = AUDIENCE, chatActivity = 'normal' }: InferenceInput,
    _signal: AbortSignal,
  ): Promise<unknown> {
    const subject = context.replace(/\s+/g, ' ').slice(0, 90);
    const messages: ScheduledChat[] = [
      {
        ...roster[(cycle - 1) % roster.length],
        text: cycle === 1 ? `Chat is watching: ${subject}` : `Still following: ${subject}`,
        offsetMs: 0,
      },
      {
        ...roster[cycle % roster.length],
        text: cycle % 2 === 0 ? 'Did you see that?' : "I'm here for this!",
        offsetMs: 900,
      },
      {
        ...roster[(cycle + 1) % roster.length],
        text: 'What happens next?',
        offsetMs: 2100,
      },
    ];
    if (chatActivity === 'busy') {
      for (let index = 3; index < CHAT_ACTIVITY_LIMITS.busy; index++) {
        messages.push({
          ...roster[(cycle + index) % roster.length],
          text: `Following along (${index + 1})`,
          offsetMs: index * 400,
        });
      }
    }
    return {
      events: cycle === 1 ? [{ kind: 'context', summary: subject, ageMs: 0 }] : [],
      messages: messages.slice(0, CHAT_ACTIVITY_LIMITS[chatActivity]),
    };
  }
}

const MAX_BATCH_MESSAGES = 64;
const MAX_EVENTS = 24;
const MAX_EVENT_AGE_MS = 60000;

/** Validate an entire inference cycle before publishing events or scheduling chat. */
export function parseInferenceResult(
  output: unknown,
  now: number,
): { messages: ScheduledChat[]; events: InferredEvent[] } {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('Inference result must be an object.');
  }
  const record = output as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'messages' && key !== 'events')) {
    throw new Error('Inference returned unexpected fields.');
  }
  const messages = parseChatBatch({ messages: record.messages });
  if (record.events === undefined) return { messages, events: [] }; // Existing fake fixture.
  if (!Array.isArray(record.events) || record.events.length > MAX_EVENTS) {
    throw new Error('Inference returned an invalid event batch.');
  }
  const events: InferredEvent[] = record.events.map((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Inference returned an invalid event.');
    }
    const item = value as Record<string, unknown>;
    if (
      Object.keys(item).length !== 3 ||
      (item.kind !== 'context' && item.kind !== 'reaction') ||
      typeof item.summary !== 'string' ||
      item.summary.trim().length < 1 ||
      item.summary.length > 300 ||
      typeof item.ageMs !== 'number' ||
      !Number.isFinite(item.ageMs) ||
      item.ageMs < 0 ||
      item.ageMs > MAX_EVENT_AGE_MS
    ) {
      throw new Error('Inference returned an invalid event.');
    }
    return { kind: item.kind, summary: item.summary, observedAt: now - item.ageMs };
  });
  return { messages, events };
}

const MAX_OFFSET_MS = 60000;

/** Validate the complete untrusted inference batch before any output is scheduled. */
export function parseChatBatch(output: unknown): ScheduledChat[] {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('Inference result must be an object.');
  }
  const record = output as Record<string, unknown>;
  if (
    Object.keys(record).length !== 1 ||
    !Array.isArray(record.messages) ||
    record.messages.length > MAX_BATCH_MESSAGES
  ) {
    throw new Error('Inference result has an invalid chat batch.');
  }
  return record.messages.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('Invalid chat message.');
    }
    const message = item as Record<string, unknown>;
    if (
      Object.keys(message).some((key) => !['author', 'text', 'color', 'offsetMs'].includes(key)) ||
      typeof message.author !== 'string' ||
      message.author.trim().length < 1 ||
      message.author.length > 50 ||
      typeof message.text !== 'string' ||
      message.text.trim().length < 1 ||
      message.text.length > 500 ||
      typeof message.color !== 'string' ||
      !/^#[0-9a-fA-F]{6}$/.test(message.color) ||
      typeof message.offsetMs !== 'number' ||
      !Number.isFinite(message.offsetMs) ||
      message.offsetMs < 0 ||
      message.offsetMs > MAX_OFFSET_MS
    ) {
      throw new Error('Inference returned an invalid chat message or playback offset.');
    }
    return {
      author: message.author,
      text: message.text,
      color: message.color,
      offsetMs: message.offsetMs,
    };
  });
}
