import { describe, expect, it, vi } from 'vitest';
import {
  DesktopLifecycle,
  type MainWindowAdapter,
  type TrayAdapter,
  type TrayAction,
} from './desktop-lifecycle';
import { ChatService, publishSample } from './chat-service';

class WindowAdapter implements MainWindowAdapter {
  private closeHandler: ((event: { preventDefault(): void }) => void) | null = null;
  private closedHandler: (() => void) | null = null;
  destroyed = false;
  visible = true;
  hide = vi.fn(() => {
    this.visible = false;
  });
  show = vi.fn(() => {
    this.visible = true;
  });
  focus = vi.fn();
  isDestroyed() {
    return this.destroyed;
  }
  on(event: 'close' | 'closed', handler: any) {
    if (event === 'close') this.closeHandler = handler;
    else this.closedHandler = handler;
  }
  close() {
    let prevented = false;
    this.closeHandler?.({
      preventDefault() {
        prevented = true;
      },
    });
    if (!prevented) {
      this.destroyed = true;
      this.closedHandler?.();
    }
    return prevented;
  }
}

class TrayAdapterMock implements TrayAdapter {
  actions: TrayAction[] = [];
  private clickHandler: (() => void) | undefined;
  destroy = vi.fn();
  setActions(actions: TrayAction[]) {
    this.actions = actions;
  }
  onClick(listener: () => void) {
    this.clickHandler = listener;
  }
  click() {
    this.clickHandler?.();
  }
  select(label: string) {
    const action = this.actions.find((item) => item.label === label);
    if (!action || !action.enabled) throw new Error('Unavailable action: ' + label);
    action.action();
  }
}

describe('main window and system tray lifecycle', () => {
  function setup(trayFails = false) {
    const window = new WindowAdapter();
    const tray = new TrayAdapterMock();
    const chat = new ChatService();
    let running = false;
    let quitCount = 0;
    const stop = vi.fn(() => {
      running = false;
    });
    const showNew = vi.fn();
    const report = vi.fn();
    const createTray = vi.fn(() => {
      if (trayFails) throw new Error('unavailable tray');
      return tray;
    });
    const lifecycle = new DesktopLifecycle(
      createTray,
      () => running,
      stop,
      () => {
        quitCount++;
      },
      showNew,
      report,
    );
    return {
      window,
      tray,
      chat,
      lifecycle,
      createTray,
      report,
      stop,
      showNew,
      get quits() {
        return quitCount;
      },
      setRunning(value: boolean) {
        running = value;
        lifecycle.refreshTray();
      },
    };
  }

  it('keeps the one live chat stream and floating/browser presentations independent while main hides/reopens', () => {
    const app = setup();
    app.lifecycle.initialize(true);
    app.lifecycle.attach(app.window);
    app.setRunning(true);
    publishSample(app.chat);
    expect(app.window.close()).toBe(true);
    expect(app.window.visible).toBe(false);
    expect(app.quits).toBe(0);
    publishSample(app.chat);
    app.tray.select('Show');
    expect(app.window.visible).toBe(true);
    expect(app.window.focus).toHaveBeenCalledOnce();
    app.tray.click();
    expect(app.window.show).toHaveBeenCalledTimes(2);
    expect(app.chat.snapshot().messages).toHaveLength(2);
    expect(app.createTray).toHaveBeenCalledOnce();
    expect(app.showNew).not.toHaveBeenCalled();
  });

  it('can stop simulation from tray, then exits on close instead of hiding', () => {
    const app = setup();
    app.lifecycle.initialize(true);
    app.lifecycle.attach(app.window);
    app.setRunning(true);
    expect(app.tray.actions.map((item) => item.label)).toEqual(['Show', 'Stop Simulation', 'Quit']);
    app.tray.select('Stop Simulation');
    expect(app.stop).toHaveBeenCalledOnce();
    app.lifecycle.refreshTray();
    expect(app.tray.actions[1].enabled).toBe(false);
    expect(app.window.close()).toBe(false);
    expect(app.quits).toBe(1);
  });

  it('respects close-to-tray being disabled and never hides a main window without usable tray', () => {
    const app = setup();
    app.lifecycle.initialize(false);
    app.lifecycle.attach(app.window);
    app.setRunning(true);
    expect(app.window.close()).toBe(false);
    expect(app.quits).toBe(1);

    const unavailable = setup(true);
    unavailable.lifecycle.initialize(true);
    unavailable.lifecycle.attach(unavailable.window);
    unavailable.setRunning(true);
    expect(unavailable.report).toHaveBeenCalledOnce();
    expect(unavailable.window.close()).toBe(false);
    expect(unavailable.quits).toBe(1);
  });

  it('does not hide when the window manager creates a tray but rejects its menu', () => {
    const app = setup();
    app.tray.setActions = () => {
      throw new Error('menu unsupported');
    };
    app.lifecycle.initialize(true);
    app.lifecycle.attach(app.window);
    app.setRunning(true);
    expect(app.tray.destroy).toHaveBeenCalledOnce();
    expect(app.lifecycle.hasTray).toBe(false);
    expect(app.report).toHaveBeenCalled();
    expect(app.window.close()).toBe(false);
    expect(app.quits).toBe(1);
  });

  it('can still quit if tray destruction itself fails', () => {
    const app = setup();
    app.lifecycle.initialize(true);
    app.lifecycle.attach(app.window);
    app.tray.destroy.mockImplementationOnce(() => {
      throw new Error('tray lost');
    });
    app.tray.select('Quit');
    expect(app.quits).toBe(1);
    expect(app.lifecycle.hasTray).toBe(false);
    expect(app.report).toHaveBeenCalledOnce();
  });

  it('supports repeated hide/show and destroys the tray exactly once on explicit Quit', () => {
    const app = setup();
    app.lifecycle.initialize(true);
    app.lifecycle.attach(app.window);
    app.setRunning(true);
    for (let index = 0; index < 3; index++) {
      expect(app.window.close()).toBe(true);
      app.tray.select('Show');
    }
    app.tray.select('Quit');
    expect(app.quits).toBe(1);
    expect(app.tray.destroy).toHaveBeenCalledOnce();
    expect(app.window.close()).toBe(false);
    expect(app.quits).toBe(1);
    app.lifecycle.beginShutdown();
    expect(app.tray.destroy).toHaveBeenCalledOnce();
  });

  it('can re-enable tray and can reopen a destroyed main window without duplicate tray setup', () => {
    const app = setup();
    app.lifecycle.initialize(true);
    app.lifecycle.setCloseToTray(false);
    expect(app.tray.destroy).toHaveBeenCalledOnce();
    app.lifecycle.setCloseToTray(true);
    app.lifecycle.attach(app.window);
    app.lifecycle.beginShutdown();
    app.window.close();
    app.lifecycle.show();
    expect(app.showNew).not.toHaveBeenCalled();
    // A fresh policy instance with no attached main window needs exactly one new window.
    const newSession = setup();
    newSession.lifecycle.initialize(true);
    newSession.lifecycle.show();
    expect(newSession.showNew).toHaveBeenCalledOnce();
  });
});
