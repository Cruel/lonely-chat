/** Private, opt-in speech evidence. Never part of operational logs or public chat. */
export interface CapturedSpeechSegment {
  readonly id: string;
  readonly sourceId: string;
  readonly label: string;
  readonly captureId: string;
  readonly sequence: number;
  /** Wall/session observation time, or input-relative time for Playground. */
  readonly timeBase: 'observation' | 'input';
  readonly startMs: number;
  readonly endMs: number;
  readonly observedAt: number;
  readonly capturedAt: number;
  readonly sampleRate: 16000;
  readonly sampleCount: number;
  readonly result: 'transcribed' | 'empty' | 'failed';
  readonly text: string | null;
  readonly error: string | null;
  readonly durationMs: number;
  readonly bytes: number;
}

export interface SpeechCaptureStatus {
  readonly enabled: boolean;
  readonly bytes: number;
  readonly maxBytes: number;
  readonly pending: number;
  readonly records: readonly CapturedSpeechSegment[];
  readonly warning: string | null;
}
