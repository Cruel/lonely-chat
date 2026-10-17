import type { ChatService } from './chat-service';
import { ChatScheduler, systemClock, type TimerClock } from './chat-scheduler';
import { FakeInference, parseInferenceResult, type InferenceProvider } from './fake-inference';
import { InferenceHistory, type CycleInput } from './inference-history';
import { VideoFrameBuffer } from './video-frame-buffer';
import type { AudienceService } from './audience-service';
import { CHAT_ACTIVITY_LIMITS } from '../shared/audience-contract';
import type { VideoFrame } from '../shared/video-contract';
import {
  DEFAULT_PREFERENCES,
  validateContext,
  validatePreferences,
  type CapturedObservation,
  type InferenceMode,
  type LabeledTranscript,
  type SessionPreferences,
  type SessionSnapshot,
} from '../shared/session-contract';

const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 500;
const SMOOTHING_WEIGHT = 0.35;
const MAX_PLAYBACK_WINDOW_MS = 60000;

/** App-owned inference, observation boundaries and chat playback; never tied to a renderer. */
export class SessionController {
  private state: SessionSnapshot = {
    revision: 0,
    phase: 'stopped',
    error: null,
    warning: null,
    cycle: 0,
    retryAttempt: 0,
    pendingMessages: 0,
    mode: 'fake',
    events: [],
    latestInferenceMs: null,
    smoothedInferenceMs: null,
    playbackWindowMs: DEFAULT_PREFERENCES.cycleIntervalMs,
    droppedObservations: 0,
  };
  private subscribers = new Set<(snapshot: SessionSnapshot) => void>();
  private readonly scheduler: ChatScheduler;
  private readonly history: InferenceHistory;
  private readonly video: VideoFrameBuffer;
  private readonly chat: ChatService;
  private epoch = 0;
  private abort: AbortController | null = null;
  private inferenceTimer: unknown = null;
  private preferences: SessionPreferences;
  private context = '';
  private activeInference: InferenceProvider;
  private shutdownPromise: Promise<void> = Promise.resolve();
  private chatStartSequence = 0;
  private smoothedMs: number | null = null;

  constructor(
    chat: ChatService,
    private readonly inference: InferenceProvider = new FakeInference(),
    private readonly clock: TimerClock = systemClock,
    initialPreferences:
      | SessionPreferences
      | Pick<SessionPreferences, 'cycleIntervalMs'> = DEFAULT_PREFERENCES,
    private readonly nativeInference?: InferenceProvider,
    private readonly audience?: AudienceService,
  ) {
    this.chat = chat;
    this.activeInference = inference;
    this.preferences = validatePreferences(initialPreferences);
    this.history = new InferenceHistory(this.preferences);
    this.video = new VideoFrameBuffer(this.preferences);
    this.scheduler = new ChatScheduler(chat, clock, () => this.updatePending());
  }

  snapshot(): SessionSnapshot {
    return { ...this.state, events: [...this.state.events] };
  }

  getPreferences(): SessionPreferences {
    return { ...this.preferences };
  }

  setPreferences(value: unknown): SessionPreferences {
    const next = validatePreferences(value);
    if (
      next.audienceCount !== this.preferences.audienceCount &&
      (this.state.phase === 'starting' || this.state.phase === 'running')
    ) {
      throw new Error('Stop the simulation before resizing the audience.');
    }
    this.preferences = next;
    this.history.configure(this.preferences, this.clock.wallNow());
    this.video.configure(this.preferences, this.clock.wallNow());
    this.setState({
      events: this.history.recentEvents(this.clock.wallNow()),
      droppedObservations: this.history.droppedObservations,
    });
    return this.getPreferences();
  }

