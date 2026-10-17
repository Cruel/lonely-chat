import {
  DEFAULT_FLOATING_CHAT_SETTINGS,
  FLOATING_CHAT_BOUNDS,
  validateFloatingChatSettings,
  type FloatingChatSettings,
  type FloatingChatSnapshot,
} from '../shared/floating-chat-contract';

/** Minimal window adapter; real Electron and test doubles both implement this seam. */
export interface FloatingChatWindow {
  on(event: 'closed' | 'resize', callback: () => void): void;
  isDestroyed(): boolean;
  close(): void;
  destroy(): void;
  setSize(width: number, height: number): void;
  getSize(): number[];
  setAlwaysOnTop(value: boolean): void;
  loadURL(url: string): Promise<unknown>;
}

export interface FloatingWindowOptions {
  width: number;
  height: number;
  transparent: boolean;
  frame: boolean;
  alwaysOnTop: boolean;
}

export class FloatingChatWindowController {
  private window: FloatingChatWindow | null = null;
  private settings: FloatingChatSettings = { ...DEFAULT_FLOATING_CHAT_SETTINGS };
  private warning: string | null = null;
  private listeners = new Set<(state: FloatingChatSnapshot) => void>();

  constructor(
    private readonly create: (options: FloatingWindowOptions) => FloatingChatWindow,
    private readonly overlayUrl: () => string,
  ) {}

  snapshot(): FloatingChatSnapshot {
    return { open: !!this.window, settings: { ...this.settings }, warning: this.warning };
  }

  subscribe(listener: (state: FloatingChatSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): FloatingChatSnapshot {
    const state = this.snapshot();
    for (const listener of this.listeners) listener(state);
    return state;
  }

  open(): FloatingChatSnapshot {
    if (this.window) return this.snapshot();
    this.warning = null;
    let options: FloatingWindowOptions = {
      width: this.settings.width,
      height: this.settings.height,
      transparent: this.settings.transparent,
      frame: this.settings.decorated,
      alwaysOnTop: this.settings.alwaysOnTop,
    };
    let window: FloatingChatWindow;
    try {
      window = this.create(options);
    } catch (error) {
      // Transparent and always-on-top creation can be unavailable on some WMs.
      // Retry with safe standard flags, without changing the requested settings.
      if (!options.transparent && !options.alwaysOnTop) throw error;
      options = { ...options, transparent: false, alwaysOnTop: false };
      window = this.create(options);
      this.warning =
        'Window manager rejected a presentation flag; opened without transparency or always-on-top.';
    }
    this.window = window;
    window.on('closed', () => {
      if (this.window !== window) return;
      this.window = null;
      this.notify();
    });
    window.on('resize', () => {
      if (this.window !== window || window.isDestroyed()) return;
      const [width = this.settings.width, height = this.settings.height] = window.getSize();
      // Window managers may report sizes outside the app's supported inputs.
      this.settings = {
        ...this.settings,
        width: Math.max(
          FLOATING_CHAT_BOUNDS.minWidth,
          Math.min(FLOATING_CHAT_BOUNDS.maxWidth, width),
        ),
        height: Math.max(
          FLOATING_CHAT_BOUNDS.minHeight,
          Math.min(FLOATING_CHAT_BOUNDS.maxHeight, height),
        ),
      };
      this.notify();
    });
    // A newly opened window is a read-only WebSocket client: never add a
    // preload, IPC bridge, chat service, or independent scheduler to it.
    const url = new URL(this.overlayUrl());
    if (!options.transparent) url.searchParams.set('background', 'opaque');
    void window.loadURL(url.href).catch((error: unknown) => {
      if (this.window !== window) return;
      this.warning = `Unable to load chat overlay: ${String(error)}`;
      this.notify();
    });
    return this.notify();
  }

  close(): FloatingChatSnapshot {
    const window = this.window;
    if (!window) return this.snapshot();
    this.window = null;
    window.close();
    return this.notify();
  }

  configure(settings: FloatingChatSettings): FloatingChatSnapshot {
    const next = validateFloatingChatSettings(settings);
    const previous = this.settings;
    this.settings = next;
    this.warning = null;
    const window = this.window;
    if (!window) return this.notify();
    if (next.transparent !== previous.transparent || next.decorated !== previous.decorated) {
      // Electron can only change frame/transparency by replacing BrowserWindow.
      this.window = null;
      window.destroy();
      try {
        return this.open();
      } catch (error) {
        this.warning = `Unable to reopen the floating window: ${String(error)}`;
        this.notify();
        throw error;
      }
    }
    try {
      if (next.width !== previous.width || next.height !== previous.height)
        window.setSize(next.width, next.height);
      if (next.alwaysOnTop !== previous.alwaysOnTop) window.setAlwaysOnTop(next.alwaysOnTop);
    } catch (error) {
      this.warning = `Window manager could not apply a setting: ${String(error)}`;
    }
    return this.notify();
  }
}
