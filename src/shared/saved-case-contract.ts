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
  /** Absent for cases saved before response capture was added. Never reconstructed. */
  readonly sourceResult?: SavedCaseSourceResult;
}

export interface SavedCaseSourceResult {
  readonly stage: TraceStage;
  readonly errorStage: TraceStage | null;
  readonly error: string | null;
  readonly durationMs: number | null;
  readonly usage: TraceUsage | null;
  readonly rawNativeOutput: unknown;
  readonly normalizedResult: unknown;
  readonly parsedResult: unknown;
  readonly accepted: unknown;
  readonly scheduled: unknown;
  readonly presented: unknown;
  readonly transportError: unknown;
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
  /** Original selected-frame indices; optional for children persisted by older versions. */
  readonly frameIndices?: readonly number[];
  /** Frozen child result; submitted request replaces image bytes with saved frame references. */
  readonly outcome?: {
    readonly submittedRequest: unknown;
    readonly rawNativeOutput: unknown;
    readonly normalizedResult: unknown;
    readonly parsedResult?: unknown;
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
