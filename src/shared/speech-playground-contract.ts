/** Private desktop-only speech experiments; never forwarded to Session/Event/Chat. */
export type SpeechTestMode = 'live-equivalent' | 'whole-file';
export type SpeechTestPhase = 'idle' | 'starting' | 'ready' | 'finishing' | 'error';
export type SpeechTestSegmentPhase = 'pending' | 'transcribed' | 'empty' | 'failed' | 'dropped';

export interface SpeechTestStart {
  readonly mode: SpeechTestMode;
  readonly sourceId: string;
  readonly label: string;
  readonly sampleRate: number;
}

export interface SpeechTestSegment {
  /** Opt-in raw PCM evidence UUID for this exact Whisper segment, when retained. */
  readonly speechSegmentId?: string;
  readonly id: number;
  readonly sourceId: string;
  readonly label: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly phase: SpeechTestSegmentPhase;
  readonly text: string | null;
  readonly error: string | null;
  readonly durationMs: number | null;
}

export interface SpeechTestSnapshot {
  readonly revision: number;
  readonly phase: SpeechTestPhase;
  readonly mode: SpeechTestMode | null;
  readonly sourceId: string | null;
  readonly label: string | null;
  readonly pending: number;
  readonly segments: readonly SpeechTestSegment[];
  readonly error: string | null;
}

export function validateSpeechTestStart(value: unknown): SpeechTestStart {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid speech test configuration.');
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).sort().join(',') !== 'label,mode,sampleRate,sourceId' ||
    (input.mode !== 'live-equivalent' && input.mode !== 'whole-file') ||
    typeof input.sourceId !== 'string' ||
    !/^[\w-]{1,80}$/.test(input.sourceId) ||
    typeof input.label !== 'string' ||
    !input.label.trim() ||
    input.label.length > 80 ||
    typeof input.sampleRate !== 'number' ||
    !Number.isInteger(input.sampleRate) ||
    input.sampleRate < 8000 ||
    input.sampleRate > 192000
  )
    throw new Error('Invalid speech test source, label, mode or sample rate.');
  return {
    mode: input.mode,
    sourceId: input.sourceId,
    label: input.label.trim(),
    sampleRate: input.sampleRate,
  };
}
