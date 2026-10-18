import {
  DEFAULT_OVERLAY_PORT,
  validateOverlayPort,
  type OverlayStatus,
} from '../shared/overlay-contract';
import type { OverlayPortStore } from './overlay-port-store';
import type { OperationalErrorSink } from './operational-logger';

interface OverlayListener {
  start(port: number): Promise<string>;
  stop(): Promise<void>;
}

/** Overlay availability is independent of desktop startup and simulation. */
export class OverlayController {
  private server: OverlayListener | null = null;
  private status: OverlayStatus = { port: DEFAULT_OVERLAY_PORT, url: null, error: null };
  private listeners = new Set<(status: OverlayStatus) => void>();
  private operations: Promise<void> = Promise.resolve();

  constructor(
    private readonly create: () => OverlayListener,
    private readonly store: OverlayPortStore,
    private readonly reportError?: OperationalErrorSink,
  ) {}

  snapshot(): OverlayStatus {
    return { ...this.status };
  }

  subscribe(listener: (status: OverlayStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(status: OverlayStatus): OverlayStatus {
    this.status = status;
    for (const listener of this.listeners) listener(this.snapshot());
    return this.snapshot();
  }

  private async bind(port: number, persist: boolean): Promise<OverlayStatus> {
    const next = this.create();
    let url: string;
    try {
      url = await next.start(port);
      if (persist) await this.store.write(port);
    } catch (error) {
      await next.stop();
      const reason = error instanceof Error ? error.message : String(error);
      const detail =
        (error as NodeJS.ErrnoException)?.code === 'EADDRINUSE'
          ? `Port ${port} is already in use or reserved. Choose another port in Settings.`
          : `Unable to start overlay on port ${port}: ${reason}`;
      return this.publish({ ...this.status, error: detail });
    }
    const previous = this.server;
    this.server = next;
    this.publish({ port, url, error: null });
    if (previous) await previous.stop();
    return this.snapshot();
  }

  async initialize(override?: string): Promise<OverlayStatus> {
    let port = DEFAULT_OVERLAY_PORT;
    try {
      port = await this.store.read();
    } catch (error) {
      this.reportError?.('overlay', 'Unable to load overlay port setting; using default', error);
    }
    if (override !== undefined) {
      try {
        port = validateOverlayPort(Number(override));
      } catch {
        this.reportError?.('overlay', 'Invalid LONELY_CHAT_OVERLAY_PORT; using saved port');
      }
    }
    this.status = { port, url: null, error: null };
    return this.bind(port, false);
  }

  async configure(value: unknown): Promise<OverlayStatus> {
    const port = validateOverlayPort(value);
    const update = this.operations.then(async () => {
      if (this.status.port === port && this.server) {
        return this.publish({ ...this.status, error: null });
      }
      return this.bind(port, true);
    });
    this.operations = update.then(
      () => {},
      () => {},
    );
    return update;
  }

  async stop(): Promise<void> {
    await this.operations;
    const previous = this.server;
    this.server = null;
    if (previous) await previous.stop();
    this.publish({ ...this.status, url: null });
  }
}
