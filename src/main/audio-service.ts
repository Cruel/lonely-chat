import type { AudioSegment, AudioStatus } from '../shared/audio-contract';
import { validateAudioLabel } from '../shared/audio-contract';
import type { LabeledTranscript } from '../shared/session-contract';
import { NativeSpeech } from './native-speech';

const MAX_SEGMENTS = 10;

/** Audio lifecycle and privacy boundary, independent of video and llama inference. */
export class AudioService {
  private state: AudioStatus = {
    revision: 0,
    phase: 'off',
    sourceId: null,
    label: 'Microphone',
    error: null,
    pendingSegments: 0,
    transcripts: [],
  };
  private readonly listeners = new Set<(state: AudioStatus) => void>();
  private epoch = 0;
  private pending = 0;
  private captureId: string | null = null;

  constructor(
    private readonly worker: NativeSpeech,
    private readonly onTranscript: (entry: LabeledTranscript) => void,
    private readonly now = Date.now,
  ) {}

  snapshot(): AudioStatus {
    return { ...this.state, transcripts: [...this.state.transcripts] };
  }

  subscribe(fn: (state: AudioStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async start(sourceId: unknown, label: unknown, captureId: unknown): Promise<AudioStatus> {
    if (
      typeof sourceId !== 'string' ||
      sourceId.length < 1 ||
      sourceId.length > 180 ||
      /\s/.test(sourceId)
    ) {
      throw new Error('Select a valid microphone device.');
    }
    if (typeof captureId !== 'string' || !/^[\w-]{1,80}$/.test(captureId)) {
      throw new Error('Invalid audio capture identity.');
    }
    const safeLabel = validateAudioLabel(label);
    this.stop();
    this.captureId = captureId;
    const epoch = this.epoch;
    this.update({ phase: 'starting', sourceId, label: safeLabel, error: null });
    try {
      await this.worker.start();
      if (epoch !== this.epoch) return this.snapshot();
      this.update({ phase: 'ready' });
    } catch (error) {
      if (epoch !== this.epoch) return this.snapshot();
      this.update({
        phase: 'error',
        error: error instanceof Error ? error.message : 'Unable to initialize speech worker.',
      });
      this.worker.stop();
    }
    return this.snapshot();
  }

  submit(value: AudioSegment, captureId: string): void {
    if (captureId !== this.captureId)
      throw new Error('Audio segment belongs to a previous capture.');
    if (this.state.phase !== 'ready') throw new Error('Audio input is not active.');
    if (
      !value ||
      !(value.samples instanceof Float32Array) ||
      value.samples.length < 1600 ||
      value.samples.length > 16000 * 30 ||
      !value.samples.every((sample) => Number.isFinite(sample) && Math.abs(sample) <= 1.01)
    ) {
      throw new Error('Invalid microphone PCM segment.');
    }
    if (this.pending >= 2) return; // Backpressure: never queue unbounded raw audio.
    const epoch = this.epoch;
    const label = this.state.label;
    const observedAt = this.now();
    ++this.pending;
    this.update({ pendingSegments: this.pending });
    void this.worker
      .transcribe(value.samples)
      .then(
        (text) => {
          if (epoch !== this.epoch || !text.trim()) return;
          const entry: LabeledTranscript = {
            source: label,
            text: text.trim().slice(0, 2000),
            observedAt,
          };
          this.update({ transcripts: [...this.state.transcripts.slice(-MAX_SEGMENTS + 1), entry] });
          // Transcription is allowed outside an active session. If a session stops
          // between completion and delivery, it must not crash the audio worker.
          try {
            this.onTranscript(entry);
          } catch (error) {
            console.error('Unable to attach speech transcript', error);
          }
        },
        (error: unknown) => {
          if (epoch !== this.epoch) return;
          this.update({
            phase: 'error',
            error: error instanceof Error ? error.message : 'Speech worker failed.',
          });
          this.worker.stop();
        },
      )
      .finally(() => {
        if (epoch !== this.epoch) return;
        --this.pending;
        this.update({ pendingSegments: this.pending });
      });
  }

  stop(captureId?: string): AudioStatus {
    if (captureId !== undefined && captureId !== this.captureId) return this.snapshot();
    ++this.epoch;
    this.captureId = null;
    this.pending = 0;
    this.worker.stop();
    this.update({ phase: 'off', pendingSegments: 0, sourceId: null, error: null });
    return this.snapshot();
  }

  private update(patch: Partial<AudioStatus>): void {
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1 };
    for (const fn of this.listeners) fn(this.snapshot());
  }
}
