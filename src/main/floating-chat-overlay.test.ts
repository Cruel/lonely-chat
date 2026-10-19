import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { ChatService, publishSample } from './chat-service';
import {
  FloatingChatWindowController,
  type FloatingChatWindow,
  type FloatingWindowOptions,
} from './floating-chat-window';
import { OverlayServer } from './overlay-server';
import type { ChatEvent } from '../shared/chat-contract';

/** Simulates the capture window's unprivileged /overlay WebSocket client. */
class CaptureWindow implements FloatingChatWindow {
  events: ChatEvent[] = [];
  socket: WebSocket | null = null;
  private callbacks: (() => void)[] = [];
  destroyed = false;
  constructor(readonly options: FloatingWindowOptions) {}
  on(event: 'closed' | 'resize', callback: () => void) {
    if (event === 'closed') this.callbacks.push(callback);
  }
  isDestroyed() {
    return this.destroyed;
  }
  getSize() {
    return [this.options.width, this.options.height];
  }
  setSize() {}
  setAlwaysOnTop() {}
  close() {
    this.destroy();
  }
  destroy() {
    this.destroyed = true;
    this.socket?.close();
    for (const callback of this.callbacks) callback();
  }
  async loadURL(url: string) {
    const endpoint = new URL('/overlay/live', url);
    this.socket = new WebSocket(endpoint, { origin: new URL(url).origin });
    this.socket.on('message', (buffer) =>
      this.events.push(JSON.parse(buffer.toString()) as ChatEvent),
    );
    await once(this.socket, 'open');
  }
}

describe('one authoritative chat across overlay and capture clients', () => {
  const directoryCleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(directoryCleanup.splice(0).map((cleanup) => cleanup()));
  });

  it('delivers identical snapshot and sequence on open, and current history on reopen', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'lonely-floating-test-'));
    await writeFile(path.join(directory, 'index.html'), '<html>overlay</html>');
    const chat = new ChatService();
    const server = new OverlayServer(chat, directory);
    directoryCleanup.push(async () => {
      await server.stop();
      await rm(directory, { recursive: true, force: true });
    });
    const url = await server.start();
    const windows: CaptureWindow[] = [];
    const floating = new FloatingChatWindowController(
      (options) => {
        const window = new CaptureWindow(options);
        windows.push(window);
        return window;
      },
      () => url,
    );
    publishSample(chat);
    floating.open();
    const browser = new WebSocket(new URL('/overlay/live', url), { origin: new URL(url).origin });
    const browserEvents: ChatEvent[] = [];
    browser.on('message', (buffer) =>
      browserEvents.push(JSON.parse(buffer.toString()) as ChatEvent),
    );
    await once(browser, 'open');
    await waitFor(() => windows[0].events.length === 1 && browserEvents.length === 1);
    expect(windows[0].events).toEqual(browserEvents);
    publishSample(chat);
    publishSample(chat);
    await waitFor(() => windows[0].events.length === 3 && browserEvents.length === 3);
    expect(windows[0].events).toEqual(browserEvents);
    expect(windows[0].events.map((event) => event.sequence)).toEqual([1, 2, 3]);

    floating.close();
    publishSample(chat);
    floating.open();
    await waitFor(() => windows[1].events.length === 1);
    expect(windows[1].events[0]).toEqual(chat.snapshot());
    expect(windows[1].events[0]).toMatchObject({ sequence: 4, type: 'snapshot' });
    expect(chat.snapshot().sequence).toBe(4);
    browser.close();
    await once(browser, 'close');
    floating.close();
  });

  it('delivers a particular marker and closes while simulation messages arrive concurrently', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'lonely-floating-test-'));
    await writeFile(path.join(directory, 'index.html'), '<html>overlay</html>');
    const chat = new ChatService();
    const server = new OverlayServer(chat, directory);
    directoryCleanup.push(async () => {
      await server.stop();
      await rm(directory, { recursive: true, force: true });
    });
    const url = await server.start();
    let capture: CaptureWindow | null = null;
    const floating = new FloatingChatWindowController(
      (options) => {
        capture = new CaptureWindow(options);
        return capture;
      },
      () => url,
    );
    expect(floating.open().open).toBe(true);
    await waitFor(() => capture !== null && capture.events.length === 1);

    const sample = chat.publish({
      author: 'smoke-test',
      text: 'Floating capture delivery marker',
      color: '#ffffff',
    });
    // The scheduled Simulation remains active while the smoke test waits for
    // the marker. It must not make a global sequence-delta check fail.
    chat.publish({ author: 'simulation', text: 'A concurrent message', color: '#ffffff' });
    await waitFor(
      () =>
        capture !== null &&
        capture.events.some((event) => event.type === 'append' && event.message.id === sample.id),
    );
    expect(chat.snapshot().sequence).toBe(2);
    expect(capture!.events).toContainEqual({ type: 'append', sequence: 1, message: sample });
    expect(floating.close().open).toBe(false);
    expect(capture!.destroyed).toBe(true);
    expect(chat.snapshot().messages).toContainEqual(sample);
  });
});

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for overlay updates');
}
