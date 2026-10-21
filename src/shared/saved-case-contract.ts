import type { SimulationExperimentResult } from './playground-contract';
import type { TraceStage, TraceUsage } from './inference-trace-contract';

export interface SavedCaseSummary {
  readonly id: string;
  readonly savedAt: string;
  readonly attemptId: string;
  readonly runId: number;
  readonly cycle: number;
  readonly attempt: number;
  readonly modelId: string;
  readonly seed: number;
  readonly frameCount: number;
  readonly childCount: number;
}
export interface SavedCaseFrame {
  readonly index: number;
  readonly sourceId: string;
  readonly observedAt: number;
  readonly mediaTimeMs?: number;
  readonly width: number;
  readonly height: number;
  readonly ref: string;
  readonly dataUrl: string;
}
/** Request contains opaque saved-frame:SHA256 references, never giant data URLs. */
export interface SavedCaseDetail {
  readonly summary: SavedCaseSummary;
  readonly request: unknown;
  readonly input: unknown;
  readonly frames: readonly SavedCaseFrame[];
  readonly children: readonly SavedCaseChild[];
  /** Frozen original attempt outcome, including explicit failure or omission. */
  readonly sourceResult: SavedCaseSourceResult;
}

export interface SavedCaseSourceResult {
  readonly stage: TraceStage;
  readonly errorStage: TraceStage | null;
  readonly error: string | null;
  readonly durationMs: number | null;
  readonly usage: TraceUsage | null;
  /** Original stage provenance and causality, including imported recorded cases. */
  readonly role?: import('./inference-trace-contract').TraceRole;
  readonly profileRevision?: number | null;
  readonly observedAt?: number | null;
  readonly availableAt?: number | null;
  readonly dependsOn?: readonly string[];
  readonly sourceFrameIds?: readonly string[];
  readonly observationRefs?: readonly string[];
  readonly rawNativeOutput: unknown;
  readonly normalizedResult: unknown;
  readonly parsedResult: unknown;
  readonly accepted: unknown;
  readonly scheduled: unknown;
  readonly presented: unknown;
  /** Whether the original Run published its explicit presentation-closed marker. */
  readonly presentationClosed?: boolean;
  readonly transportError: unknown;
  /** Compact cases freeze today's reconstruction, not the historical request. */
  readonly requestProvenance?: 'current-builder-reconstruction' | 'exact-recorded-request';
  /** Large outcomes are explicitly omitted, not truncated or represented as success. */
  readonly omitted?: string;
}
export interface SavedCaseChild {
  readonly id: string;
  readonly parentCaseId: string;
  readonly createdAt: string;
  readonly modelId: string;
  readonly seed: number;
  readonly errorStage: SimulationExperimentResult['errorStage'];
  readonly error: string | null;
  readonly durationMs: number;
  /** Original selected-frame indices (empty when the child had no images). */
  readonly frameIndices: readonly number[];
  /** Frozen child result; submitted request replaces image bytes with saved frame references. */
  readonly outcome: {
    readonly submittedRequest: unknown;
    readonly rawNativeOutput: unknown;
    readonly normalizedResult: unknown;
    readonly parsedResult: unknown;
    readonly accepted: unknown;
    readonly usage: SimulationExperimentResult['usage'];
    readonly omitted?: string;
  };
}
export interface SavedCaseFork {
  readonly caseId: string;
  readonly modelId: string;
  /** Editable JSON; frame URLs are opaque saved-frame references. */
  readonly rawRequestJson: string;
  /** Indices into the frozen original frame selection, kept in this order. */
  readonly frameIndices: readonly number[];
}
export interface SavedCaseForkResult {
  readonly child: SavedCaseChild;
  readonly result: SimulationExperimentResult;
}
