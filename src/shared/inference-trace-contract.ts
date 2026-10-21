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

export type TraceRole = 'unified' | 'vision' | 'chat' | 'memory';

export interface TraceUsage {
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly totalTokens: number | null;
}

/** Private desktop-only metadata; content is fetched separately by ID. */
export interface TraceSummary {
  readonly id: string;
  /** Role at admission; older unified evidence may omit it. */
  readonly role?: TraceRole;
  readonly profileRevision?: number | null;
  /** The observation clock and the completion/availability clock are not interchangeable. */
  readonly observedAt?: number | null;
  readonly availableAt?: number | null;
  /** Physical start/availability projected onto the pause-adjusted Run clock. */
  readonly startedTimelineAt?: number | null;
  readonly availableTimelineAt?: number | null;
  /** Immutable, content-free evidence and causality identifiers. */
  readonly sourceFrameIds?: readonly string[];
  readonly observationRefs?: readonly string[];
  readonly dependsOn?: readonly string[];
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
  /** Bounded, content-free facets; full evidence remains behind trace:get. */
  readonly sources?: readonly string[];
  readonly chatters?: readonly string[];
  readonly eventKinds?: readonly string[];
  readonly boundary?: { readonly fromMs: number; readonly throughMs: number } | null;
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
  readonly sceneState?: unknown | null;
  /** Exact chat publications from this attempt, not inferred from scheduled offsets. */
  readonly presented?: readonly {
    readonly id: string;
    readonly author: string;
    readonly text: string;
    /** Actual publication time on the physical observation clock. */
    readonly presentedAt: number;
    /** Inspector-axis time, excluding recorded Run pauses. */
    readonly timelineAt?: number;
    readonly scheduledIndex: number;
  }[];
  /** True once unsent scheduled messages can no longer be published. */
  readonly presentationClosed?: boolean;
}

export interface TraceFilter {
  readonly text: string;
  readonly failuresOnly: boolean;
  readonly source: string;
  readonly chatter: string;
  readonly eventKind: string;
}

export interface TraceList {
  readonly attempts: readonly TraceSummary[];
  readonly dropped: number;
  readonly bytes: number;
}
