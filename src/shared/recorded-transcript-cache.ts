/** Versioned cache contract. No PCM or source-media paths are retained. */
export interface TranscriptCacheQuery {
  readonly fingerprint: string;
  readonly offsetMs: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly embeddedTrackIndex: number | null;
  readonly sampleRate: number;
}

export type RecordedTranscriptMode = 'transcribe' | 'save' | 'cached';

export interface TranscriptCacheSelection extends TranscriptCacheQuery {
  readonly mode: Exclude<RecordedTranscriptMode, 'transcribe'>;
}

export interface TranscriptCacheAvailability {
  readonly available: boolean;
  readonly reason: 'ready' | 'unavailable' | 'stale' | 'invalid';
  readonly count: number;
}

export function validateTranscriptCacheQuery(input: unknown): TranscriptCacheQuery {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Invalid transcript cache media descriptor.');
  const value = input as Record<string, unknown>;
  if (
    typeof value.fingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.fingerprint) ||
    !Number.isSafeInteger(value.offsetMs) ||
    Math.abs(value.offsetMs as number) > 86_400_000 ||
    !Number.isSafeInteger(value.startMs) ||
    (value.startMs as number) < 0 ||
    !Number.isSafeInteger(value.endMs) ||
    (value.endMs as number) <= (value.startMs as number) ||
    (value.endMs as number) > 86_400_000 ||
    !Number.isInteger(value.sampleRate) ||
    (value.sampleRate as number) < 8000 ||
    (value.sampleRate as number) > 192000 ||
    (value.embeddedTrackIndex !== null &&
      (!Number.isSafeInteger(value.embeddedTrackIndex) ||
        (value.embeddedTrackIndex as number) < 0 ||
        (value.embeddedTrackIndex as number) > 128))
  )
    throw new Error('Invalid transcript cache media descriptor.');
  return {
    fingerprint: value.fingerprint,
    offsetMs: value.offsetMs as number,
    startMs: value.startMs as number,
    endMs: value.endMs as number,
    embeddedTrackIndex: value.embeddedTrackIndex as number | null,
    sampleRate: value.sampleRate as number,
  };
}
