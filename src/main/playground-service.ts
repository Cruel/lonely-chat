import type {
  FreeformRequest,
  FreeformResult,
  PlaygroundStatus,
} from '../shared/playground-contract';
import { validateFreeformRequest } from '../shared/playground-contract';

export interface PlaygroundProvider {
  completeFreeform(
    request: FreeformRequest,
    signal: AbortSignal,
  ): Promise<Omit<FreeformResult, 'modelId' | 'request'>>;
  stop(): Promise<void>;
}

/**
 * One exclusive, ephemeral native worker at a time. Read-only with respect to
 * SessionController, ChatService, AudienceService and diagnostic capture.
 */
export class PlaygroundService {
  private active: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private listeners = new Set<(status: PlaygroundStatus) => void>();

  constructor(
    private readonly canRun: () => boolean,
    private readonly makeProvider: (modelId: string) => PlaygroundProvider,
    private readonly beforeRun: () => Promise<void> = async () => {},
  ) {}

  get busy(): boolean {
    return this.active !== null;
  }
  snapshot(): PlaygroundStatus {
    return { busy: this.busy };
  }
  subscribe(listener: (status: PlaygroundStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private notify(): void {
    for (const listener of this.listeners) listener(this.snapshot());
  }

  run(input: unknown): Promise<FreeformResult> {
    const request = validateFreeformRequest(input);
    if (this.busy) throw new Error('Another Playground inference is in progress.');
    if (!this.canRun())
      throw new Error(
        'Stop Simulation and other native model operations before running Playground.',
      );
    const abort = new AbortController();
    this.abort = abort;
    // Acquire the lock synchronously, before any await or provider work.
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    this.active = done;
    this.notify();
    return (async () => {
      let provider: PlaygroundProvider | null = null;
      try {
        await this.beforeRun();
        if (!this.canRun() || abort.signal.aborted)
          throw new Error('Playground inference cancelled or Simulation became active.');
        provider = this.makeProvider(request.modelId);
        const result = await provider.completeFreeform(request, abort.signal);
        return { ...result, modelId: request.modelId, request };
      } finally {
        try {
          await provider?.stop();
        } finally {
          this.abort = null;
          this.active = null;
          resolveDone();
          this.notify();
        }
      }
    })();
  }

  async stop(): Promise<void> {
    this.abort?.abort();
    await this.active;
  }
}