  subscribe(listener: (snapshot: SessionSnapshot) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  /** Trusted input seam for later capture/transcription workers; never callable via overlay IPC. */
  recordObservation(observation: CapturedObservation): void {
    this.requireActive();
    this.history.recordObservation(observation, this.clock.wallNow());
    this.refreshDropped();
  }

  /** The preview may run independently of inference; frames remain memory-only. */
  selectVideoSource(sourceId: string | null): void {
    this.video.selectSource(sourceId);
  }

  recordVideoFrame(frame: VideoFrame): void {
    this.video.push(frame, this.clock.wallNow());
  }

  recordTranscript(transcript: LabeledTranscript): void {
    this.requireActive();
    this.history.recordTranscript(transcript, this.clock.wallNow());
    this.refreshDropped();
  }

  private requireActive(): void {
    if (this.state.phase !== 'starting' && this.state.phase !== 'running') {
      throw new Error('No running session to receive observations.');
    }
  }

  start(rawContext: unknown, mode: InferenceMode = 'fake'): SessionSnapshot {
    if (this.state.phase === 'running' || this.state.phase === 'starting') {
      throw new Error('The simulation is already running.');
    }
    const context =
      rawContext === '' && mode === 'native' && this.video.active
        ? 'React to the live video input.'
        : validateContext(rawContext);
    if (mode !== 'fake' && mode !== 'native') throw new Error('Unknown inference mode.');
    if (mode === 'native' && !this.nativeInference) {
      throw new Error('The native inference runtime is not configured.');
    }
    this.activeInference = mode === 'native' ? this.nativeInference! : this.inference;
    this.context = context;
    this.epoch++;
    this.history.reset(this.clock.wallNow());
    this.chatStartSequence = this.chat.snapshot().sequence;
    this.smoothedMs = null;
    this.scheduler.start();
    this.setState({
      phase: mode === 'native' ? 'starting' : 'running',
      mode,
      events: [],
      cycle: 0,
      retryAttempt: 0,
      error: null,
      warning: null,
      latestInferenceMs: null,
      smoothedInferenceMs: null,
      playbackWindowMs: this.preferences.cycleIntervalMs,
      droppedObservations: 0,
    });
    const epoch = this.epoch;
    if (this.preferences.baselineMs > 0) {
      this.inferenceTimer = this.clock.setTimeout(() => {
        this.inferenceTimer = null;
        this.runCycle(epoch);
      }, this.preferences.baselineMs);
    } else {
      this.runCycle(epoch);
    }
    return this.snapshot();
  }

  stop(): SessionSnapshot {
    this.epoch++;
    this.abort?.abort();
    const provider = this.activeInference;
    this.shutdownPromise = this.stopProvider(provider);
    this.abort = null;
    if (this.inferenceTimer !== null) this.clock.clearTimeout(this.inferenceTimer);
    this.inferenceTimer = null;
    this.scheduler.stop();
    this.context = '';
    this.setState({ phase: 'stopped', error: null, warning: null, retryAttempt: 0 });
    return this.snapshot();
  }

  async terminate(): Promise<void> {
    this.stop();
    await this.shutdownPromise;
  }

  /** Wait for asynchronous native worker cleanup before any manual model action. */
  async awaitShutdown(): Promise<void> {
    await this.shutdownPromise;
  }

  private active(epoch: number): boolean {
    return (
      epoch === this.epoch && (this.state.phase === 'running' || this.state.phase === 'starting')
    );
  }

  private playbackWindow(): number {
    return Math.min(
      MAX_PLAYBACK_WINDOW_MS,
      Math.max(
        this.preferences.cycleIntervalMs,
        Math.round(this.smoothedMs ?? this.preferences.cycleIntervalMs),
      ),
    );
  }

  private runCycle(epoch: number): void {
    if (!this.active(epoch)) return;
    const cycle = this.state.cycle + 1;
    const now = this.clock.wallNow();
    const chat = this.chat
      .snapshot()
      .messages.filter(
        (message) => Number(message.id.slice('chat-'.length)) > this.chatStartSequence,
      );
    const snapshot = this.history.snapshot(
      this.context,
      cycle,
      now,
      this.playbackWindow(),
      chat,
      this.audience?.snapshot().members,
    );
    const media = this.video.sample(snapshot.boundary.fromMs, now, cycle === 1);
    const input: CycleInput = {
      ...snapshot,
      chatActivity: this.preferences.chatActivity,
      frames: media.frames,
      videoWindow: { fromMs: media.fromMs, throughMs: media.throughMs, truncated: media.truncated },
    };
    this.refreshDropped();
    this.setState({ cycle, retryAttempt: 0, warning: null });
    const cycleStarted = this.clock.now();
    this.runAttempt(epoch, input, cycleStarted, 1);
  }

  private runAttempt(
    epoch: number,
    input: CycleInput,
    cycleStarted: number,
    attempt: number,
  ): void {
    if (!this.active(epoch)) return;
    const abort = new AbortController();
    this.abort = abort;
    const provider = this.activeInference;
    let inferenceStarted = this.clock.now();
    let effectiveInput = input;
    void Promise.resolve()
      .then(async () => {
        // A prior asynchronous stop must finish before this worker is reused.
        await this.shutdownPromise;
        if (!this.active(epoch) || abort.signal.aborted) return undefined;
        if (this.audience) {
          await this.audience.ensure(provider, abort.signal);
          effectiveInput = { ...input, roster: this.audience.snapshot().members };
        }
        if (!this.active(epoch) || abort.signal.aborted) return undefined;
        await provider.prepare?.(abort.signal);
        if (!this.active(epoch) || abort.signal.aborted) return undefined;
        if (this.state.phase === 'starting') this.setState({ phase: 'running' });
        inferenceStarted = this.clock.now();
        return provider.generate(effectiveInput, abort.signal);
      })
      .then((raw) => {
        if (!this.active(epoch) || abort.signal.aborted) return;
        const result = parseInferenceResult(raw, input.boundary.throughMs);
        if (
          this.audience &&
          result.messages.length > CHAT_ACTIVITY_LIMITS[effectiveInput.chatActivity ?? 'normal']
        ) {
          throw new Error(
            'Inference generated more messages than the configured chat activity allows.',
          );
        }
        const resolved = this.audience
          ? this.audience.resolve(result.messages, effectiveInput.recentChat ?? [])
          : result.messages;
        // All validation precedes every state change, history acknowledgement and playback.
        const duration = Math.max(0, this.clock.now() - inferenceStarted);
        this.smoothedMs =
          this.smoothedMs === null
            ? duration
            : this.smoothedMs * (1 - SMOOTHING_WEIGHT) + duration * SMOOTHING_WEIGHT;
        const windowMs = this.playbackWindow();
        this.history.acknowledge(input.boundary);
        const events = this.history.commitEvents(result.events, this.clock.wallNow());
        this.setState({
          events,
          retryAttempt: 0,
          warning: null,
          latestInferenceMs: duration,
          smoothedInferenceMs: Math.round(this.smoothedMs),
          playbackWindowMs: windowMs,
          droppedObservations: this.history.droppedObservations,
        });
        // Native output is constrained to the predicted upcoming playback window. Preserve
        // deterministic fixture offsets as-is to keep the playback/scheduler test surface.
        const messages =
          this.state.mode === 'native'
            ? resolved.map((item) => ({
                ...item,
                offsetMs: Math.min(item.offsetMs, windowMs),
              }))
            : resolved;
        this.scheduler.enqueue(messages, this.clock.now());
        this.abort = null;
        const delayMs = Math.max(
          0,
          this.preferences.cycleIntervalMs - (this.clock.now() - cycleStarted),
        );
        this.inferenceTimer = this.clock.setTimeout(() => {
          this.inferenceTimer = null;
          this.runCycle(epoch);
        }, delayMs);
      })
      .catch((error: unknown) => {
        if (!this.active(epoch) || abort.signal.aborted) return;
        this.abort = null;
        const message = error instanceof Error ? error.message : 'Unknown inference error.';
        // Native crashes/model load failures require a new worker. Retry the exact same
        // snapshot boundary; observations arriving in the meantime remain for the next cycle.
        this.shutdownPromise = this.stopProvider(provider);
        if (attempt >= MAX_ATTEMPTS) {
          this.context = '';
          this.setState({
            phase: 'error',
            retryAttempt: attempt - 1,
            error: `Inference failed after ${attempt} attempts: ${message}`,
            warning: null,
          });
          return;
        }
        this.setState({
          retryAttempt: attempt,
          warning: `Inference attempt ${attempt} failed: ${message}. Retrying…`,
        });
        this.inferenceTimer = this.clock.setTimeout(
          () => {
            this.inferenceTimer = null;
            this.runAttempt(epoch, input, cycleStarted, attempt + 1);
          },
          RETRY_BASE_MS * 2 ** (attempt - 1),
        );
      });
  }

  private stopProvider(provider: InferenceProvider): Promise<void> {
    // An earlier cleanup failure must not poison all subsequent retries or restarts.
    return this.shutdownPromise
      .catch(() => {})
      .then(() => provider.stop?.())
      .then(
        () => {},
        (error: unknown) => {
          console.error('Unable to stop inference provider', error);
        },
      );
  }

  private refreshDropped(): void {
    if (this.state.droppedObservations !== this.history.droppedObservations) {
      this.setState({ droppedObservations: this.history.droppedObservations });
    }
  }

  private updatePending(): void {
    const count = this.scheduler.pendingCount;
    if (this.state.pendingMessages !== count) this.setState({ pendingMessages: count });
  }

  private setState(patch: Partial<Omit<SessionSnapshot, 'revision'>>): void {
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1 };
    for (const listener of this.subscribers) listener(this.snapshot());
  }
}
