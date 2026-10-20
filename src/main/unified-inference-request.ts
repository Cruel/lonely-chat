import {
  AUTHOR_PLACEHOLDER,
  CHAT_ACTIVITY_LIMITS,
  type ChatActivity,
  type ChatterIdentity,
} from '../shared/audience-contract';
import type { InferenceInput } from './fake-inference';
import { AUDIENCE } from './fake-inference';

/** Provider-independent ordered content; timestamps are observation times, never send times. */
export type InferenceContentPart =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'image';
      readonly dataUrl: string;
      readonly sourceId: string;
      readonly observedAt: number;
      readonly mediaTimeMs?: number;
    };

export type InferenceRole = 'unified' | 'vision' | 'chat' | 'memory';

export interface InferenceRequest<Role extends InferenceRole = InferenceRole, Schema = unknown> {
  readonly role: Role;
  readonly instructions: string;
  readonly content: readonly InferenceContentPart[];
  readonly response: {
    readonly kind: 'json';
    readonly schema: Schema;
  };
  readonly sampling: {
    readonly temperature: number;
    readonly maxTokens: number;
    readonly seed?: number;
  };
  readonly evidenceWindow: { readonly fromMs: number; readonly throughMs: number } | null;
  /** Optional transport-specific media source; never interpreted as an image frame. */
  readonly nativeVideo?: { readonly sourceRef: string };
}

export type UnifiedInferenceRequest = InferenceRequest<
  'unified',
  ReturnType<typeof unifiedOutputSchema>
>;

export const UNIFIED_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['events', 'messages'],
  properties: {
    events: {
      type: 'array',
      maxItems: 24,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'summary', 'ageMs'],
        properties: {
          kind: { type: 'string', enum: ['context', 'reaction'] },
          summary: { type: 'string', minLength: 1, maxLength: 300 },
          ageMs: { type: 'integer', minimum: 0, maximum: 60000 },
        },
      },
    },
    messages: {
      type: 'array',
      maxItems: 64,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['author', 'text', 'offsetMs'],
        properties: {
          author: {
            type: 'string',
            enum: [...AUDIENCE.map(({ author }) => author), AUTHOR_PLACEHOLDER],
          },
          text: { type: 'string', minLength: 1, maxLength: 500 },
          offsetMs: { type: 'integer', minimum: 0, maximum: 60000 },
        },
      },
    },
  },
} as const;

export function unifiedOutputSchema(roster: readonly ChatterIdentity[], activity: ChatActivity) {
  return {
    ...UNIFIED_OUTPUT_SCHEMA,
    properties: {
      ...UNIFIED_OUTPUT_SCHEMA.properties,
      messages: {
        ...UNIFIED_OUTPUT_SCHEMA.properties.messages,
        maxItems: CHAT_ACTIVITY_LIMITS[activity],
        items: {
          ...UNIFIED_OUTPUT_SCHEMA.properties.messages.items,
          properties: {
            ...UNIFIED_OUTPUT_SCHEMA.properties.messages.items.properties,
            author: {
              type: 'string',
              enum: [...roster.map((member) => member.author), AUTHOR_PLACEHOLDER],
            },
          },
        },
      },
    },
  };
}

/** The only Unified prompt and evidence construction path for Simulation and Playground. */
export function buildUnifiedInferenceRequest(
  input: InferenceInput,
  nativeVideoRef?: string,
): UnifiedInferenceRequest {
  const roster = input.roster ?? AUDIENCE;
  const activity = input.chatActivity ?? 'normal';
  const context = JSON.stringify({
    manualContext: input.context,
    cycle: input.cycle,
    recentEvents: (input.recentEvents ?? []).map(({ kind, summary, observedAt }) => ({
      kind,
      summary,
      observedAt,
    })),
    recentTranscripts: input.recentTranscripts ?? [],
    observations: input.observations ?? [],
    recentChat: input.recentChat ?? [],
    roster,
    chatActivity: activity,
    observationWindow: input.boundary ?? null,
    playbackWindowMs: input.playbackWindowMs ?? 3000,
    videoWindow: input.videoWindow ?? null,
    videoFrames: (input.frames ?? []).map(
      ({ observedAt, sourceId, width, height, mediaTimeMs }) => ({
        observedAt,
        sourceId,
        width,
        height,
        ...(mediaTimeMs === undefined ? {} : { mediaTimeMs }),
        offsetMs: input.videoWindow ? observedAt - input.videoWindow.fromMs : 0,
        ageMs: input.videoWindow ? input.videoWindow.throughMs - observedAt : 0,
      }),
    ),
  });
  const content: InferenceContentPart[] = [{ type: 'text', text: context }];
  (input.frames ?? []).forEach((frame, index) => {
    content.push({
      type: 'text',
      text: `Visual frame ${index + 1}, observedAt=${frame.observedAt} ms, relativeMs=${input.videoWindow ? frame.observedAt - input.videoWindow.fromMs : 0}, ageMs=${input.videoWindow ? input.videoWindow.throughMs - frame.observedAt : 0}, source=${frame.sourceId}`,
    });
    content.push({
      type: 'image',
      sourceId: frame.sourceId,
      observedAt: frame.observedAt,
      ...(frame.mediaTimeMs === undefined ? {} : { mediaTimeMs: frame.mediaTimeMs }),
      dataUrl: frame.dataUrl,
    });
  });
  return {
    role: 'unified',
    ...(nativeVideoRef === undefined ? {} : { nativeVideo: { sourceRef: nativeVideoRef } }),
    instructions:
      `You simulate a friendly live-stream audience. Infer at most 3 short events and write 1-${CHAT_ACTIVITY_LIMITS[activity]} natural viewer chat messages (activity: ${activity}). ` +
      `Use only roster identities, or ${AUTHOR_PLACEHOLDER} when any eligible roster member can speak. Prefer using explicit authors to follow earlier conversation threads. ` +
      'Only use the allowed author identities. Each visual frame is ordered and labeled with absolute and relative observation timestamps. Infer visual events from the images, not their metadata alone. A truncated videoWindow indicates missing earlier footage; do not invent it. ' +
      'ageMs is how many milliseconds before the observationWindow.throughMs an event happened (use 0 for ongoing context). ' +
      'offsetMs is when to display a chat message after this reply, within the requested playbackWindowMs. ' +
      'Use the provided observations and labeled transcripts to react to new content; maintain continuity with recent chat and events. ' +
      'Return only JSON matching the required schema.',
    content,
    response: { kind: 'json', schema: unifiedOutputSchema(roster, activity) },
    sampling: {
      temperature: 0.7,
      maxTokens: 2048,
      ...(input.seed === undefined ? {} : { seed: input.seed }),
    },
    evidenceWindow: input.boundary
      ? { fromMs: input.boundary.fromMs, throughMs: input.boundary.throughMs }
      : null,
  };
}
