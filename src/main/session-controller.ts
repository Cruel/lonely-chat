import type { DiagnosticCapture } from './diagnostic-capture';
import type { OperationalErrorSink } from './operational-logger';
import type { ChatService } from './chat-service';
import { ChatScheduler, systemClock, type TimerClock } from './chat-scheduler';
import { FakeInference, type InferenceInput, type InferenceProvider } from './fake-inference';
import { clipSimulationWindow } from './simulation-cycle';
import { SimulationExecutionError } from './simulation-execution';
import { InferenceCoordinator, type UnifiedInferenceAdapter } from './inference-coordinator';
import {
  ScheduledSplitInference,
  type SplitAdapters,
  type SplitScheduling,
} from './split-inference';
import { fixtureInferenceAdapter, llamaCppAdapter } from './unified-inference-adapters';
import { InferenceHistory, type CycleInput } from './inference-history';
import { VideoFrameBuffer } from './video-frame-buffer';
import { selectContinuousVideoWindow, type ContinuousVideoWindow } from './continuous-video-window';
import { PrivateInferenceError } from './private-inference-error';
import { InferenceTrace, traceFailureStage, traceUsage } from './inference-trace';
import { deriveInferenceSeed, randomInferenceSeed, validInferenceSeed } from './inference-seeds';
import { chooseWorkload, type ResourceMeasurements } from './resource-policy';
import type { AudienceService } from './audience-service';
import type { VideoFrame } from '../shared/video-contract';
import {
  DEFAULT_PREFERENCES,
  isRecordedVideoFailure,
  allowsRecordedSessionMedia,
  validateContext,
  validatePreferences,
  type CapturedObservation,
  type InferenceMode,
  type LabeledTranscript,
  type SessionPreferences,
  type SessionSnapshot,
  type SimulationInputOptions,
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
    failureKind: null,
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
  private readonly coordinator = new InferenceCoordinator();
  private remoteAdapter: ((input: InferenceInput) => UnifiedInferenceAdapter) | null = null;
  private splitAdapters: ((input: InferenceInput) => SplitAdapters) | null = null;
  private splitUsesLocal = false;
  private splitRosterProvider: InferenceProvider | null = null;
  private activeProfile: import('../shared/inference-profile-contract').InferenceProfile | null =
    null;
  private pendingProfile: import('../shared/inference-profile-contract').InferenceProfile | null = null;
  private readonly splitCoordinator = new ScheduledSplitInference();
  private splitVisionTimer: unknown = null;
  private splitVisionAbort: AbortController | null = null;
  private readonly scheduler: ChatScheduler;
  private readonly history: InferenceHistory;
  private readonly video: VideoFrameBuffer;
  private readonly chat: ChatService;
  readonly trace: InferenceTrace;
  private runId = 0;
  private epoch = 0;
  private abort: AbortController | null = null;
  private inferenceTimer: unknown = null;
  private preferences: SessionPreferences;
  private runPreferences: SessionPreferences;
  private context = '';
  private activeInference: InferenceProvider;
  private shutdownPromise: Promise<void> = Promise.resolve();
  private chatStartSequence = 0;
  private recordedChatPublication = true;
  private smoothedMs: number | null = null;
  private measuredResources: ResourceMeasurements | null = null;
  private switchAbort: AbortController | null = null;
  private switchBusy = false;
  private switchSettled: Promise<void> = Promise.resolve();
  private pausedAt: number | null = null;
  /** Recorded observations use a virtual wall clock; the UI/diagnostics keep physical time. */
  private pausedWallAt: number | null = null;
  private pauseIntervals: Array<{ startMs: number; endMs: number }> = [];
  private resumeWaiters: Array<() => void> = [];
  private nextCycleAt: number | null = null;
  private remainingCycleDelay: number | null = null;
  private attemptInFlight = false;
  private eofRequested = false;
  private finalCycleStarted = false;
  private transcriptRevision = 0;
  private cycleTranscriptRevision = 0;
  private processedTranscriptRevision = 0;

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
    private readonly reportError?: OperationalErrorSink,
    trace = new InferenceTrace(),
  ) {
    this.trace = trace;
    this.chat = chat;
    this.activeInference = inference;
    this.preferences = validatePreferences(initialPreferences);
    this.runPreferences = { ...this.preferences };
    this.history = new InferenceHistory(this.preferences);
    this.video = new VideoFrameBuffer(this.preferences);
    this.scheduler = new ChatScheduler(
      chat,
      clock,
      () => this.updatePending(),
      () => this.recordedChatPublication,
      (attemptId, message, index) =>
        this.trace.present(
          attemptId,
          { ...message, timelineAt: this.observationTime(message.presentedAt) },
          index,
        ),
    );
  }

  /** Queue a saved revision for the next admission; never change an in-flight attempt. */
  queueProfileUpdate(profile: import('../shared/inference-profile-contract').InferenceProfile): SessionSnapshot {
    if (this.state.phase !== 'running' || !this.activeProfile ||
        profile.id !== this.activeProfile.id ||
        profile.values.topology !== this.activeProfile.values.topology ||
        JSON.stringify(profile.values.roles) !== JSON.stringify(this.activeProfile.values.roles))
      throw new Error('Changing models, providers, or topology requires stopping the Run and an explicit transition.');
    const liveKeys = new Set(['cycleIntervalMs', 'historyMaxCount', 'historyMaxAgeMs', 'chatActivity']);
    const previousSettings = this.activeProfile.values.stageDefaults.unified?.settings ?? {};
    const nextSettings = profile.values.stageDefaults.unified?.settings ?? {};
    for (const key of new Set([...Object.keys(previousSettings), ...Object.keys(nextSettings)])) {
      if (!liveKeys.has(key) && JSON.stringify(previousSettings[key as keyof typeof previousSettings]) !==
          JSON.stringify(nextSettings[key as keyof typeof nextSettings]))
        throw new Error('Runtime/resource changes require stopping the Run.');
    }
    if (this.pendingProfile && profile.revision <= this.pendingProfile.revision ||
        profile.revision <= this.activeProfile.revision)
      throw new Error('Select a newer saved profile revision.');
    this.pendingProfile = structuredClone(profile);
    this.setState({ pendingProfileRevision: profile.revision });
    return this.snapshot();
  }

  private admitPendingProfile(): void {
    const next = this.pendingProfile;
    if (!next) return;
    this.pendingProfile = null;
    this.activeProfile = structuredClone(next);
    if (next.values.topology === 'unified') {
      const selected = next.values.stageDefaults.unified?.settings;
      this.runPreferences = validatePreferences({
        ...this.runPreferences,
        ...(selected?.cycleIntervalMs !== undefined ? { cycleIntervalMs: selected.cycleIntervalMs } : {}),
        ...(selected?.historyMaxCount !== undefined ? { historyMaxCount: selected.historyMaxCount } : {}),
        ...(selected?.historyMaxAgeMs !== undefined ? { historyMaxAgeMs: selected.historyMaxAgeMs } : {}),
        ...(selected?.chatActivity !== undefined ? { chatActivity: selected.chatActivity } : {}),
      });
      this.history.configure(this.runPreferences, this.observationNow());
    }
    this.setState({
      pendingProfileRevision: null,
      inferenceProfile: { id: next.id, name: next.name, revision: next.revision, topology: next.values.topology },
    });
  }

  /** Main-process only; set before starting a remote Run, never exposed as IPC state. */
  configureRemote(adapter: (input: InferenceInput) => UnifiedInferenceAdapter): void {
    if (['running', 'starting', 'switching'].includes(this.state.phase))
      throw new Error('Stop the current Run before changing its remote model.');
    this.remoteAdapter = adapter;
  }

  createLocalSplitAdapter(input: InferenceInput): UnifiedInferenceAdapter {
    if (!this.nativeInference) throw new Error('Local inference is unavailable.');
    const provider = this.nativeInference as InferenceProvider & {
      completeSimulationRequest?: (
        input: InferenceInput,
        request: unknown,
        signal: AbortSignal,
      ) => Promise<unknown>;
    };
    if (!provider.completeSimulationRequest) return fixtureInferenceAdapter(provider, input);
    return llamaCppAdapter(
      {
        completeSimulationRequest: (selected, request, signal) =>
          provider.completeSimulationRequest!(selected, request, signal),
      },
      input,
    );
  }

  configureSplit(
    adapters: (input: InferenceInput) => SplitAdapters,
    usesLocal: boolean,
    rosterProvider: InferenceProvider | null = null,
  ): void {
    if (['running', 'starting', 'switching'].includes(this.state.phase))
      throw new Error('Stop the current Run before changing Split models.');
    this.splitAdapters = adapters;
    this.splitUsesLocal = usesLocal;
    this.splitRosterProvider = rosterProvider;
  }

  configureFrameResizer(resizer: (frame: VideoFrame, maxWidth: number, maxHeight: number) => VideoFrame): void {
    this.splitCoordinator.configureFrameResizer(resizer);
  }

  canExecutePausedPlayground(): boolean {
    return (
      this.state.inputMode === 'recorded' &&
      this.state.recordedPlayback === 'paused' &&
      this.state.phase === 'running' &&
      !this.attemptInFlight &&
      !this.switchBusy &&
      !this.retryWork
    );
  }

  snapshot(): SessionSnapshot {
    return {
      ...this.state,
      playgroundAvailable: this.canExecutePausedPlayground(),
      events: [...this.state.events],
    };
  }

  getPreferences(): SessionPreferences {
    return { ...this.preferences };
  }

  /** The inference worker and each cycle read the start-of-run revision. */
  getEffectiveProfile(): import('../shared/inference-profile-contract').InferenceProfile | null {
    return this.activeProfile ? structuredClone(this.activeProfile) : null;
  }

  getRunPreferences(): SessionPreferences {
    return { ...this.runPreferences };
  }

  setPreferences(value: unknown): SessionPreferences {
    const next = validatePreferences(value);
    const runRetained =
      ['starting', 'running', 'switching'].includes(this.state.phase) ||
      (this.state.phase === 'error' && !isRecordedVideoFailure(this.state));
    if (next.audienceCount !== this.preferences.audienceCount && runRetained) {
      throw new Error('Stop the simulation before resizing the audience.');
    }
    this.preferences = next;
    if (!runRetained) {
      this.history.configure(this.preferences, this.observationNow());
      this.video.configure(this.preferences, this.observationNow());
    }
    this.setState({
      events: this.history.recentEvents(this.observationNow()),
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
    this.history.recordObservation(
      { ...observation, observedAt: this.observationTime(observation.observedAt) },
      this.observationNow(),
    );
    this.refreshDropped();
  }

  /** The preview may run independently of inference; frames remain memory-only. */
  selectVideoSource(sourceId: string | null): void {
    this.video.selectSource(sourceId);
  }

  recordVideoFrame(frame: VideoFrame): void {
    this.video.push(
      { ...frame, observedAt: this.observationTime(frame.observedAt) },
      this.observationNow(),
    );
  }

  recordTranscript(transcript: LabeledTranscript): void {
    if (!allowsRecordedSessionMedia(this.state)) this.requireActive();
    this.history.recordTranscript(
      { ...transcript, observedAt: this.observationTime(transcript.observedAt) },
      this.observationNow(),
    );
    if (this.state.inputMode === 'recorded') this.transcriptRevision++;
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
    options: SimulationInputOptions = { inputMode: 'live', publishToOverlay: true },
    preset?: {
      id: string;
      name: string;
      revision: number;
      chatActivity: SessionPreferences['chatActivity'];
    },
    settingsOverride?: SessionPreferences,
    profile?: import('../shared/inference-profile-contract').InferenceProfile | null,
  ): SessionSnapshot {
    if (this.switchBusy) throw new Error('Wait for model switching to finish before restarting.');
    if (
      this.state.phase === 'running' ||
      this.state.phase === 'starting' ||
      this.state.phase === 'switching'
    ) {
      throw new Error('The simulation is already running.');
    }
    if (
      !options ||
      !['live', 'recorded'].includes(options.inputMode) ||
      typeof options.publishToOverlay !== 'boolean' ||
      (options.hasVideoFile !== undefined && typeof options.hasVideoFile !== 'boolean') ||
      (options.hasAudioFiles !== undefined && typeof options.hasAudioFiles !== 'boolean') ||
      (options.transcriptMode !== undefined &&
        (!['transcribe', 'save', 'cached'].includes(options.transcriptMode) ||
          options.inputMode !== 'recorded')) ||
      (options.seed !== undefined && !validInferenceSeed(options.seed)) ||
      (options.presetId !== undefined &&
        (typeof options.presetId !== 'string' || options.presetId.length > 100)) ||
      (options.presetRevision !== undefined &&
        (!Number.isSafeInteger(options.presetRevision) ||
          options.presetRevision < 1 ||
          !options.presetId)) ||
      (options.profileId !== undefined &&
        (typeof options.profileId !== 'string' ||
          options.profileId.length > 100 ||
          !options.profileId)) ||
      (options.profileRevision !== undefined &&
        (!Number.isSafeInteger(options.profileRevision) ||
          options.profileRevision < 1 ||
          !options.profileId))
    )
      throw new Error('Invalid simulation media options.');
    const context =
      rawContext === '' && options.inputMode === 'recorded' && options.hasAudioFiles
        ? 'React to the recorded audio inputs.'
        : rawContext === '' && mode !== 'fake' && this.video.active
          ? options.inputMode === 'recorded'
            ? 'React to the recorded video input.'
            : 'React to the live video input.'
          : validateContext(rawContext);
    if (mode !== 'fake' && mode !== 'native' && mode !== 'remote')
      throw new Error('Unknown inference mode.');
    if (mode === 'remote' && (profile?.values.topology !== 'split' && profile?.values.topology !== 'hybrid') && !this.remoteAdapter)
      throw new Error('Remote inference is not configured.');
    if ((profile?.values.topology === 'split' || profile?.values.topology === 'hybrid') && !this.splitAdapters)
      throw new Error('Split inference stages are not configured.');
    if (mode === 'native' && !this.nativeInference) {
      throw new Error('The native inference runtime is not configured.');
    }
    const sessionSeed = options.seed ?? randomInferenceSeed();
    this.activeInference =
      mode === 'native' && (profile?.values.topology !== 'split' && profile?.values.topology !== 'hybrid')
        ? this.nativeInference!
        : this.inference;
    this.activeProfile = profile ? structuredClone(profile) : null;
    this.pendingProfile = null;
    this.context = context;
    this.runPreferences = {
      ...(settingsOverride ? validatePreferences(settingsOverride) : this.preferences),
      ...(preset ? { chatActivity: preset.chatActivity } : {}),
    };
    this.pauseIntervals = [];
    this.pausedWallAt = null;
    this.history.configure(this.runPreferences, this.clock.wallNow());
    this.video.configure(this.runPreferences, this.clock.wallNow());
    this.trace.closePresentation(this.runId);
    this.epoch++;
    this.stopSplitVisionLoop();
    this.splitCoordinator.reset();
    this.splitCoordinator.configureMemory(this.activeProfile?.values.memory ?? { enabled: false, intervalMs: 30000, maxCharacters: 2000, expireAfterMs: 0 });
    this.splitCoordinator.configureHybrid(this.activeProfile?.values.topology === 'hybrid' ? this.activeProfile.values.architecture?.hybridMaxImages ?? 0 : 0);
    this.runId++;
    this.history.reset(this.clock.wallNow());
    this.chatStartSequence = this.chat.snapshot().sequence;
    this.recordedChatPublication = options.inputMode === 'live' || options.publishToOverlay;
    this.smoothedMs = null;
    this.measuredResources = null;
    this.pausedAt = null;
    this.resumeWaiters = [];
    this.nextCycleAt = null;
    this.remainingCycleDelay = null;
    this.attemptInFlight = false;
    this.eofRequested = false;
    this.finalCycleStarted = false;
    this.transcriptRevision = 0;
    this.cycleTranscriptRevision = 0;
    this.processedTranscriptRevision = 0;
    this.scheduler.start();
    this.setState({
      runId: this.runId,
      phase: mode === 'fake' ? 'running' : 'starting',
      recordedPlayback: options.inputMode === 'recorded' ? 'playing' : null,
      mode,
      inputMode: options.inputMode,
      transcriptMode:
        options.inputMode === 'recorded' ? (options.transcriptMode ?? 'transcribe') : 'transcribe',
      modelId: mode === 'fake' ? null : modelId,
      events: [],
      cycle: 0,
      retryAttempt: 0,
      sessionSeed,
      promptPreset: preset ? { id: preset.id, name: preset.name, revision: preset.revision } : null,
      pendingProfileRevision: null,
      inferenceProfile: profile
        ? {
            id: profile.id,
            name: profile.name,
            revision: profile.revision,
            topology: profile.values.topology,
          }
        : null,
      effectiveSeed: null,
      recentAttemptSeeds: [],
      error: null,
      warning: null,
      latestInferenceMs: null,
      smoothedInferenceMs: null,
      playbackWindowMs: this.runPreferences.cycleIntervalMs,
      effectiveVideoCaptureIntervalMs: this.runPreferences.videoCaptureIntervalMs,
      effectiveVideoCaptureMaxWidth: Math.max(this.runPreferences.videoCaptureMaxWidth,
        this.activeProfile?.values.stageDefaults.observer?.frameSampling?.maxWidth ?? 0,
        this.activeProfile?.values.topology === 'hybrid' ? this.activeProfile.values.stageDefaults.chat?.frameSampling?.maxWidth ?? 0 : 0),
      effectiveVideoCaptureMaxHeight: Math.max(this.runPreferences.videoCaptureMaxHeight,
        this.activeProfile?.values.stageDefaults.observer?.frameSampling?.maxHeight ?? 0,
        this.activeProfile?.values.topology === 'hybrid' ? this.activeProfile.values.stageDefaults.chat?.frameSampling?.maxHeight ?? 0 : 0),
      droppedObservations: 0,
      estimatedNextInferenceMs: null,
      adaptiveFrameLimit: null,
      effectiveCycleMs: null,
      adaptationReason: null,
      workerRamMiB: null,
      recentErrors: [],
    });
    const epoch = this.epoch;
    if (this.runPreferences.baselineMs > 0) {
      this.scheduleCycle(epoch, this.runPreferences.baselineMs, () => this.runCycle(epoch));
    } else {
      this.runCycle(epoch);
    }
    return this.snapshot();
  }

  /** Only recorded Runs can be paused; a native attempt may finish but cannot commit yet. */
  pauseRecorded(): SessionSnapshot {
    this.requireRecordedPlayback();
    if (this.pausedAt !== null) return this.snapshot();
    this.pausedAt = this.clock.now();
    this.pausedWallAt = this.clock.wallNow();
    if (this.inferenceTimer !== null) {
      this.remainingCycleDelay = Math.max(0, (this.nextCycleAt ?? this.pausedAt) - this.pausedAt);
      this.clock.clearTimeout(this.inferenceTimer);
      this.inferenceTimer = null;
      this.nextCycleAt = null;
    }
    this.scheduler.pause();
    this.splitCoordinator.suspendMemory();
    this.setState({ recordedPlayback: 'paused' });
    return this.snapshot();
  }

  resumeRecorded(): SessionSnapshot {
    this.requireRecordedPlayback();
    if (this.pausedAt === null) return this.snapshot();
    this.pausedAt = null;
    this.closePausedInterval();
    this.scheduler.resume();
    this.splitCoordinator.resumeMemory();
    this.setState({ recordedPlayback: this.eofRequested ? 'draining' : 'playing' });
    const waiters = this.resumeWaiters.splice(0);
    for (const resume of waiters) resume();
    if (this.remainingCycleDelay !== null && (!this.eofRequested || this.retryWork)) {
      const delay = this.remainingCycleDelay;
      this.remainingCycleDelay = null;
      const epoch = this.epoch;
      // Only scheduled work is suspended; the in-flight attempt is never replayed.
      this.scheduleCycle(epoch, delay, () => {
        if (this.retryWork) {
          const retry = this.retryWork;
          this.retryWork = null;
          retry();
        } else this.runCycle(epoch);
      });
    }
    this.advanceRecordedEof();
    return this.snapshot();
  }

  /** Called after every enabled producer, including each Whisper queue, has reached EOF. */
  finishRecorded(): SessionSnapshot {
    this.requireRecordedPlayback();
    if (this.eofRequested) return this.snapshot();
    this.eofRequested = true;
    if (!this.retryWork) {
      if (this.inferenceTimer !== null) this.clock.clearTimeout(this.inferenceTimer);
      this.inferenceTimer = null;
      this.nextCycleAt = null;
      this.remainingCycleDelay = null;
    }
    if (this.pausedAt === null) this.setState({ recordedPlayback: 'draining' });
    this.advanceRecordedEof();
    return this.snapshot();
  }

  private retryWork: (() => void) | null = null;

  private requireRecordedPlayback(): void {
    if (
      this.state.inputMode !== 'recorded' ||
      !(
        ['starting', 'running', 'switching'].includes(this.state.phase) ||
        (this.state.phase === 'error' && !isRecordedVideoFailure(this.state))
      )
    )
      throw new Error('No active recorded simulation.');
  }

  private closePausedInterval(): void {
    if (this.pausedWallAt === null) return;
    this.pauseIntervals.push({
      startMs: this.pausedWallAt,
      endMs: Math.max(this.pausedWallAt, this.clock.wallNow()),
    });
    this.pausedWallAt = null;
  }

  /** Map physical capture and chat timestamps to the paused presentation timeline. */
  private observationTime(physicalMs: number): number {
    if (this.state.inputMode !== 'recorded' || this.state.phase === 'stopped') return physicalMs;
    let pauseMs = 0;
    for (const interval of this.pauseIntervals) {
      pauseMs += Math.max(0, Math.min(physicalMs, interval.endMs) - interval.startMs);
    }
    if (this.pausedWallAt !== null) {
      pauseMs += Math.max(0, Math.min(physicalMs, this.clock.wallNow()) - this.pausedWallAt);
    }
    return physicalMs - pauseMs;
  }

  private observationNow(): number {
    return this.observationTime(this.clock.wallNow());
  }

  private waitUntilResumed(): Promise<void> {
    if (this.pausedAt === null) return Promise.resolve();
    return new Promise<void>((resolve) => this.resumeWaiters.push(resolve));
  }

  private scheduleCycle(epoch: number, delayMs: number, callback: () => void): void {
    if (this.inferenceTimer !== null) this.clock.clearTimeout(this.inferenceTimer);
    if (this.pausedAt !== null) {
      this.remainingCycleDelay = delayMs;
      return;
    }
    this.nextCycleAt = this.clock.now() + delayMs;
    this.inferenceTimer = this.clock.setTimeout(() => {
      this.inferenceTimer = null;
      this.nextCycleAt = null;
      if (this.active(epoch)) callback();
    }, delayMs);
  }

  private advanceRecordedEof(): void {
    if (!this.eofRequested || this.pausedAt !== null || this.attemptInFlight) return;
    if (!this.active(this.epoch)) return;
    if (
      !this.finalCycleStarted &&
      (this.transcriptRevision > this.processedTranscriptRevision || this.state.cycle === 0)
    ) {
      this.finalCycleStarted = true;
      this.runCycle(this.epoch);
      return;
    }
    if (this.scheduler.pendingCount !== 0) return;
    this.trace.closePresentation(this.runId);
    this.stopSplitVisionLoop();
    this.splitCoordinator.cancelActive();
    this.setState({ phase: 'stopped', recordedPlayback: 'completed', retryAttempt: 0 });
    this.scheduler.stop();
    this.shutdownPromise = this.stopProvider(this.activeInference);
  }

  stop(silent = false): SessionSnapshot {
    if (this.state.phase === 'stopped') return this.snapshot();
    this.epoch++;
    this.closePausedInterval();
    this.pausedAt = null;
    this.eofRequested = false;
    this.attemptInFlight = false;
    this.remainingCycleDelay = null;
    this.nextCycleAt = null;
    this.retryWork = null;
    for (const resume of this.resumeWaiters.splice(0)) resume();
    this.pendingProfile = null;
    this.trace.cancelPending(this.runId);
    this.trace.closePresentation(this.runId);
    this.switchAbort?.abort();
    this.switchAbort = null;
    this.abort?.abort();
    this.coordinator.cancelActive();
    this.stopSplitVisionLoop();
    this.splitCoordinator.cancelActive();
    const provider = this.activeInference;
    this.shutdownPromise = this.stopProvider(provider);
    this.abort = null;
    if (this.inferenceTimer !== null) this.clock.clearTimeout(this.inferenceTimer);
    this.inferenceTimer = null;
    this.scheduler.stop();
    this.context = '';
    const stopped = {
      phase: 'stopped' as const,
      recordedPlayback: null,
      error: null,
      warning: null,
      retryAttempt: 0,
    };
    // Fatal media failure must publish only the final error. A transient 'stopped'
    // notification would finalize persisted Runs as stopped before they can fail.
    if (silent) this.state = { ...this.state, ...stopped };
    else this.setState(stopped);
    return this.snapshot();
  }

  /** An enabled decoder dying mid-Run is fatal, including audio and recoverable inference errors. */
  failRecordedMedia(
    source: string,
    message: string,
    failureKind: 'recorded-media' | 'recorded-video' = 'recorded-media',
  ): SessionSnapshot {
    if (
      this.state.inputMode !== 'recorded' ||
      !(
        ['starting', 'running', 'switching'].includes(this.state.phase) ||
        (this.state.phase === 'error' && this.state.failureKind === 'inference')
      )
    ) {
      throw new Error('No recorded simulation is running.');
    }
    if (
      typeof source !== 'string' ||
      !source.trim() ||
      source.length > 100 ||
      typeof message !== 'string' ||
      !message.trim() ||
      message.length > 500
    )
      throw new Error('Invalid recorded media decoder error.');
    this.stop(true);
    this.setState({
      phase: 'error',
      failureKind,
      error: `Recorded ${source} failed: ${message}`,
      warning: null,
    });
    return this.snapshot();
  }

  failRecordedVideo(message: string): SessionSnapshot {
    return this.failRecordedMedia('video', message, 'recorded-video');
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
    if ((this.state.inferenceProfile?.topology === 'split' || this.state.inferenceProfile?.topology === 'hybrid'))
      throw new Error('Stop the Split Run before changing its pinned local Model Configuration.');
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
    this.pendingProfile = null;
    this.trace.cancelPending(this.runId);
    this.abort?.abort();
    this.abort = null;
    this.attemptInFlight = false;
    this.retryWork = null;
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
      if (this.pausedAt !== null) this.scheduleCycle(epoch, 0, () => this.runCycle(epoch));
      else this.runCycle(epoch);
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
    if (isRecordedVideoFailure(this.state)) {
      throw new Error(
        'The recorded decoder failed. Select a supported file and start a new simulation.',
      );
    }
    const epoch = ++this.epoch;
    this.setState({
      phase: this.state.mode === 'fake' ? 'running' : 'starting',
      error: null,
      warning: null,
      retryAttempt: 0,
    });
    if (this.pausedAt !== null) {
      this.attemptInFlight = true;
      this.retryWork = () => this.runCycle(epoch);
      this.scheduleCycle(epoch, 0, () => {
        const retry = this.retryWork;
        this.retryWork = null;
        retry?.();
      });
    } else this.runCycle(epoch);
    return this.snapshot();
  }

  /**
   * Release the paused Run's idle native worker before Playground acquires
   * model resources. The resumed Run will prepare its provider afresh.
   */
  async preparePausedPlayground(): Promise<void> {
    await this.awaitShutdown();
    if (!this.canExecutePausedPlayground() || this.state.mode !== 'native') return;
    this.shutdownPromise = this.stopProvider(this.activeInference);
    await this.shutdownPromise;
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
        this.runPreferences.cycleIntervalMs,
        Math.round(this.smoothedMs ?? this.runPreferences.cycleIntervalMs),
      ),
    );
  }

  private splitScheduling(): SplitScheduling {
    const architecture = this.activeProfile?.values.architecture;
    const execution = architecture?.execution ?? 'sequential';
    return {
      execution,
      visionIntervalMs: architecture?.visionIntervalMs ?? this.runPreferences.cycleIntervalMs,
      chatIntervalMs: architecture?.chatIntervalMs ?? this.runPreferences.cycleIntervalMs,
      maximumWaitMs: architecture?.maximumWaitMs ?? 10000,
      maximumAgeMs: architecture?.maximumAgeMs ?? 30000,
      strictWait: architecture?.strictWait ?? execution === 'sequential',
    };
  }

  private stopSplitVisionLoop(): void {
    this.splitVisionAbort?.abort();
    this.splitVisionAbort = null;
    if (this.splitVisionTimer !== null) this.clock.clearTimeout(this.splitVisionTimer);
    this.splitVisionTimer = null;
  }

  /** Remote async Vision is sampled on its own clock, even while Chat is busy. */
  private startSplitVisionLoop(epoch: number): void {
    if (this.splitVisionAbort || !this.splitAdapters) return;
    const policy = this.splitScheduling();
    if (policy.execution !== 'asynchronous') return;
    const abort = new AbortController();
    this.splitVisionAbort = abort;
    const tick = () => {
      this.splitVisionTimer = null;
      if (!this.active(epoch) || abort.signal.aborted || this.eofRequested) return;
      if (this.pausedAt === null) {
        const cycle = this.state.cycle + 1;
        const now = this.observationNow();
        const chat = this.chat
          .snapshot()
          .messages.filter(
            (message) => Number(message.id.slice('chat-'.length)) > this.chatStartSequence,
          )
          .map((message) => ({
            ...message,
            presentedAt: this.observationTime(message.presentedAt),
          }));
        const snapshot = this.history.snapshot(
          this.context,
          cycle,
          now,
          this.playbackWindow(),
          chat,
          this.audience?.snapshot().members,
        );
        const media = this.video.sample(
          snapshot.boundary.fromMs,
          now,
          cycle === 1,
          this.runPreferences.videoMaxFrames,
        );
        const stageMedia = this.stageMedia(now, media);
        const input: CycleInput = {
          ...snapshot,
          captureSelection: {
            ...snapshot.captureSelection!,
            frames: stageMedia.frames.map((frame, index) => `${frame.sourceId}:${frame.observedAt}:${index}`),
            ...(stageMedia.chatFrames ? { chatFrames: stageMedia.chatFrames.map((frame, index) => `${frame.sourceId}:${frame.observedAt}:${index}`) } : {}),
          },
          chatActivity: this.runPreferences.chatActivity,
          ...stageMedia,
          seed: deriveInferenceSeed(this.state.sessionSeed!, 'cycle', cycle, 1),
        };
        void this.splitCoordinator.execute(
          input,
          this.splitAdapters!(input),
          abort.signal,
          () => this.waitUntilResumed(),
          this.activeProfile?.values.stageDefaults ?? {},
          policy,
          () => this.clock.now(),
          true,
        );
      }
      this.splitVisionTimer = this.clock.setTimeout(tick, Math.max(50, policy.visionIntervalMs));
    };
    tick();
  }

  private stageMedia(now: number, media: ReturnType<VideoFrameBuffer['sample']>) {
    const stages = this.activeProfile?.values.stageDefaults;
    const frames = stages?.observer?.frameSampling
      ? this.video.sampleStage(now, stages.observer.frameSampling, this.runPreferences.videoMaxFrames)
      : [...media.frames];
    const chatFrames = this.activeProfile?.values.topology === 'hybrid'
      ? this.video.sampleStage(now, stages?.chat?.frameSampling,
          Math.min(this.runPreferences.videoMaxFrames, this.activeProfile.values.architecture?.hybridMaxImages ?? 0))
      : [];
    const earliest = Math.min(media.fromMs, ...frames.map((f) => f.observedAt), ...chatFrames.map((f) => f.observedAt));
    const maxWindow = Math.max(stages?.observer?.frameSampling?.windowMs ?? 0,
      this.activeProfile?.values.topology === 'hybrid' ? stages?.chat?.frameSampling?.windowMs ?? 0 : 0);
    return {
      frames,
      ...(this.activeProfile?.values.topology === 'hybrid' ? { chatFrames } : {}),
      videoWindow: { fromMs: earliest, throughMs: media.throughMs,
        truncated: media.truncated || maxWindow > this.runPreferences.videoCoverageMs },
    };
  }

  private runCycle(epoch: number): void {
    if (!this.active(epoch)) return;
    if (this.pausedAt !== null) return;
    this.admitPendingProfile();
    const cycle = this.state.cycle + 1;
    this.cycleTranscriptRevision = this.transcriptRevision;
    const now = this.observationNow();
    const chat = this.chat
      .snapshot()
      .messages.filter(
        (message) => Number(message.id.slice('chat-'.length)) > this.chatStartSequence,
      )
      .map((message) => ({
        ...message,
        presentedAt: this.observationTime(message.presentedAt),
      }));
    const snapshot = this.history.snapshot(
      this.context,
      cycle,
      now,
      this.playbackWindow(),
      chat,
      this.audience?.snapshot().members,
    );
    const plan = chooseWorkload(
      this.runPreferences,
      this.state.mode === 'native' ? this.smoothedMs : null,
      this.state.mode === 'native' ? this.measuredResources : null,
    );
    const media = this.video.sample(
      snapshot.boundary.fromMs,
      now,
      cycle === 1,
      this.state.mode === 'native' ? plan.frameLimit : this.runPreferences.videoMaxFrames,
    );
    const stageMedia = this.stageMedia(now, media);
    const input: CycleInput = {
      ...snapshot,
      captureSelection: {
        ...snapshot.captureSelection!,
        frames: stageMedia.frames.map((frame, index) => `${frame.sourceId}:${frame.observedAt}:${index}`),
        ...(stageMedia.chatFrames ? { chatFrames: stageMedia.chatFrames.map((frame, index) => `${frame.sourceId}:${frame.observedAt}:${index}`) } : {}),
      },
      chatActivity: this.runPreferences.chatActivity,
      ...stageMedia,
    };
    this.refreshDropped();
    this.setState({
      cycle,
      retryAttempt: 0,
      warning: null,
      adaptiveFrameLimit: this.state.mode === 'native' ? plan.frameLimit : null,
      effectiveCycleMs:
        (this.state.inferenceProfile?.topology === 'split' || this.state.inferenceProfile?.topology === 'hybrid')
          ? this.splitScheduling().chatIntervalMs
          : this.state.mode === 'native'
            ? plan.minimumIntervalMs
            : this.runPreferences.cycleIntervalMs,
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
    this.attemptInFlight = true;
    const abort = new AbortController();
    this.abort = abort;
    const provider = this.activeInference;
    const attemptProfile = this.activeProfile ? structuredClone(this.activeProfile) : null;
    let inferenceStarted = this.clock.now();
    let inferenceCompleted = inferenceStarted;
    const sessionSeed = this.state.sessionSeed!;
    const seed = deriveInferenceSeed(sessionSeed, 'cycle', input.cycle, attempt);
    let effectiveInput: CycleInput = { ...input, seed };
    let rawOutput: unknown;
    let receivedOutput = false;
    const traceStarted = this.clock.now();
    const rosterSeed = deriveInferenceSeed(sessionSeed, 'roster', input.cycle, attempt);
    const traceId = this.trace.begin({
      runId: this.runId,
      cycle: input.cycle,
      attempt,
      seed,
      rosterSeed,
      mode: this.state.mode,
      modelId: this.state.modelId ?? null,
      startedAt: this.clock.wallNow(),
      input: effectiveInput,
      settings: this.runPreferences,
      promptPreset: this.state.promptPreset ?? null,
      adaptation: {
        frameLimit: this.state.adaptiveFrameLimit ?? null,
        effectiveCycleMs: this.state.effectiveCycleMs ?? null,
        reason: this.state.adaptationReason ?? null,
        videoWindow: input.videoWindow ?? null,
      },
    });
    const observer = (stage: 'request' | 'response' | 'normalized', value: unknown) => {
      if (stage === 'request') this.trace.update(traceId, { stage: 'transport', request: value });
      if (stage === 'response')
        this.trace.update(traceId, {
          stage: 'normalization',
          rawResponse: value,
          usage: traceUsage(value),
        });
      if (stage === 'normalized')
        this.trace.update(traceId, { stage: 'validation', normalized: value });
    };
    void Promise.resolve()
      .then(async () => {
        // A prior asynchronous stop must finish before this worker is reused.
        await this.shutdownPromise;
        if (!this.active(epoch) || abort.signal.aborted) return undefined;
        if (this.audience) {
          await this.audience.ensure(
            (this.state.inferenceProfile?.topology === 'split' || this.state.inferenceProfile?.topology === 'hybrid')
              ? (this.splitRosterProvider ?? provider)
              : provider,
            abort.signal,
            false,
            // A manual retry advances the cycle, so it must not replay the
            // previous failed roster generation's deterministic sampling seeds.
            rosterSeed,
          );
          effectiveInput = { ...effectiveInput, roster: this.audience.snapshot().members };
          this.trace.update(traceId, { input: effectiveInput });
        }
        if (!this.active(epoch) || abort.signal.aborted) return undefined;
        await provider.prepare?.(abort.signal);
        await this.waitUntilResumed();
        if (!this.active(epoch) || abort.signal.aborted) return undefined;
        if (this.state.phase === 'starting') this.setState({ phase: 'running' });
        if ((this.state.inferenceProfile?.topology === 'split' || this.state.inferenceProfile?.topology === 'hybrid')) this.startSplitVisionLoop(epoch);
        inferenceStarted = this.clock.now();
        this.setState({
          effectiveSeed: seed,
          recentAttemptSeeds: [
            ...(this.state.recentAttemptSeeds ?? []),
            { cycle: input.cycle, attempt, seed },
          ].slice(-24),
        });
        this.trace.update(traceId, { stage: 'transport' });
        const nativeProvider = provider as InferenceProvider & {
          completeSimulationRequest?: (
            input: CycleInput,
            request: unknown,
            signal: AbortSignal,
          ) => Promise<unknown>;
          supportsNativeVideo?: () => boolean;
          completeSimulationVideoWindow?: (
            input: CycleInput, request: unknown, signal: AbortSignal, window: ContinuousVideoWindow,
          ) => Promise<unknown>;
        };
        const nativeVideoWindow = this.state.mode === 'native' &&
          attemptProfile?.values.stageDefaults.unified?.videoInput === 'native' &&
          nativeProvider.supportsNativeVideo?.() && nativeProvider.completeSimulationVideoWindow
            ? selectContinuousVideoWindow(
                effectiveInput.frames ?? [],
                effectiveInput.videoWindow?.fromMs ?? effectiveInput.boundary?.fromMs ?? 0,
                effectiveInput.videoWindow?.throughMs ?? effectiveInput.boundary?.throughMs ?? 0,
                Math.min(this.runPreferences.videoCoverageMs, 15_000),
                this.runPreferences.videoMaxFrames,
              ) : null;
        const videoIdentity = nativeVideoWindow
          ? nativeVideoWindow.sourceId + ':' + nativeVideoWindow.fromMs + ':' + nativeVideoWindow.throughMs : undefined;
        const adapter =
          this.state.mode === 'remote' && (this.state.inferenceProfile?.topology !== 'split' && this.state.inferenceProfile?.topology !== 'hybrid')
            ? this.remoteAdapter!(effectiveInput)
            : nativeProvider.completeSimulationRequest
              ? llamaCppAdapter(
                  {
                    completeSimulationRequest: (selected, request, signal) =>
                      nativeVideoWindow
                        ? nativeProvider.completeSimulationVideoWindow!(
                            selected as CycleInput, request, signal, nativeVideoWindow,
                          )
                        : nativeProvider.completeSimulationRequest!(
                            selected as CycleInput, request, signal,
                          ),
                  },
                  effectiveInput,
                  videoIdentity ? { token: videoIdentity } : undefined,
                )
              : fixtureInferenceAdapter(provider, effectiveInput);
        if ((this.state.inferenceProfile?.topology === 'split' || this.state.inferenceProfile?.topology === 'hybrid')) {
          if (!this.splitAdapters) throw new Error('Split inference models are not configured.');
          const result = await this.splitCoordinator.execute(
            effectiveInput,
            this.splitAdapters(effectiveInput),
            abort.signal,
            () => this.waitUntilResumed(),
            attemptProfile?.values.stageDefaults ?? {},
            this.splitScheduling(),
            () => this.clock.now(),
          );
          if (!result) return undefined;
          inferenceCompleted = this.clock.now();
          receivedOutput = true;
          rawOutput = result.parsed;
          return {
            ...result,
            parsed: { ...result.parsed, events: [...result.visionEvents, ...result.parsed.events] },
          };
        }
        return this.coordinator.execute(effectiveInput, adapter, {
          signal: abort.signal,
          ...(videoIdentity ? { nativeVideoRef: videoIdentity } : {}),
          enforceAudience: Boolean(this.audience),
          beforeAccept: () => this.waitUntilResumed(),
          observe: observer,
          onParsed: (parsed) => this.trace.update(traceId, { stage: 'validation', parsed }),
          onTransport: (raw, normalized) => {
            inferenceCompleted = this.clock.now();
            rawOutput = normalized;
            receivedOutput = true;
            // Deterministic fixture providers may not send trace callbacks.
            if (this.trace.get(traceId)?.stage === 'transport') observer('normalized', normalized);
            if (this.state.mode === 'fake') this.trace.update(traceId, { rawResponse: raw });
          },
        });
      })
      .then(async (execution) => {
        await this.waitUntilResumed();
        if (!this.active(epoch) || abort.signal.aborted) return;
        if (!execution) {
          this.trace.update(traceId, {
            stage: 'cancelled',
            durationMs: Math.max(0, this.clock.now() - traceStarted),
          });
          this.abort = null;
          this.attemptInFlight = false;
          if (this.eofRequested) this.advanceRecordedEof();
          else
            this.scheduleCycle(
              epoch,
              (this.state.inferenceProfile?.topology === 'split' || this.state.inferenceProfile?.topology === 'hybrid')
                ? this.splitScheduling().chatIntervalMs
                : this.runPreferences.cycleIntervalMs,
              () => this.runCycle(epoch),
            );
          return;
        }
        const { parsed: result, accepted } = execution;
        this.trace.update(traceId, { stage: 'accepted', accepted });
        const resolved = accepted.messages;
        // All validation precedes every state change, history acknowledgement and playback.
        const duration = Math.max(0, inferenceCompleted - inferenceStarted);
        this.smoothedMs =
          this.smoothedMs === null
            ? duration
            : this.smoothedMs * (1 - SMOOTHING_WEIGHT) + duration * SMOOTHING_WEIGHT;
        this.diagnostics?.record(effectiveInput, duration, result, diagnosticToken);
        const windowMs = this.playbackWindow();
        const nextPlan = chooseWorkload(
          this.runPreferences,
          this.state.mode === 'native' ? this.smoothedMs : null,
          this.state.mode === 'native' ? this.measuredResources : null,
        );
        this.history.acknowledge(input.boundary);
        this.processedTranscriptRevision = this.cycleTranscriptRevision;
        const events = this.history.commitEvents(result.events, this.observationNow());
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
          this.state.mode !== 'fake' ? clipSimulationWindow(accepted, windowMs).messages : resolved;
        const enqueuedPhysicalAt = this.clock.wallNow();
        this.trace.update(traceId, {
          stage: 'scheduled',
          scheduled: {
            events: result.events,
            messages,
            windowMs,
            // Observation, scheduled and publication entries on the Inspector
            // axis all use virtual time for recorded playback.
            enqueuedAt: this.observationTime(enqueuedPhysicalAt),
            enqueuedPhysicalAt,
            clockDomain: this.state.inputMode === 'recorded' ? 'pause-adjusted' : 'physical',
          },
          durationMs: Math.max(0, this.clock.now() - traceStarted),
        });
        this.scheduler.enqueue(messages, this.clock.now(), traceId);
        this.abort = null;
        this.attemptInFlight = false;
        if (this.pausedAt !== null) this.setState({});
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
          ((this.state.inferenceProfile?.topology === 'split' || this.state.inferenceProfile?.topology === 'hybrid')
            ? this.splitScheduling().chatIntervalMs
            : this.state.mode === 'native'
              ? nextPlan.minimumIntervalMs
              : this.runPreferences.cycleIntervalMs) -
            (this.clock.now() - cycleStarted),
        );
        if (this.eofRequested) this.advanceRecordedEof();
        else this.scheduleCycle(epoch, delayMs, () => this.runCycle(epoch));
      })
      .catch(async (error: unknown) => {
        await this.waitUntilResumed();
        if (!this.active(epoch) || abort.signal.aborted) return;
        this.abort = null;
        this.attemptInFlight = false;
        const cause = error instanceof SimulationExecutionError ? error.cause : error;
        const message = cause instanceof Error ? cause.message : 'Unknown inference error.';
        const errorStage = traceFailureStage(this.trace.get(traceId));
        this.trace.update(traceId, {
          stage: 'failed',
          errorStage,
          error: message,
          durationMs: Math.max(0, this.clock.now() - traceStarted),
          ...(cause instanceof PrivateInferenceError
            ? {
                transportError: cause.diagnosticDetails,
                rawResponse:
                  (cause.diagnosticDetails as { responseBody?: unknown })?.responseBody ?? null,
              }
            : {}),
        });
        this.reportError?.('session', 'Inference attempt failed', cause, {
          cycle: input.cycle,
          attempt,
          seed,
          runId: this.runId,
          attemptId: traceId,
        });
        this.diagnostics?.record(
          effectiveInput,
          Math.max(0, this.clock.now() - inferenceStarted),
          receivedOutput
            ? { error: message, rawOutput }
            : cause instanceof PrivateInferenceError
              ? { error: message, privateProviderResponse: cause.diagnosticDetails }
              : { error: message },
          diagnosticToken,
        );
        const logEntry = `${new Date().toISOString()} · cycle ${input.cycle}, attempt ${attempt}, seed ${seed}: ${message}`;
        this.setState({ recentErrors: [...(this.state.recentErrors ?? []), logEntry].slice(-5) });
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
        const retry = () =>
          this.runAttempt(epoch, input, cycleStarted, attempt + 1, diagnosticToken);
        this.attemptInFlight = true; // Retry is accepted work, including during EOF draining.
        this.retryWork = retry;
        const stageDelay =
          (this.state.inferenceProfile?.topology === 'split' || this.state.inferenceProfile?.topology === 'hybrid')
            ? this.splitCoordinator.nextChatDelay(this.clock.now())
            : 0;
        this.scheduleCycle(epoch, Math.max(RETRY_BASE_MS * 2 ** (attempt - 1), stageDelay), () => {
          this.retryWork = null;
          retry();
        });
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
          this.reportError?.('session', 'Unable to stop inference provider', error);
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
    if (count === 0) this.advanceRecordedEof();
  }

  private setState(patch: Partial<Omit<SessionSnapshot, 'revision'>>): void {
    this.state = {
      ...this.state,
      // A fresh lifecycle phase always replaces the prior failure classification.
      ...(patch.phase ? { failureKind: patch.phase === 'error' ? 'inference' : null } : {}),
      ...patch,
      revision: this.state.revision + 1,
    };
    for (const listener of this.subscribers) listener(this.snapshot());
  }
}
