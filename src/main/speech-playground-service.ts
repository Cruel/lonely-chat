import { MonoResampler, SpeechSegmenter, type SpeechSlice } from './audio-segmentation';
import type { NativeSpeech } from './native-speech';
import {
  validateSpeechTestStart,
  type SpeechTestSegment,
  type SpeechTestSnapshot,
} from '../shared/speech-playground-contract';

type SpeechWorker = Pick<NativeSpeech, 'start' | 'transcribe' | 'stop' | 'shutdown' | 'subscribe'>;
const MAX_PENDING = 2;
const MAX_HISTORY = 100;
const WHOLE_FILE_LIMIT = 16000 * 30;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Owns an independent Whisper worker and VAD buffer; it has no reference to Session or Chat. */
export class SpeechPlaygroundService {
  private state: SpeechTestSnapshot = {
    revision: 0,
    phase: 'idle',
    mode: null,
    sourceId: null,
    label: null,
    pending: 0,
    segments: [],
    error: null,
  };
  private readonly listeners = new Set<(snapshot: SpeechTestSnapshot) => void>();
  private worker: SpeechWorker | null = null;
  private unsubscribe: (() => void) | null = null;
  private resampler: MonoResampler | null = null;
  private segmenter: SpeechSegmenter | null = null;
  private wholeFile: Float32Array[] = [];
  private wholeSamples = 0;
  private tasks = new Set<Promise<void>>();
  private generation = 0;
  private nextSegment = 0;
  private retiring: Promise<void> = Promise.resolve();
  private failedStartupReleased = false;

  constructor(
    private readonly newWorker: () => SpeechWorker,
    private readonly canStart: () => boolean = () => true,
    private readonly now: () => number = Date.now,
  ) {}

  get busy(): boolean {
    return this.state.phase !== 'idle' && !this.failedStartupReleased;
  }

  snapshot(): SpeechTestSnapshot {
    return { ...this.state, segments: [...this.state.segments] };
  }

