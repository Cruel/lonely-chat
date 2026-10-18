import type { ChatActivity, ChatterIdentity } from './audience-contract';
import type { InferredEvent } from './session-contract';

/** Desktop-only, transient Freeform and Simulation inference. No chat/overlay serialization. */
export interface FreeformRequest {
  readonly modelId: string;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly temperature: number;
  readonly topP: number;
  readonly topK: number;
  readonly maxTokens: number;
  readonly seed: number;
}
export interface FreeformUsage {
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly totalTokens: number | null;
}
export interface FreeformResult {
  readonly modelId: string;
  readonly request: FreeformRequest;
  readonly effectiveSeed: number;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly content: string;
  readonly finishReason: string | null;
  readonly usage: FreeformUsage | null;
}
export interface AgedEntry {
  readonly ageMs: number;
}
export interface SimulationExperimentValues {
  readonly context: string;
  readonly cycle: number;
  readonly playbackWindowMs: number;
  readonly chatActivity: ChatActivity;
  readonly roster: readonly ChatterIdentity[];
  readonly events: readonly ({
    readonly kind: InferredEvent['kind'];
    readonly summary: string;
  } & AgedEntry)[];
  readonly transcripts: readonly ({ readonly source: string; readonly text: string } & AgedEntry)[];
  readonly observations: readonly ({
    readonly source: string;
    readonly description: string;
    readonly kind: 'visual' | 'audio';
  } & AgedEntry)[];
  readonly recentChat: readonly ({ readonly author: string; readonly text: string } & AgedEntry)[];
}
export interface SimulationExperimentRequest {
  readonly modelId: string;
  readonly values: SimulationExperimentValues;
  /** Advanced override, submitted without rewriting the production-constructed reference. */
  readonly rawRequestJson?: string;
}
export interface SimulationExperimentResult {
  readonly modelId: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly constructedRequest: unknown;
  readonly submittedRequest: unknown;
  readonly rawNativeOutput: unknown | null;
  readonly normalizedResult: unknown | null;
  readonly accepted: {
    readonly events: readonly InferredEvent[];
    readonly messages: readonly {
      author: string;
      text: string;
      color: string;
      offsetMs: number;
    }[];
  } | null;
  readonly errorStage: 'transport' | 'normalization' | 'validation' | null;
  readonly error: string | null;
  readonly usage: FreeformUsage | null;
}

export interface PlaygroundStatus {
  readonly busy: boolean;
}
export const DEFAULT_FREEFORM_SAMPLING = {
  temperature: 0.7,
  topP: 0.95,
  topK: 40,
  maxTokens: 512,
} as const;

export function validateFreeformRequest(value: unknown): FreeformRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid Playground request.');
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).sort().join(',') !==
    [
      'maxTokens',
      'modelId',
      'seed',
      'systemPrompt',
      'temperature',
      'topK',
      'topP',
      'userPrompt',
    ].join(',')
  )
    throw new Error('Invalid Playground request fields.');
  if (typeof v.modelId !== 'string' || v.modelId.length < 1 || v.modelId.length > 200)
    throw new Error('Select an installed model.');
  if (
    typeof v.systemPrompt !== 'string' ||
    v.systemPrompt.length > 8000 ||
    typeof v.userPrompt !== 'string' ||
    !v.userPrompt.trim() ||
    v.userPrompt.length > 16000
  )
    throw new Error('Enter a user prompt (up to 16,000 characters); system prompt limit is 8,000.');
  function range(key: string, low: number, high: number, integer = false): number {
    const n = v[key];
    if (
      typeof n !== 'number' ||
      !Number.isFinite(n) ||
      n < low ||
      n > high ||
      (integer && !Number.isInteger(n))
    )
      throw new Error(`Invalid ${key}: expected ${low}–${high}.`);
    return n;
  }
  return {
    modelId: v.modelId,
    systemPrompt: v.systemPrompt,
    userPrompt: v.userPrompt,
    temperature: range('temperature', 0, 2),
    topP: range('topP', 0, 1),
    topK: range('topK', 1, 200, true),
    maxTokens: range('maxTokens', 1, 8192, true),
    seed: range('seed', 0, 2147483647, true),
  };
}
