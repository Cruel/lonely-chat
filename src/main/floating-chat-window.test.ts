import { describe, expect, it, vi } from 'vitest';
import { ChatService, publishSample } from './chat-service';
import {
  FloatingChatWindowController,
  type FloatingChatWindow,
  type FloatingWindowOptions,
} from './floating-chat-window';
import { DEFAULT_FLOATING_CHAT_SETTINGS } from '../shared/floating-chat-contract';

class FakeWindow implements FloatingChatWindow {
  private events = new Map<string, Array<() => void>>();
  destroyed = false;
  readonly loaded: string[] = [];
  readonly setSize = vi.fn((width: number, height: number) => {
    this.size = [width, height];
    this.emit('resize');
  });
  readonly setAlwaysOnTop = vi.fn();
  size: [number, number];
  constructor(readonly options: FloatingWindowOptions) {
    this.size = [options.width, options.height];
  }
  on(event: 'closed' | 'resize', listener: () => void) {
    this.events.set(event, [...(this.events.get(event) ?? []), listener]);
  }
  emit(event: string) {
    for (const listener of this.events.get(event) ?? []) listener();
  }
  getSize(): [number, number] {
    return this.size;
  }
  isDestroyed() {
    return this.destroyed;
  }
  close() {
    this.destroy();
  }
  destroy() {
    this.destroyed = true;
    this.emit('closed');
  }
  async loadURL(url: string) {
    this.loaded.push(url);
  }
}

describe('floating chat window lifecycle', () => {
  const setup = () => {
    const windows: FakeWindow[] = [];
    const create = vi.fn((options: FloatingWindowOptions) => {
      const window = new FakeWindow(options);
      windows.push(window);
      return window;
    });
    const chat = new ChatService();
    const controller = new FloatingChatWindowController(
      create,
      () => 'http://127.0.0.1:45939/overlay',
    );
    return { controller, windows, create, chat };
  };

  it('uses one existing overlay URL, opens idempotently, closes independently and reopens from the current chat', () => {
    const { controller, windows, create, chat } = setup();
    publishSample(chat);
    expect(controller.open().open).toBe(true);
    expect(controller.open().open).toBe(true);
    expect(create).toHaveBeenCalledOnce();
    expect(windows[0].loaded).toEqual(['http://127.0.0.1:45939/overlay?background=opaque']);
    expect(controller.close().open).toBe(false);
    publishSample(chat);
    expect(chat.snapshot().sequence).toBe(2);
    controller.open();
    expect(windows[1].loaded).toEqual(windows[0].loaded);
    expect(chat.snapshot().messages).toHaveLength(2);
    expect(create).toHaveBeenCalledTimes(2);
    windows[1].close();
    expect(controller.snapshot().open).toBe(false);
    expect(chat.snapshot().sequence).toBe(2);
  });

  it('validates size and reuses window for size/topmost while rebuilding for frame/transparency', () => {
    const { controller, windows, create } = setup();
    expect(() => controller.configure({ ...DEFAULT_FLOATING_CHAT_SETTINGS, width: 20 })).toThrow(
      /Invalid/,
    );
    controller.open();
    controller.configure({
      ...DEFAULT_FLOATING_CHAT_SETTINGS,
      width: 500,
      height: 450,
      alwaysOnTop: true,
    });
    expect(create).toHaveBeenCalledOnce();
    expect(windows[0].setSize).toHaveBeenCalledWith(500, 450);
    expect(windows[0].setAlwaysOnTop).toHaveBeenCalledWith(true);
    windows[0].size = [510, 460];
    windows[0].emit('resize');
    expect(controller.snapshot().settings.width).toBe(510);
    const next = controller.configure({
      ...controller.snapshot().settings,
      transparent: true,
      decorated: false,
    });
    expect(next.open).toBe(true);
    expect(windows[0].destroyed).toBe(true);
    expect(windows[1].options).toMatchObject({
      transparent: true,
      frame: false,
      alwaysOnTop: true,
    });
    expect(windows[1].loaded[0]).toBe('http://127.0.0.1:45939/overlay');
  });

  it('reports closed state if a replacement window cannot be created', () => {
    const { controller, create } = setup();
    controller.open();
    const listener = vi.fn();
    controller.subscribe(listener);
    create.mockImplementationOnce(() => {
      throw new Error('unsupported transparent window');
    });
    create.mockImplementationOnce(() => {
      throw new Error('no window manager');
    });
    expect(() =>
      controller.configure({ ...DEFAULT_FLOATING_CHAT_SETTINGS, transparent: true }),
    ).toThrow('no window manager');
    expect(controller.snapshot()).toMatchObject({
      open: false,
      warning: expect.stringContaining('no window manager'),
    });
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ open: false }));
  });

  it('updates subscribers on external close and degrades when the platform rejects flags', () => {
    const { controller, windows, create } = setup();
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    controller.configure({ ...DEFAULT_FLOATING_CHAT_SETTINGS, transparent: true });
    create.mockImplementationOnce(() => {
      throw new Error('unsupported');
    });
    const status = controller.open();
    expect(status.open).toBe(true);
    expect(status.warning).toMatch(/rejected/);
    expect(windows[0].options.transparent).toBe(false);
    windows[0].close();
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ open: false }));
    unsubscribe();
    listener.mockClear();
    controller.open();
    expect(listener).not.toHaveBeenCalled();
  });
});
