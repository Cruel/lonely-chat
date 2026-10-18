import type { LabeledTranscript } from './session-contract';

export type AudioPhase = 'off' | 'starting' | 'ready' | 'disconnected' | 'error';

export interface AudioSourceStatus {
  /** Stable logical input identity; never reused for a different user-added input. */
  readonly id: string;
  readonly sourceId: string;
  readonly label: string;
  readonly phase: AudioPhase;
  readonly error: string | null;
  readonly pendingSegments: number;
}

export interface AudioStatus {
  readonly revision: number;
  readonly sources: readonly AudioSourceStatus[];
  readonly transcripts: readonly LabeledTranscript[];
}

export interface AudioInputConfiguration {
  readonly id: string;
  readonly sourceId: string;
  readonly label: string;
}

export interface AudioSegment {
  /** 16 kHz, mono, finite PCM from one standard audio capture source. */
  readonly samples: Float32Array;
  /** Recorded media segment end on the shared session clock; live capture omits it. */
  readonly observedAt?: number;
}

export interface RecordedAudioStart {
  readonly id: string;
  readonly label: string;
  readonly captureId: string;
  readonly sampleRate: number;
  /** File position to start decoding at, including negative-offset trim. */
  readonly seekMs: number;
  /** Track starts at this signed offset from the media timeline's zero. */
  readonly offsetMs: number;
}

export function validateAudioLabel(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) {
    throw new Error('Audio label must contain 1–80 characters.');
  }
  return value.trim();
}

export function validateAudioConfiguration(value: unknown): AudioInputConfiguration[] {
  if (!Array.isArray(value) || value.length > 64) {
    throw new Error('Invalid audio input configuration.');
  }
  const ids = new Set<string>();
  return value.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('Invalid audio input configuration.');
    }
    const record = item as Record<string, unknown>;
    if (
      Object.keys(record).length !== 3 ||
      !Object.keys(record).every((key) => ['id', 'sourceId', 'label'].includes(key)) ||
      typeof record.sourceId !== 'string' ||
      record.sourceId.length > 180 ||
      /\s/.test(record.sourceId)
    ) {
      throw new Error('Invalid audio input configuration.');
    }
    const id = validateAudioId(record.id);
    if (ids.has(id)) throw new Error('Duplicate audio input identity.');
    ids.add(id);
    return { id, sourceId: record.sourceId, label: validateAudioLabel(record.label) };
  });
}

export function validateAudioId(value: unknown): string {
  if (typeof value !== 'string' || !/^[\w-]{1,80}$/.test(value))
    throw new Error('Invalid audio input identity.');
  return value;
}
