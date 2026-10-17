/** Main-window and tray policy. No simulation scheduler or overlay ownership. */
export interface MainWindowAdapter {
  on(event: 'close', listener: (event: { preventDefault(): void }) => void): void;
  on(event: 'closed', listener: () => void): void;
  hide(): void;
  show(): void;
  focus(): void;
  isDestroyed(): boolean;
}

export interface TrayAction {
  label: string;
  enabled: boolean;
  action(): void;
}

export interface TrayAdapter {
  setActions(actions: TrayAction[]): void;
  onClick(listener: () => void): void;
  destroy(): void;
}

export class DesktopLifecycle {
  private main: MainWindowAdapter | null = null;
  private tray: TrayAdapter | null = null;
  private closeToTray = true;
  private exiting = false;
  private shuttingDown = false;

  constructor(
    private readonly createTray: () => TrayAdapter,
    private readonly active: () => boolean,
    private readonly stopSimulation: () => void,
    private readonly requestQuit: () => void,
    private readonly openMain: () => void,
    private readonly report: (error: unknown) => void,
  ) {}

  initialize(closeToTray: boolean): void {
    this.setCloseToTray(closeToTray);
  }

  setCloseToTray(value: boolean): boolean {
    this.closeToTray = value;
    if (!value) {
      this.disposeTray();
      return false;
    }
    if (!this.tray && !this.shuttingDown) {
      try {
        const tray = this.createTray();
        tray.onClick(() => this.show());
        this.tray = tray;
      } catch (error) {
        // Unsupported desktop environments must not strand an invisible window.
        this.report(error);
      }
    }
    this.refreshTray();
    return this.tray !== null;
  }

  attach(window: MainWindowAdapter): void {
    this.main = window;
    window.on('close', (event) => {
      if (this.shuttingDown || this.exiting) return;
      if (this.closeToTray && this.tray && this.active()) {
        event.preventDefault();
        window.hide();
      }
    });
    window.on('closed', () => {
      if (this.main !== window) return;
      this.main = null;
      if (!this.shuttingDown && !this.exiting) {
        this.exiting = true;
        this.requestQuit();
      }
    });
  }

  refreshTray(): void {
    const tray = this.tray;
    if (!tray) return;
    try {
      tray.setActions([
        { label: 'Show', enabled: true, action: () => this.show() },
        {
          label: 'Stop Simulation',
          enabled: this.active(),
          action: () => {
            if (this.active()) this.stopSimulation();
            this.refreshTray();
          },
        },
        {
          label: 'Quit',
          enabled: true,
          action: () => {
            this.beginShutdown();
            this.requestQuit();
          },
        },
      ]);
    } catch (error) {
      // Some Linux/desktop environments instantiate Tray but reject its menu.
      // In that case never enable close-to-tray without an accessible Show action.
      this.tray = null;
      try {
        tray.destroy();
      } catch (destroyError) {
        this.report(destroyError);
      }
      this.report(error);
    }
  }

  show(): void {
    if (this.shuttingDown) return;
    if (this.main && !this.main.isDestroyed()) {
      this.main.show();
      this.main.focus();
    } else {
      this.openMain();
    }
  }

  beginShutdown(): void {
    this.shuttingDown = true;
    this.disposeTray();
  }

  private disposeTray(): void {
    const tray = this.tray;
    this.tray = null;
    try {
      tray?.destroy();
    } catch (error) {
      this.report(error);
    }
  }

  get hasTray(): boolean {
    return this.tray !== null;
  }
}
