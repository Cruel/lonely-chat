import type {
  AudioSegment,
  AudioSourceStatus,
  AudioStatus,
  RecordedAudioStart,
} from '../shared/audio-contract';
import { validateAudioId, validateAudioLabel } from '../shared/audio-contract';
import type { LabeledTranscript } from '../shared/session-contract';
import type { NativeSpeech } from './native-speech';
import type { OperationalErrorSink } from './operational-logger';
import { systemClock, type TimerClock } from './chat-scheduler';
import { MonoResampler, SpeechSegmenter } from './audio-segmentation';
import type { TranscriptCacheQuery } from '../shared/recorded-transcript-cache';
import { validateTranscriptCacheQuery } from '../shared/recorded-transcript-cache';
import type { RecordedTranscriptCache, CachedTranscript } from './recorded-transcript-cache';

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
  recorded: {
    sampleRate: number;
    resampler: MonoResampler;
    segmenter: SpeechSegmenter;
    offsetMs: number;
    seekMs: number;
    originMs: number | null;
    finished: boolean;
    cacheMode: 'transcribe' | 'save' | 'cached';
    cacheQuery: TranscriptCacheQuery | null;
    cacheModel: string | null;
    cacheInvalid: boolean;
    receivedPcm: boolean;
    captured: CachedTranscript[];
    pending: Set<Promise<void>>;
    playbackTimers: Set<unknown>;
    cachedPending: Map<number, { entry: CachedTranscript; dueAt: number; timer: unknown | null }>;
    cachedPausedAt: number | null;
    cachedDone: Promise<void> | null;
    finishCached: (() => void) | null;
  } | null;
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
    private readonly transcriptCache?: RecordedTranscriptCache,
    private readonly speechModelId?: () => string | null,
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
    launch = true,
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
        recorded: null,
      };
      this.sources.set(inputId, source);
    }
    source.captureId = token;
    source.lastObservedAt = -Infinity;
    source.recorded = null;
    source.restartCount = 0;
    this.patch(source, { label: safeLabel, phase: 'starting', error: null, pendingSegments: 0 });
    if (launch) await this.launchWorker(source);
    else this.patch(source, { phase: 'ready', error: null });
    return this.snapshot();
  }

  /** File PCM shares the same resampler, 16 kHz VAD and per-source Whisper worker as live capture. */
  async startRecorded(value: RecordedAudioStart): Promise<AudioStatus> {
    if (!value || typeof value !== 'object') throw new Error('Invalid recorded audio source.');
    const id = validateAudioId(value.id);
    if (
      !Number.isInteger(value.sampleRate) ||
      value.sampleRate < 8000 ||
      value.sampleRate > 192000 ||
      !Number.isSafeInteger(value.offsetMs) ||
      Math.abs(value.offsetMs) > 86_400_000 ||
      !Number.isSafeInteger(value.seekMs) ||
      value.seekMs < 0 ||
      value.seekMs > 86_400_000 ||
      value.seekMs + value.offsetMs < 0
    )
      throw new Error('Invalid recorded audio rate or timeline alignment.');
    const cacheMode = value.cache?.mode ?? 'transcribe';
    if (!['transcribe', 'save', 'cached'].includes(cacheMode))
      throw new Error('Invalid recorded transcript mode.');
    const cacheQuery = value.cache ? validateTranscriptCacheQuery(value.cache) : null;
    if (
      cacheQuery &&
      (cacheQuery.sampleRate !== value.sampleRate ||
        cacheQuery.offsetMs !== value.offsetMs ||
        value.seekMs < Math.max(0, cacheQuery.startMs - value.offsetMs))
    )
      throw new Error('Recorded transcript descriptor does not match the audio source.');
    const cacheModel = cacheQuery ? this.speechModelId?.() : null;
    if (cacheQuery && (!cacheModel || !this.transcriptCache))
      throw new Error('Activate a speech model to use saved transcripts.');
    if (cacheMode === 'cached') this.transcriptCache!.read(cacheQuery!, cacheModel!);
    const result = await this.start(
      id,
      `recorded:${id}`,
      value.label,
      value.captureId,
      cacheMode !== 'cached',
    );
    const source = this.findCapture(value.captureId);
    if (source && source.status.phase === 'ready') {
      source.recorded = {
        sampleRate: value.sampleRate,
        resampler: new MonoResampler(value.sampleRate),
        segmenter: new SpeechSegmenter(),
        offsetMs: value.offsetMs,
        seekMs: value.seekMs,
        originMs: null,
        finished: false,
        cacheMode,
        cacheQuery,
        cacheModel: cacheModel ?? null,
        cacheInvalid: false,
        receivedPcm: false,
        captured: [],
        pending: new Set(),
        playbackTimers: new Set(),
        cachedPending: new Map(),
        cachedPausedAt: null,
        cachedDone: null,
        finishCached: null,
      };
    }
    return result;
  }

  armRecorded(captureId: string, originMs: number, mediaStartMs: number): void {
    const source = this.findCapture(validateAudioId(captureId));
    if (
      !source?.recorded ||
      source.status.phase !== 'ready' ||
      source.recorded.originMs !== null ||
      !Number.isFinite(originMs) ||
      originMs < 0 ||
      !Number.isFinite(mediaStartMs) ||
      mediaStartMs < source.recorded.seekMs ||
      mediaStartMs + source.recorded.offsetMs < 0
    )
      throw new Error('Recorded audio source is not ready for synchronization.');
    source.recorded.originMs = originMs;
    source.recorded.seekMs = mediaStartMs;
    if (source.recorded.cacheMode === 'cached') {
      const track = source.recorded;
      const epoch = source.epoch;
      const entries = this.transcriptCache!.read(track.cacheQuery!, track.cacheModel!);
      track.cachedDone = new Promise<void>((resolve) => {
        track.finishCached = resolve;
      });
      entries.forEach((entry, index) => {
        const pending = {
          entry,
          dueAt: originMs + entry.availableMs,
          timer: null as unknown | null,
        };
        track.cachedPending.set(index, pending);
        this.scheduleCached(source, track, epoch, index, pending);
      });
      if (!entries.length) track.finishCached?.();
    }
  }

  /** Suspend cached transcript availability as well as the renderer's decoded PCM. */
  pauseRecorded(): void {
    for (const source of this.sources.values()) {
      const track = source.recorded;
      if (
        !track ||
        (track.finished && track.cacheMode !== 'cached') ||
        track.cachedPausedAt !== null
      )
        continue;
      track.cachedPausedAt = this.now();
      for (const pending of track.cachedPending.values()) {
        if (pending.timer !== null) {
          this.clock.clearTimeout(pending.timer);
          track.playbackTimers.delete(pending.timer);
          pending.timer = null;
        }
      }
    }
  }

  resumeRecorded(): void {
    for (const source of this.sources.values()) {
      const track = source.recorded;
      if (!track || track.cachedPausedAt === null) continue;
      const elapsed = Math.max(0, this.now() - track.cachedPausedAt);
      track.cachedPausedAt = null;
      if (track.originMs !== null) track.originMs += elapsed;
      for (const [index, pending] of track.cachedPending) {
        pending.dueAt += elapsed;
        this.scheduleCached(source, track, source.epoch, index, pending);
      }
    }
  }

  private scheduleCached(
    source: Source,
    track: NonNullable<Source['recorded']>,
    epoch: number,
    index: number,
    pending: { entry: CachedTranscript; dueAt: number; timer: unknown | null },
  ): void {
    const timer = this.clock.setTimeout(
      () => {
        track.playbackTimers.delete(timer);
        pending.timer = null;
        if (source.epoch !== epoch || source.recorded !== track || track.cachedPausedAt !== null)
          return;
        track.cachedPending.delete(index);
        this.emitTranscript(source, {
          sourceId: source.status.id,
          source: source.status.label,
          text: pending.entry.text,
          observedAt: track.originMs! + pending.entry.observedMs,
        });
        if (track.cachedPending.size === 0) track.finishCached?.();
      },
      Math.max(0, pending.dueAt - this.now()),
    );
    pending.timer = timer;
    track.playbackTimers.add(timer);
  }

  /** Discontinuity barrier after a seek/stall: finish any prior partial speech,
   * then reset resampling/VAD and anchor subsequent PCM to the actual media position.
   * Playback must stop posting PCM until the renderer awaits this acknowledgement.
   */
  resyncRecorded(captureId: string, originMs: number, mediaStartMs: number): void {
    const source = this.findCapture(validateAudioId(captureId));
    const track = source?.recorded;
    if (
      !source ||
      !track ||
      source.status.phase !== 'ready' ||
      track.originMs === null ||
      track.finished ||
      !Number.isFinite(originMs) ||
      originMs < 0 ||
      Math.abs(track.originMs - originMs) > 500 ||
      !Number.isFinite(mediaStartMs) ||
      mediaStartMs < track.seekMs ||
      !Number.isFinite(mediaStartMs + track.offsetMs) ||
      mediaStartMs + track.offsetMs < 0
    )
      throw new Error('Recorded audio cannot resynchronize at this position.');
    // Renderer and main clocks can differ slightly after independently measuring a pause.
    track.originMs = originMs;
    if (track.cacheMode === 'cached') return; // Cached transcript clocks continue across renderer buffering.
    if (track.receivedPcm) track.cacheInvalid = true;
    const partial = track.segmenter.flushDetailed();
    if (partial && partial.samples.length >= 1600) {
      this.submit(
        {
          samples: partial.samples,
          observedAt: track.originMs + track.offsetMs + track.seekMs + partial.endSample / 16,
        },
        captureId,
      );
    }
    track.seekMs = mediaStartMs;
    track.resampler = new MonoResampler(track.sampleRate);
    track.segmenter = new SpeechSegmenter();
  }

  pushRecorded(samples: Float32Array, captureId: string): void {
    const source = this.findCapture(validateAudioId(captureId));
    const track = source?.recorded;
    if (
      !source ||
      !track ||
      source.status.phase !== 'ready' ||
      track.originMs === null ||
      track.finished
    )
      throw new Error('Recorded audio source is not active.');
    if (track.cacheMode === 'cached') throw new Error('Cached playback does not accept raw audio.');
    if (
      !(samples instanceof Float32Array) ||
      samples.length === 0 ||
      samples.length > 96_000 ||
      !samples.every((sample) => Number.isFinite(sample) && Math.abs(sample) <= 1.01)
    )
      throw new Error('Invalid recorded PCM chunk.');
    track.receivedPcm = true;
    for (const slice of track.segmenter.pushDetailed(track.resampler.push(samples))) {
      this.submit(
        {
          samples: slice.samples,
          observedAt: track.originMs + track.offsetMs + track.seekMs + slice.endSample / 16,
        },
        captureId,
      );
    }
  }

  async finishRecorded(captureId: string): Promise<void> {
    const source = this.findCapture(validateAudioId(captureId));
    const track = source?.recorded;
    if (!source || !track || track.originMs === null || track.finished) return;
    track.finished = true;
    if (track.cacheMode === 'cached') {
      await track.cachedDone;
      return;
    }
    const slice = track.segmenter.flushDetailed();
    if (slice && source.status.phase === 'ready')
      this.submit(
        {
          samples: slice.samples,
          observedAt: track.originMs + track.offsetMs + track.seekMs + slice.endSample / 16,
        },
        captureId,
      );
    await Promise.all(track.pending);
    if (
      track.cacheMode === 'save' &&
      !track.cacheInvalid &&
      source.recorded === track &&
      source.status.phase === 'ready' &&
      source.captureId === captureId
    ) {
      try {
        await this.transcriptCache!.save(track.cacheQuery!, track.cacheModel!, track.captured);
      } catch (error) {
        this.reportError?.('whisper', 'Unable to persist saved transcripts', error);
        throw error;
      }
    }
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
    for (const source of active) {
      if (source.recorded?.cacheMode === 'save') source.recorded.cacheInvalid = true;
    }
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
    if (source.status.pendingSegments >= 2) {
      if (source.recorded?.cacheMode === 'save') source.recorded.cacheInvalid = true;
      return;
    }
    const epoch = source.epoch;
    const label = source.status.label;
    if (
      value.observedAt !== undefined &&
      (!Number.isFinite(value.observedAt) ||
        value.observedAt < 0 ||
        value.observedAt > this.now() + 1000)
    )
      throw new Error('Invalid recorded audio observation time.');
    const observedAt = Math.max(value.observedAt ?? this.now(), source.lastObservedAt + 1);
    source.lastObservedAt = observedAt;
    this.patch(source, { pendingSegments: source.status.pendingSegments + 1 });
    const track = source.recorded;
    const pending = source.worker
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
          if (track?.cacheMode === 'save' && track.originMs !== null) {
            const observedMs = entry.observedAt - track.originMs;
            const availableMs = Math.max(observedMs, this.now() - track.originMs);
            track.captured.push({ text: entry.text, observedMs, availableMs });
          }
          this.emitTranscript(source, entry);
        },
        (error: unknown) => {
          if (epoch !== source.epoch) return;
          if (track?.cacheMode === 'save') track.cacheInvalid = true;
          this.workerFailed(source, epoch, error);
        },
      )
      .finally(() => {
        track?.pending.delete(pending);
        if (epoch !== source.epoch) return;
        this.patch(source, { pendingSegments: Math.max(0, source.status.pendingSegments - 1) });
      });
    track?.pending.add(pending);
  }

  private emitTranscript(source: Source, entry: LabeledTranscript): void {
    this.transcripts = [...this.transcripts, entry]
      .sort((left, right) => left.observedAt - right.observedAt)
      .slice(-MAX_SEGMENTS);
    this.notify();
    try {
      this.onTranscript(entry);
    } catch (error) {
      if (source.recorded?.cacheMode === 'save') source.recorded.cacheInvalid = true;
      this.reportError?.('whisper', 'Unable to attach speech transcript', error);
    }
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
    if (source.recorded?.cacheMode === 'save') source.recorded.cacheInvalid = true;
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
    if (source.recorded) {
      for (const timer of source.recorded.playbackTimers) this.clock.clearTimeout(timer);
      source.recorded.playbackTimers.clear();
      source.recorded.finishCached?.();
      source.recorded.cachedPending.clear();
    }
    this.retireWorker(source);
    source.captureId = null;
    source.recorded = null;
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
