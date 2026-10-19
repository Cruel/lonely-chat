/** Private disk-backed evidence. Never included in public chat/overlay or operational logs. */
export interface CompactRecordingStatus {
  readonly enabled: boolean;
  readonly recordingId: string | null;
  readonly attempts: number;
  readonly chunks: number;
  readonly bytes: number;
  readonly error: string | null;
}

export interface CompactAttemptSummary {
  readonly recordingId: string;
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

/** Rebuilt using today's request builder; never claim byte identity with historical requests. */
export interface CompactReconstruction {
  readonly input: unknown;
  readonly request: unknown;
  readonly provenance: 'current-builder-reconstruction';
  readonly recordedBuilderVersion: string;
  readonly currentBuilderVersion: string;
  readonly warning: string;
  readonly attempt: CompactAttemptSummary;
}
