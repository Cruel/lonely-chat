export type InferenceRecordingMode = 'compact' | 'exact';

/** Private disk-backed evidence. Never included in public chat/overlay or operational logs. */
export interface CompactRecordingStatus {
  readonly enabled: boolean;
  readonly mode: InferenceRecordingMode;
  readonly recordingId: string | null;
  readonly attempts: number;
  readonly chunks: number;
  readonly bytes: number;
  readonly error: string | null;
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
}
