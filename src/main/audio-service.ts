import type { AudioSegment, AudioSourceStatus, AudioStatus } from '../shared/audio-contract';
import { validateAudioId, validateAudioLabel } from '../shared/audio-contract';
import type { LabeledTranscript } from '../shared/session-contract';
import type { NativeSpeech } from './native-speech';

const MAX_SEGMENTS = 10;
const PCM_LIMIT = 16000 * 30;

interface Source {
  status: AudioSourceStatus;
  captureId: string | null;
  epoch: number;
  worker: NativeSpeech | null;
  lastObservedAt: number;
}

/** Independently owned source/worker lifecycles; a stopped input cannot affect its peers. */
export class AudioService {
  private readonly sources = new Map<string, Source>();
  private readonly listeners = new Set<(state: AudioStatus) => void>();
  private revision = 0;
  private transcripts: LabeledTranscript[] = [];

  constructor(
    private readonly newWorker: () => NativeSpeech,
    private readonly onTranscript: (entry: LabeledTranscript) => void,
    private readonly now = Date.now,
  ) {}

  snapshot(): AudioStatus {
    return {
      revision: this.revision,
      sources: [...this.sources.values()].map(({ status }) => ({ ...status })),
      transcripts: [...this.transcripts],
    };
  }

  subscribe(fn: (state: AudioStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async start(
    id: unknown,
    sourceId: unknown,
    label: unknown,
    captureId: unknown,
  ): Promise<AudioStatus> {
    const inputId = validateAudioId(id);
    if (
      typeof sourceId !== 'string' ||
      sourceId.length < 1 ||
      sourceId.length > 180 ||
      /\s/.test(sourceId)
    )
      throw new Error('Select a valid audio capture device.');
    const token = validateAudioId(captureId);
    const safeLabel = validateAudioLabel(label);
    if ([...this.sources.values()].some((source) => source.captureId === token))
      throw new Error('Audio capture identity is already in use.');
    let source = this.sources.get(inputId);
    if (source) {
      this.release(source);
      source.status = { ...source.status, sourceId };
    } else {
      source = {
        status: {
          id: inputId,
          sourceId,
          label: safeLabel,
          phase: 'off',
          error: null,
          pendingSegments: 0,
        },
        captureId: null,
        epoch: 0,
        worker: null,
        lastObservedAt: -Infinity,
      };
      this.sources.set(inputId, source);
    }
    source.captureId = token;
    source.worker = this.newWorker();
    this.patch(source, { label: safeLabel, phase: 'starting', error: null, pendingSegments: 0 });
    const epoch = source.epoch;
    const worker = source.worker;
    try {
      await worker.start();
      if (source.epoch === epoch) this.patch(source, { phase: 'ready' });
      else worker.stop();
    } catch (error) {
      if (source.epoch === epoch) {
        this.release(source);
        this.patch(source, {
          phase: 'error',
          error: error instanceof Error ? error.message : 'Unable to initialize speech worker.',
        });
      }
    }
    return this.snapshot();
  }

  changeLabel(id: unknown, label: unknown): AudioStatus {
    const source = this.requireSource(id);
    this.patch(source, { label: validateAudioLabel(label) });
    return this.snapshot();
  }

  submit(value: AudioSegment, captureId: string): void {
    const source = this.findCapture(captureId);
    if (!source) throw new Error('Audio segment belongs to a previous capture.');
    if (source.status.phase !== 'ready' || !source.worker)
      throw new Error('Audio input is not active.');
    if (
      !value ||
      !(value.samples instanceof Float32Array) ||
      value.samples.length < 1600 ||
      value.samples.length > PCM_LIMIT ||
      !value.samples.every((sample) => Number.isFinite(sample) && Math.abs(sample) <= 1.01)
    )
      throw new Error('Invalid microphone PCM segment.');
    if (source.status.pendingSegments >= 2) return;
    const epoch = source.epoch;
    const label = source.status.label;
    const observedAt = Math.max(this.now(), source.lastObservedAt + 1);
    source.lastObservedAt = observedAt;
    this.patch(source, { pendingSegments: source.status.pendingSegments + 1 });
    void source.worker
      .transcribe(value.samples)
      .then(
        (text) => {
          if (epoch !== source.epoch || !text.trim()) return;
          const entry: LabeledTranscript = {
            sourceId: source.status.id,
            source: label,
            text: text.trim().slice(0, 2000),
            observedAt,
          };
          this.transcripts = [...this.transcripts, entry]
            .sort((left, right) => left.observedAt - right.observedAt)
            .slice(-MAX_SEGMENTS);
          this.notify();
          try {
            this.onTranscript(entry);
          } catch (error) {
            console.error('Unable to attach speech transcript', error);
          }
        },
        (error: unknown) => {
          if (epoch !== source.epoch) return;
          this.release(source);
          this.patch(source, {
            phase: 'error',
            error: error instanceof Error ? error.message : 'Speech worker failed.',
          });
        },
      )
      .finally(() => {
        if (epoch !== source.epoch) return;
        this.patch(source, { pendingSegments: Math.max(0, source.status.pendingSegments - 1) });
      });
  }

  disconnected(captureId: string): AudioStatus {
    const source = this.findCapture(captureId);
    if (source) {
      this.release(source);
      this.patch(source, {
        phase: 'disconnected',
        error: 'Audio device disconnected; waiting for reconnection.',
      });
    }
    return this.snapshot();
  }

  stop(captureId?: string): AudioStatus {
    if (captureId === undefined) {
      for (const source of this.sources.values()) {
        this.release(source);
        this.patch(source, { phase: 'off', error: null });
      }
    } else {
      const source = this.findCapture(captureId);
      if (source) {
        this.release(source);
        this.patch(source, { phase: 'off', error: null });
      }
    }
    return this.snapshot();
  }

  remove(id: unknown): AudioStatus {
    const source = this.requireSource(id);
    this.release(source);
    this.sources.delete(source.status.id);
    this.notify();
    return this.snapshot();
  }

  private requireSource(id: unknown): Source {
    const source = this.sources.get(validateAudioId(id));
    if (!source) throw new Error('Unknown audio input.');
    return source;
  }

  private findCapture(token: string): Source | undefined {
    return [...this.sources.values()].find((source) => source.captureId === token);
  }

  private release(source: Source): void {
    ++source.epoch;
    source.captureId = null;
    source.worker?.stop();
    source.worker = null;
    source.status = { ...source.status, pendingSegments: 0 };
  }

  private patch(source: Source, changes: Partial<AudioSourceStatus>): void {
    source.status = { ...source.status, ...changes };
    this.notify();
  }

  private notify(): void {
    ++this.revision;
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
