import type { AudioSegment, AudioSourceStatus, AudioStatus } from '../shared/audio-contract';
import { validateAudioId, validateAudioLabel } from '../shared/audio-contract';
import type { LabeledTranscript } from '../shared/session-contract';
import type { NativeSpeech } from './native-speech';
import type { OperationalErrorSink } from './operational-logger';
import { systemClock, type TimerClock } from './chat-scheduler';

const MAX_SEGMENTS = 10;
const PCM_LIMIT = 16000 * 30;
const MAX_RESTARTS = 2;

interface Source {
  status: AudioSourceStatus;
  captureId: string | null;
  epoch: number;
  worker: NativeSpeech | null;
  lastObservedAt: number;
  restartCount: number;
  restartTimer: unknown;
  unsubscribeWorker: (() => void) | null;
  retiring: Promise<void>;
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
    private readonly now = systemClock.wallNow,
    private readonly clock: Pick<TimerClock, 'setTimeout' | 'clearTimeout'> = systemClock,
    private readonly reportError?: OperationalErrorSink,
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
        restartCount: 0,
        restartTimer: null,
        unsubscribeWorker: null,
        retiring: Promise.resolve(),
      };
      this.sources.set(inputId, source);
    }
    source.captureId = token;
    source.restartCount = 0;
    this.patch(source, { label: safeLabel, phase: 'starting', error: null, pendingSegments: 0 });
    await this.launchWorker(source);
    return this.snapshot();
  }

  /** Reconnect a failed worker without changing its capture identity or input label. */
  async retry(id: unknown): Promise<AudioStatus> {
    const source = this.requireSource(id);
    if (!source.captureId || source.status.phase !== 'error') {
      throw new Error('Only a failed active audio input can be retried.');
    }
    source.restartCount = 0;
    await this.launchWorker(source);
    return this.snapshot();
  }

  /** Native model changes retire old workers before starting any new ones. */
  async reloadWorkers(activate: () => Promise<void>): Promise<void> {
    const active = [...this.sources.values()].filter(
      (source) => source.captureId !== null && source.status.phase !== 'disconnected',
    );
    const exits = active.map((source) => {
      this.retireWorker(source);
      this.patch(source, { phase: 'starting', error: null });
      return source.retiring;
    });
    try {
      await Promise.all(exits);
      await activate();
    } catch (error) {
      for (const source of active) {
        if (source.captureId)
          this.patch(source, {
            phase: 'error',
            error: error instanceof Error ? error.message : 'Unable to replace speech model.',
          });
      }
      throw error;
    }
    await Promise.all(
      active
        .filter((source) => source.captureId !== null)
        .map((source) => {
          source.restartCount = 0;
          return this.launchWorker(source);
        }),
    );
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
            this.reportError?.('whisper', 'Unable to attach speech transcript', error);
          }
        },
        (error: unknown) => {
          if (epoch !== source.epoch) return;
          this.workerFailed(source, epoch, error);
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

  /** Quit must await every retired child, not just send termination signals. */
  async terminate(): Promise<void> {
    this.stop();
    await Promise.all([...this.sources.values()].map((source) => source.retiring));
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

  private async launchWorker(source: Source): Promise<void> {
    const epoch = source.epoch;
    try {
      await source.retiring;
    } catch (error) {
      this.workerFailed(source, epoch, error);
      return;
    }
    if (epoch !== source.epoch || !source.captureId) return;
    const worker = this.newWorker();
    source.worker = worker;
    this.patch(source, { phase: 'starting', error: null });
    source.unsubscribeWorker =
      worker.subscribe?.((status) => {
        if (status.phase === 'failed')
          this.workerFailed(source, epoch, status.error ?? 'Speech worker failed.');
      }) ?? null;
    try {
      await worker.start();
      if (source.epoch === epoch) this.patch(source, { phase: 'ready', error: null });
      else worker.stop();
    } catch (error) {
      this.workerFailed(source, epoch, error);
    }
  }

  private workerFailed(source: Source, epoch: number, error: unknown): void {
    if (source.epoch !== epoch) return;
    const reason = error instanceof Error ? error.message : String(error);
    this.retireWorker(source);
    if (!source.captureId) return;
    if (source.restartCount >= MAX_RESTARTS) {
      this.patch(source, {
        phase: 'error',
        error: `Speech worker failed after ${MAX_RESTARTS} restarts: ${reason}`,
      });
      return;
    }
    source.restartCount++;
    this.patch(source, {
      phase: 'starting',
      error: `Speech worker failed: ${reason}. Restart ${source.restartCount}/${MAX_RESTARTS} pending…`,
    });
    const current = source.epoch;
    source.restartTimer = this.clock.setTimeout(
      () => {
        source.restartTimer = null;
        if (source.epoch === current && source.captureId) void this.launchWorker(source);
      },
      500 * 2 ** (source.restartCount - 1),
    );
  }

  private retireWorker(source: Source): void {
    ++source.epoch;
    if (source.restartTimer !== null) this.clock.clearTimeout(source.restartTimer);
    source.restartTimer = null;
    source.unsubscribeWorker?.();
    source.unsubscribeWorker = null;
    const worker = source.worker;
    source.worker = null;
    if (worker) {
      const previous = source.retiring;
      // Stop synchronously so stale capture/IPC callbacks cannot outlive this release.
      const retirement = worker.shutdown ? worker.shutdown() : (worker.stop(), Promise.resolve());
      source.retiring = Promise.all([previous.catch(() => {}), retirement]).then(() => {});
      void source.retiring.catch((error: unknown) => {
        this.reportError?.('whisper', 'Unable to retire speech worker', error);
      });
    }
    source.status = { ...source.status, pendingSegments: 0 };
  }

  private release(source: Source): void {
    this.retireWorker(source);
    source.captureId = null;
    source.restartCount = 0;
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
