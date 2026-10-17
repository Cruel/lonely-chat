/** Explicit Quit owns teardown; closing or hiding a presentation window does not. */
export class ManagedShutdown {
  private task: Promise<void> | null = null;

  constructor(
    private readonly stopPlayback: () => void,
    private readonly abortDownloadsAndRoster: () => void,
    private readonly closeFloating: () => void,
    private readonly services: ReadonlyArray<() => Promise<unknown>>,
    private readonly logFailure: (reason: unknown) => void,
  ) {}

  stop(): Promise<void> {
    if (this.task) return this.task;
    // Synchronous cancellation is done before awaiting any child exits, so
    // no more chat is published while workers and local ports are retiring.
    try {
      this.stopPlayback();
    } catch (error) {
      this.logFailure(error);
    }
    try {
      this.abortDownloadsAndRoster();
    } catch (error) {
      this.logFailure(error);
    }
    try {
      this.closeFloating();
    } catch (error) {
      this.logFailure(error);
    }
    this.task = Promise.allSettled(
      this.services.map((service) => Promise.resolve().then(service)),
    ).then((results) => {
      for (const result of results)
        if (result.status === 'rejected') this.logFailure(result.reason);
    });
    return this.task;
  }
}
