import type { ChatService } from './chat-service';
import { ChatScheduler, systemClock, type TimerClock } from './chat-scheduler';
import { FakeInference, parseInferenceResult, type InferenceProvider } from './fake-inference';
import {
  DEFAULT_PREFERENCES,
  validateContext,
  validatePreferences,
  type InferenceMode,
  type SessionPreferences,
  type SessionSnapshot,
} from '../shared/session-contract';

/** Owns lifecycle, event history and scheduled chat, independent of renderer windows. */
export class SessionController {
  private state: SessionSnapshot = {
    revision: 0,
    phase: 'stopped',
    error: null,
    cycle: 0,
    pendingMessages: 0,
    mode: 'fake',
    events: [],
  };
  private subscribers = new Set<(snapshot: SessionSnapshot) => void>();
  private readonly scheduler: ChatScheduler;
  private epoch = 0;
  private abort: AbortController | null = null;
  private inferenceTimer: unknown = null;
  private preferences: SessionPreferences;
  private context = '';
  private activeInference: InferenceProvider;
  private shutdownPromise: Promise<void> = Promise.resolve();

  constructor(
    chat: ChatService,
    private readonly inference: InferenceProvider = new FakeInference(),
    private readonly clock: TimerClock = systemClock,
    initialPreferences: SessionPreferences = DEFAULT_PREFERENCES,
    private readonly nativeInference?: InferenceProvider,
  ) {
    this.activeInference = inference;
    this.preferences = validatePreferences(initialPreferences);
    this.scheduler = new ChatScheduler(chat, clock, () => this.updatePending());
  }

  snapshot(): SessionSnapshot {
    return { ...this.state, events: [...this.state.events] };
  }

  getPreferences(): SessionPreferences {
    return { ...this.preferences };
  }

  setPreferences(value: unknown): SessionPreferences {
    this.preferences = validatePreferences(value);
    return this.getPreferences();
  }

  subscribe(listener: (snapshot: SessionSnapshot) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  start(rawContext: unknown, mode: InferenceMode = 'fake'): SessionSnapshot {
    if (this.state.phase === 'running' || this.state.phase === 'starting') {
      throw new Error('The simulation is already running.');
    }
    const context = validateContext(rawContext);
    if (mode !== 'fake' && mode !== 'native') throw new Error('Unknown inference mode.');
    if (mode === 'native' && !this.nativeInference) {
      throw new Error('The native inference runtime is not configured.');
    }
    this.activeInference = mode === 'native' ? this.nativeInference! : this.inference;
    this.context = context;
    this.epoch++;
    this.scheduler.start();
    this.setState({
      phase: mode === 'native' ? 'starting' : 'running',
      mode,
      events: [],
      cycle: 0,
      error: null,
    });
    this.runCycle(this.epoch);
    return this.snapshot();
  }

  stop(): SessionSnapshot {
    this.epoch++;
    this.abort?.abort();
    this.shutdownPromise = Promise.resolve(this.activeInference.stop?.());
    this.abort = null;
    if (this.inferenceTimer !== null) this.clock.clearTimeout(this.inferenceTimer);
    this.inferenceTimer = null;
    this.scheduler.stop();
    this.context = '';
    this.setState({ phase: 'stopped', error: null });
    return this.snapshot();
  }

  async terminate(): Promise<void> {
    this.stop();
    await this.shutdownPromise;
  }

  private runCycle(epoch: number): void {
    if (epoch !== this.epoch || (this.state.phase !== 'running' && this.state.phase !== 'starting'))
      return;
    const cycle = this.state.cycle + 1;
    this.setState({ cycle });
    const abort = new AbortController();
    this.abort = abort;
    const started = this.clock.now();
    const context = this.context;
    const provider = this.activeInference;
    void Promise.resolve()
      .then(async () => {
        if (epoch !== this.epoch || abort.signal.aborted) return undefined;
        await provider.prepare?.(abort.signal);
        if (epoch !== this.epoch || abort.signal.aborted) return undefined;
        if (this.state.phase === 'starting') this.setState({ phase: 'running' });
        return provider.generate({ context, cycle, recentEvents: this.state.events }, abort.signal);
      })
      .then((raw) => {
        if (epoch !== this.epoch || this.state.phase !== 'running') return;
        const result = parseInferenceResult(raw, this.clock.wallNow());
        // Validate both collections before committing either one.
        if (result.events.length) {
          this.setState({ events: [...this.state.events, ...result.events].slice(-32) });
        }
        this.scheduler.enqueue(result.messages, this.clock.now());
        this.abort = null;
        const delayMs = Math.max(
          0,
          this.preferences.cycleIntervalMs - (this.clock.now() - started),
        );
        this.inferenceTimer = this.clock.setTimeout(() => {
          this.inferenceTimer = null;
          this.runCycle(epoch);
        }, delayMs);
      })
      .catch((error: unknown) => {
        if (
          epoch !== this.epoch ||
          (this.state.phase !== 'running' && this.state.phase !== 'starting')
        )
          return;
        this.abort = null;
        // A rejected cycle cannot revoke already-validated messages from prior cycles.
        // Those scheduled messages may finish displaying until the user explicitly stops.
        void provider.stop?.();
        this.context = '';
        this.setState({
          phase: 'error',
          error: error instanceof Error ? error.message : 'Unknown inference error.',
        });
      });
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
