import type { TraceRole, TraceStage, TraceUsage, TraceAttempt } from './inference-trace-contract';
import type { ProfileExperimentResult } from './profile-playground-contract';

/** Private, immutable recorded results. Reading this contract performs no inference or publication. */
export interface ReplayedStage {
  readonly id: string;
  readonly recordingId: string;
  readonly role: TraceRole;
  readonly cycle: number;
  readonly attempt: number;
  readonly stage: TraceStage | 'interrupted';
  readonly modelId: string | null;
  readonly profileRevision: number | null;
  readonly profileId: string | null;
  readonly consumedEvents: unknown;
  readonly seed: number;
  readonly observedAt: number | null;
  readonly availableAt: number | null;
  readonly startedAt: number;
  readonly dependsOn: readonly string[];
  readonly sourceFrameIds: readonly string[];
  readonly requestProvenance:
    | 'exact-recorded-request'
    | 'current-builder-reconstruction'
    | 'exact-not-constructed'
    | 'metadata-only';
  readonly accepted: unknown;
  readonly sceneState: unknown;
  readonly scheduled: unknown;
  readonly presented: TraceAttempt['presented'];
  readonly presentationClosed: boolean;
  readonly usage: TraceUsage | null;
  readonly error: string | null;
  readonly incomplete: boolean;
}

export interface RunReplay {
  readonly runId: string;
  readonly status: string;
  readonly stages: readonly ReplayedStage[];
  readonly missingDependencies: readonly string[];
  readonly warning: string | null;
}

/** A rerun never replaces the original results or publishes to an overlay. */
export interface RunChatComparison {
  readonly original: ReplayedStage;
  readonly experiment: ProfileExperimentResult;
  readonly changes: {
    readonly model: boolean;
    readonly profileRevision: boolean;
    readonly seed: boolean;
    readonly output: boolean;
    readonly possibleSamplingVariation: boolean;
  };
}