  subscribe(listener: (state: SpeechTestSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private patch(changes: Partial<SpeechTestSnapshot>): void {
    this.state = { ...this.state, ...changes, revision: this.state.revision + 1 };
    const next = this.snapshot();
    for (const listener of this.listeners) listener(next);
  }

  async start(input: unknown): Promise<SpeechTestSnapshot> {
    const request = validateSpeechTestStart(input);
    if (this.busy) throw new Error('Stop the previous speech test first.');
    if (!this.canStart())
      throw new Error('Stop Simulation and other model operations before testing speech.');
    const generation = ++this.generation;
    this.failedStartupReleased = false;
    this.resampler = new MonoResampler(request.sampleRate);
    this.segmenter = new SpeechSegmenter();
    this.wholeFile = [];
    this.wholeSamples = 0;
    this.nextSegment = 0;
    this.patch({
      phase: 'starting',
      mode: request.mode,
      sourceId: request.sourceId,
      label: request.label,
      pending: 0,
      segments: [],
      error: null,
    });
    try {
      await this.retiring;
      if (generation !== this.generation) throw new Error('Speech test cancelled.');
      const worker = this.newWorker();
      this.worker = worker;
      this.unsubscribe =
        worker.subscribe?.((status) => {
          if (generation === this.generation && status.phase === 'failed')
            this.patch({ phase: 'error', error: status.error ?? 'Native Whisper worker failed.' });
        }) ?? null;
      await worker.start();
      if (generation !== this.generation) throw new Error('Speech test cancelled.');
      if (this.state.phase === 'error')
        throw new Error(this.state.error ?? 'Speech worker failed.');
      this.patch({ phase: 'ready' });
      return this.snapshot();
    } catch (error) {
      if (generation === this.generation) {
        await this.retireWorker();
        // A failed initial load does not own a worker. Preserve the error for
        // the workspace, but permit model activation and another Start.
        this.resampler = null;
        this.segmenter = null;
        this.wholeFile = [];
        this.wholeSamples = 0;
        this.failedStartupReleased = true;
        this.patch({ phase: 'error', error: errorText(error) });
      }
      throw error;
    }
  }

  /** Raw mono PCM, shared resampling/VAD code with live capture. Sequential IPC arrivals preserve ordering. */
  async push(samples: unknown, backpressure = false): Promise<SpeechTestSnapshot> {
    if (typeof backpressure !== 'boolean') throw new Error('Invalid speech test feed mode.');
    if (this.state.phase !== 'ready' || !this.resampler || !this.segmenter)
      throw new Error('Start a speech test before supplying PCM.');
    if (
      !(samples instanceof Float32Array) ||
      samples.length === 0 ||
      samples.length > 96000 ||
      !samples.every((sample) => Number.isFinite(sample) && Math.abs(sample) <= 1.01)
    )
      throw new Error('Invalid speech test PCM chunk.');
    if (backpressure && this.state.mode === 'live-equivalent') {
      // File feeding can run much faster than real time; unlike live capture, don't
      // discard its speech while the native worker is busy.
      const generation = this.generation;
      while (this.tasks.size >= MAX_PENDING) {
        await Promise.race(this.tasks);
        if (generation !== this.generation || this.state.phase !== 'ready')
          throw new Error('Speech test stopped during file playback.');
      }
    }
    const pcm = this.resampler.push(samples);
    if (this.state.mode === 'live-equivalent') {
      for (const slice of this.segmenter.pushDetailed(pcm)) this.submit(slice);
    } else {
      if (this.wholeSamples + pcm.length > WHOLE_FILE_LIMIT)
        throw new Error(
          'Whole-file Whisper experiments are limited to 30 seconds. Use live-equivalent segmentation for longer files.',
        );
      this.wholeFile.push(pcm);
      this.wholeSamples += pcm.length;
    }
    return this.snapshot();
  }

  async finish(): Promise<SpeechTestSnapshot> {
    if (this.state.phase !== 'ready' || !this.segmenter)
      throw new Error('No active speech test to finish.');
    const generation = this.generation;
    this.patch({ phase: 'finishing' });
    if (this.state.mode === 'live-equivalent') {
      // Flush an unfinished VAD utterance at EOF, preserving the same production gate.
      const remaining = this.segmenter.flushDetailed();
      if (remaining) this.submit(remaining);
    } else if (this.wholeSamples >= 1600) {
      const samples = new Float32Array(this.wholeSamples);
      let index = 0;
      for (const chunk of this.wholeFile) {
        samples.set(chunk, index);
        index += chunk.length;
      }
      this.submit({ samples, startSample: 0, endSample: this.wholeSamples });
    }
    this.wholeFile = [];
    this.wholeSamples = 0;
    await Promise.allSettled(this.tasks);
    if (generation === this.generation && this.snapshot().phase === 'finishing')
      this.patch({ phase: 'ready' });
    return this.snapshot();
  }

  private submit(slice: SpeechSlice): void {
    const id = ++this.nextSegment;
    const generation = this.generation;
    const segment: SpeechTestSegment = {
      id,
      sourceId: this.state.sourceId!,
      label: this.state.label!,
      startMs: Math.round(slice.startSample / 16),
      endMs: Math.round(slice.endSample / 16),
      phase: this.tasks.size >= MAX_PENDING ? 'dropped' : 'pending',
      text: null,
      error: this.tasks.size >= MAX_PENDING ? 'Whisper backlog full; segment was dropped.' : null,
      durationMs: null,
    };
    this.patch({ segments: [...this.state.segments, segment].slice(-MAX_HISTORY) });
    if (segment.phase === 'dropped') return;
    const worker = this.worker;
    if (!worker) return;
    const started = this.now();
    let task!: Promise<void>;
    task = worker
      .transcribe(slice.samples)
      .then(
        (text) => {
          if (generation !== this.generation) return;
          this.updateSegment(id, {
            phase: text.trim() ? 'transcribed' : 'empty',
            text: text.trim() || null,
            durationMs: Math.max(0, this.now() - started),
          });
        },
        (error: unknown) => {
          if (generation !== this.generation) return;
          const reason = errorText(error);
          this.updateSegment(id, {
            phase: 'failed',
            error: reason,
            durationMs: Math.max(0, this.now() - started),
          });
          this.patch({ error: reason });
        },
      )
      .finally(() => {
        this.tasks.delete(task);
        if (generation === this.generation) this.patch({ pending: this.tasks.size });
      });
    this.tasks.add(task);
    this.patch({ pending: this.tasks.size });
  }

  private updateSegment(id: number, change: Partial<SpeechTestSegment>): void {
    this.patch({
      segments: this.state.segments.map((item) => (item.id === id ? { ...item, ...change } : item)),
    });
  }

  private async retireWorker(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    const worker = this.worker;
    this.worker = null;
    if (!worker) return;
    worker.stop();
    const previous = this.retiring;
    this.retiring = Promise.all([
      previous.catch(() => {}),
      worker.shutdown?.() ?? Promise.resolve(),
    ]).then(() => {});
    await this.retiring;
  }

  /** Stop releases capture/resampler buffers immediately; late worker results cannot repopulate history. */
  async stop(): Promise<SpeechTestSnapshot> {
    ++this.generation;
    this.failedStartupReleased = false;
    this.resampler = null;
    this.segmenter?.reset();
    this.segmenter = null;
    this.wholeFile = [];
    this.wholeSamples = 0;
    this.tasks.clear();
    // Keep the small textual test result visible after Stop. No PCM or worker survives.
    this.patch({ phase: 'idle', pending: 0, error: null });
    await this.retireWorker();
    return this.snapshot();
  }
}
