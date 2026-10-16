import type { ChatService } from './chat-service';
import { ChatScheduler, systemClock, type TimerClock } from './chat-scheduler';
import { FakeInference, parseChatBatch, type InferenceProvider } from './fake-inference';
import {
  DEFAULT_PREFERENCES,
  validateContext,
  validatePreferences,
  type SessionPreferences,
  type SessionSnapshot,
} from '../shared/session-contract';

/**
 * Owns Start/Stop, one in-flight inference request, and all message presentation timers.
 * React and browser overlay are read-only projections of already-visible chat.
 */
export class SessionController {
  private state: SessionSnapshot = {
    revision: 0,
    phase: 'stopped',
    error: null,
    cycle: 0,
    pendingMessages: 0,
  };
  private subscribers = new Set<(snapshot: SessionSnapshot) => void>();
  private readonly scheduler: ChatScheduler;
  private epoch = 0;
  private abort: AbortController | null = null;
  private inferenceTimer: unknown = null;
  private preferences: SessionPreferences;
  private context = '';

  constructor(
    chat: ChatService,
    private readonly inference: InferenceProvider = new FakeInference(),
    private readonly clock: TimerClock = systemClock,
    initialPreferences: SessionPreferences = DEFAULT_PREFERENCES,
  ) {
    this.preferences = validatePreferences(initialPreferences);
    this.scheduler = new ChatScheduler(chat, clock, () => this.updatePending());
  }

  snapshot(): SessionSnapshot {
    return { ...this.state };
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

  start(rawContext: unknown): SessionSnapshot {
    if (this.state.phase === 'running') throw new Error('The simulation is already running.');
    const context = validateContext(rawContext);
    this.context = context;
    this.epoch++;
    this.scheduler.start();
    this.setState({ phase: 'running', cycle: 0, error: null });
    this.runCycle(this.epoch);
    return this.snapshot();
  }

  stop(): SessionSnapshot {
    this.epoch++;
    this.abort?.abort();
    this.abort = null;
    if (this.inferenceTimer !== null) this.clock.clearTimeout(this.inferenceTimer);
    this.inferenceTimer = null;
    this.scheduler.stop();
    this.context = '';
    this.setState({ phase: 'stopped', error: null });
    return this.snapshot();
  }

  private runCycle(epoch: number): void {
    if (epoch !== this.epoch || this.state.phase !== 'running') return;
    const cycle = this.state.cycle + 1;
    this.setState({ cycle });
    const abort = new AbortController();
    this.abort = abort;
    const started = this.clock.now();
    // Never launch an inference whose session has already been stopped or replaced.
    const context = this.context;
    void Promise.resolve()
      .then(() => {
        if (epoch !== this.epoch || abort.signal.aborted) return undefined;
        return this.inference.generate({ context, cycle }, abort.signal);
      })
      .then((raw) => {
        if (epoch !== this.epoch || this.state.phase !== 'running') return;
        const batch = parseChatBatch(raw);
        this.scheduler.enqueue(batch, this.clock.now());
        this.abort = null;
        const delay = Math.max(0, this.preferences.cycleIntervalMs - (this.clock.now() - started));
        this.inferenceTimer = this.clock.setTimeout(() => {
          this.inferenceTimer = null;
          this.runCycle(epoch);
        }, delay);
      })
      .catch((error: unknown) => {
        if (epoch !== this.epoch || this.state.phase !== 'running') return;
        this.abort = null;
        this.scheduler.stop();
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
