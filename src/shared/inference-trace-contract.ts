import type { InferenceMode } from './session-contract';

export type TraceStage =
  | 'preparing'
  | 'transport'
  | 'normalization'
  | 'validation'
  | 'accepted'
  | 'scheduled'
  | 'failed'
  | 'cancelled';

export interface TraceUsage {
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly totalTokens: number | null;
}

/** Private desktop-only metadata; content is fetched separately by ID. */
export interface TraceSummary {
  readonly id: string;
  readonly runId: number;
  readonly cycle: number;
  readonly attempt: number;
  readonly seed: number;
  readonly rosterSeed: number;
  readonly mode: InferenceMode;
  readonly modelId: string | null;
  readonly startedAt: number;
  readonly durationMs: number | null;
  readonly stage: TraceStage;
  readonly errorStage: TraceStage | null;
  readonly error: string | null;
  readonly usage: TraceUsage | null;
}

/** Content-bearing data must never be sent to the public overlay or operational logger. */
export interface TraceAttempt extends TraceSummary {
  readonly input: unknown;
  readonly settings: unknown;
  readonly promptPreset: unknown;
  readonly adaptation: unknown;
  readonly request: unknown | null;
  readonly rawResponse: unknown | null;
  readonly normalized: unknown | null;
  readonly parsed: unknown | null;
  readonly accepted: unknown | null;
  readonly scheduled: unknown | null;
  readonly transportError: unknown | null;
}

export interface TraceList {
  readonly attempts: readonly TraceSummary[];
  readonly dropped: number;
  readonly bytes: number;
}
