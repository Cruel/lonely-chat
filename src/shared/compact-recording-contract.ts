import type { TraceAttempt } from './inference-trace-contract';

export type InferenceRecordingMode = 'compact' | 'exact';

export interface RecordingLimits {
  /** Maximum private recording bytes for a single archive (not saved cases). */
  readonly diskBytes: number;
  /** Maximum bytes held for incomplete attempts in memory. */
  readonly memoryBytes: number;
}

/** Private disk-backed evidence. Never included in public chat/overlay or operational logs. */
export interface CompactRecordingStatus {
  readonly enabled: boolean;
  readonly mode: InferenceRecordingMode;
  readonly recordingId: string | null;
  readonly attempts: number;
  readonly chunks: number;
  readonly bytes: number;
  /** All opt-in recording archive bytes, excluding standalone saved cases. */
  readonly totalBytes?: number;
  readonly error: string | null;
  readonly warning?: string | null;
  readonly partial?: boolean;
  readonly finalizing?: number;
  readonly limits?: RecordingLimits;
  readonly memoryBytes?: number;
}

export interface CompactAttemptSummary {
  readonly recordingId: string;
  readonly mode: InferenceRecordingMode;
  readonly id: string;
  readonly runId: number;
  readonly cycle: number;
  readonly attempt: number;
  readonly seed: number;
  readonly modelId: string | null;
  readonly startedAt: number;
  readonly durationMs: number | null;
  readonly stage: string;
  readonly chunk: string;
  readonly archiveStatus?: 'complete' | 'incomplete';
  readonly partial?: boolean;
  readonly interrupted?: boolean;
}

/** Compact uses today's builder. Exact uses the verified historical request independently of today's builder. */
export interface CompactReconstruction {
  readonly input: unknown;
  readonly request: unknown;
  readonly provenance:
    | 'current-builder-reconstruction'
    | 'exact-recorded-request'
    | 'exact-not-constructed';
  readonly recordedBuilderVersion: string;
  readonly currentBuilderVersion: string;
  readonly warning: string;
  readonly attempt: CompactAttemptSummary;
  /** Frozen outcome and subsequent publication/close records from the archive. */
  readonly outcome?: Partial<TraceAttempt>;
}
