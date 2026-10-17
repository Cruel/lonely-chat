import type { LabeledTranscript } from './session-contract';

export interface AudioStatus {
  readonly revision: number;
  readonly phase: 'off' | 'starting' | 'ready' | 'error';
  readonly sourceId: string | null;
  readonly label: string;
  readonly error: string | null;
  readonly pendingSegments: number;
  readonly transcripts: readonly LabeledTranscript[];
}

export interface AudioSegment {
  /** 16 kHz, mono, finite PCM, from a single ordinary audioinput. */
  readonly samples: Float32Array;
}

export function validateAudioLabel(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) {
    throw new Error('Audio label must contain 1–80 characters.');
  }
  return value.trim();
}
