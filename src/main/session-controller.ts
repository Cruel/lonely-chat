import type { DiagnosticCapture } from './diagnostic-capture';
import type { ChatService } from './chat-service';
import { ChatScheduler, systemClock, type TimerClock } from './chat-scheduler';
import { FakeInference, parseInferenceResult, type InferenceProvider } from './fake-inference';
import { InferenceHistory, type CycleInput } from './inference-history';
import { VideoFrameBuffer } from './video-frame-buffer';
import { chooseWorkload, type ResourceMeasurements } from './resource-policy';
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
  private measuredResources: ResourceMeasurements | null = null;
  private switchAbort: AbortController | null = null;
  private switchBusy = false;
  private switchSettled: Promise<void> = Promise.resolve();

  constructor(
    chat: ChatService,
    private readonly inference: InferenceProvider = new FakeInference(),
    private readonly clock: TimerClock = systemClock,
    initialPreferences:
      | SessionPreferences
      | Pick<SessionPreferences, 'cycleIntervalMs'> = DEFAULT_PREFERENCES,
    private readonly nativeInference?: InferenceProvider,
    private readonly audience?: AudienceService,
    private readonly diagnostics?: DiagnosticCapture,
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
      (this.state.phase === 'starting' ||
        this.state.phase === 'running' ||
        this.state.phase === 'switching')
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
    if (
      this.state.phase !== 'starting' &&
      this.state.phase !== 'running' &&
      this.state.phase !== 'switching'
    ) {
      throw new Error('No running session to receive observations.');
    }
  }

  start(
    rawContext: unknown,
    mode: InferenceMode = 'fake',
    modelId: string | null = null,
  ): SessionSnapshot {
    if (this.switchBusy) throw new Error('Wait for model switching to finish before restarting.');
    if (
      this.state.phase === 'running' ||
      this.state.phase === 'starting' ||
      this.state.phase === 'switching'
    ) {
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
    this.measuredResources = null;
    this.scheduler.start();
    this.setState({
      phase: mode === 'native' ? 'starting' : 'running',
      mode,
      modelId: mode === 'native' ? modelId : null,
      events: [],
      cycle: 0,
      retryAttempt: 0,
      error: null,
      warning: null,
      latestInferenceMs: null,
      smoothedInferenceMs: null,
      playbackWindowMs: this.preferences.cycleIntervalMs,
      droppedObservations: 0,
      estimatedNextInferenceMs: null,
      adaptiveFrameLimit: null,
      effectiveCycleMs: null,
      adaptationReason: null,
      workerRamMiB: null,
      recentErrors: [],
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
    if (this.state.phase === 'stopped') return this.snapshot();
    this.epoch++;
    this.switchAbort?.abort();
    this.switchAbort = null;
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
    await this.switchSettled;
    await this.shutdownPromise;
  }

  get switchingModel(): boolean {
    return this.switchBusy;
  }

  /**
   * Switch the native installation without resetting history, chat boundaries or playback.
   * The repository mutation occurs only after the old worker has fully exited.
   */
  async switchNativeModel(
    activate: () => Promise<void>,
    modelId: string,
  ): Promise<SessionSnapshot> {
    if (
      this.state.mode !== 'native' ||
      !['starting', 'running', 'error'].includes(this.state.phase)
    ) {
      throw new Error('A native simulation must be active to switch its model.');
    }
    if (!this.nativeInference) throw new Error('Native inference is unavailable.');
    if (this.switchBusy) throw new Error('Model switching is already in progress.');
    this.switchBusy = true;
    let settle!: () => void;
    this.switchSettled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const epoch = ++this.epoch;
    this.abort?.abort();
    this.abort = null;
    if (this.inferenceTimer !== null) this.clock.clearTimeout(this.inferenceTimer);
    this.inferenceTimer = null;
    const abort = new AbortController();
    this.switchAbort = abort;
    this.setState({ phase: 'switching', retryAttempt: 0, error: null, warning: null });
    try {
      this.shutdownPromise = this.stopProvider(this.nativeInference);
      await this.shutdownPromise;
      if (abort.signal.aborted || epoch !== this.epoch) return this.snapshot();
      await activate();
      if (abort.signal.aborted || epoch !== this.epoch) return this.snapshot();
      // A failed load is visible and retriable; no old requests or output may commit.
      await this.nativeInference.prepare?.(abort.signal);
      if (abort.signal.aborted || epoch !== this.epoch) return this.snapshot();
      this.switchAbort = null;
      this.setState({ phase: 'running', modelId, error: null, warning: null });
      this.runCycle(epoch);
    } catch (error) {
      if (abort.signal.aborted || epoch !== this.epoch) return this.snapshot();
      this.shutdownPromise = this.stopProvider(this.nativeInference);
      const reason = error instanceof Error ? error.message : 'Unable to load the selected model.';
      this.setState({ phase: 'error', error: `Model switch failed: ${reason}`, warning: null });
    } finally {
      if (this.switchAbort === abort) this.switchAbort = null;
      this.switchBusy = false;
      settle();
    }
    return this.snapshot();
  }

  /** Restart inference after retry exhaustion without discarding validated history or chat. */
  retry(): SessionSnapshot {
    if (this.state.phase !== 'error') throw new Error('There is no failed inference to retry.');
    const epoch = ++this.epoch;
    this.setState({
      phase: this.state.mode === 'native' ? 'starting' : 'running',
      error: null,
      warning: null,
      retryAttempt: 0,
    });
    this.runCycle(epoch);
    return this.snapshot();
  }

  /** Wait for asynchronous native worker cleanup before any manual model action. */
  async awaitShutdown(): Promise<void> {
    await this.switchSettled;
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
    const plan = chooseWorkload(
      this.preferences,
      this.state.mode === 'native' ? this.smoothedMs : null,
      this.state.mode === 'native' ? this.measuredResources : null,
    );
    const media = this.video.sample(
      snapshot.boundary.fromMs,
      now,
      cycle === 1,
      this.state.mode === 'native' ? plan.frameLimit : this.preferences.videoMaxFrames,
    );
    const input: CycleInput = {
      ...snapshot,
      chatActivity: this.preferences.chatActivity,
      frames: media.frames,
      videoWindow: { fromMs: media.fromMs, throughMs: media.throughMs, truncated: media.truncated },
    };
    this.refreshDropped();
    this.setState({
      cycle,
      retryAttempt: 0,
      warning: null,
      adaptiveFrameLimit: this.state.mode === 'native' ? plan.frameLimit : null,
      effectiveCycleMs:
        this.state.mode === 'native' ? plan.minimumIntervalMs : this.preferences.cycleIntervalMs,
      adaptationReason: this.state.mode === 'native' ? plan.reason : null,
    });
    const cycleStarted = this.clock.now();
    this.runAttempt(epoch, input, cycleStarted, 1, this.diagnostics?.token() ?? null);
  }

  private runAttempt(
    epoch: number,
    input: CycleInput,
    cycleStarted: number,
    attempt: number,
    diagnosticToken: number | null,
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
        // Older supplied history and baseline preview frames are valid evidence too.
        const evidenceStart = Math.min(
          input.boundary.fromMs,
          ...(input.frames ?? []).map((entry) => entry.observedAt),
          ...(input.recentEvents ?? []).map((entry) => entry.observedAt),
          ...(input.recentTranscripts ?? []).map((entry) => entry.observedAt),
          ...(input.observations ?? []).map((entry) => entry.observedAt),
        );
        const result = parseInferenceResult(raw, input.boundary.throughMs, evidenceStart);
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
        this.diagnostics?.record(effectiveInput, duration, result, diagnosticToken);
        const windowMs = this.playbackWindow();
        const nextPlan = chooseWorkload(
          this.preferences,
          this.state.mode === 'native' ? this.smoothedMs : null,
          this.state.mode === 'native' ? this.measuredResources : null,
        );
        this.history.acknowledge(input.boundary);
        const events = this.history.commitEvents(result.events, this.clock.wallNow());
        this.setState({
          events,
          retryAttempt: 0,
          warning: null,
          latestInferenceMs: duration,
          smoothedInferenceMs: Math.round(this.smoothedMs),
          estimatedNextInferenceMs: Math.round(this.smoothedMs),
          effectiveCycleMs: nextPlan.minimumIntervalMs,
          adaptiveFrameLimit: this.state.mode === 'native' ? nextPlan.frameLimit : null,
          adaptationReason: this.state.mode === 'native' ? nextPlan.reason : null,
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
        if (this.state.mode === 'native' && provider.resourceMeasurements) {
          void provider
            .resourceMeasurements()
            .then((measurements) => {
              if (!this.active(epoch)) return;
              this.measuredResources = measurements;
              this.setState({ workerRamMiB: measurements.ramUsedMiB });
            })
            .catch(() => {
              /* Monitoring is optional and must never interrupt inference. */
            });
        }
        const delayMs = Math.max(
          0,
          (this.state.mode === 'native'
            ? nextPlan.minimumIntervalMs
            : this.preferences.cycleIntervalMs) -
            (this.clock.now() - cycleStarted),
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
        this.diagnostics?.record(
          effectiveInput,
          Math.max(0, this.clock.now() - inferenceStarted),
          { error: message },
          diagnosticToken,
        );
        this.setState({ recentErrors: [...(this.state.recentErrors ?? []), message].slice(-5) });
        // Native crashes/model load failures require a new worker. Retry the exact same
        // snapshot boundary; observations arriving in the meantime remain for the next cycle.
        this.shutdownPromise = this.stopProvider(provider);
        if (attempt >= MAX_ATTEMPTS) {
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
            this.runAttempt(epoch, input, cycleStarted, attempt + 1, diagnosticToken);
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
