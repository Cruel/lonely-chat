import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { AudienceService } from './audience-service';
import { ChatService } from './chat-service';
import { SessionController } from './session-controller';
import { OverlayServer } from './overlay-server';
import { FloatingChatWindowController, type FloatingChatWindow } from './floating-chat-window';
import { FakeClock, flushMicrotasks } from './test-support/fake-clock';
import { FakeInference, type InferenceInput, type InferenceProvider } from './fake-inference';
import { AUTHOR_PLACEHOLDER } from '../shared/audience-contract';
import { DEFAULT_PREFERENCES } from '../shared/session-contract';
import type { ChatEvent } from '../shared/chat-contract';

const jpeg = 'data:image/jpeg;base64,/9j/';
const folders: string[] = [];

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Certification output did not arrive');
}

class CaptureWindow implements FloatingChatWindow {
  readonly events: ChatEvent[] = [];
  private readonly handlers: Array<() => void> = [];
  private socket: WebSocket | null = null;
  private destroyed = false;

  on(event: 'closed' | 'resize', listener: () => void): void {
    if (event === 'closed') this.handlers.push(listener);
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  getSize(): number[] {
    return [400, 600];
  }
  setSize(): void {}
  setAlwaysOnTop(): void {}
  close(): void {
    this.destroy();
  }
  destroy(): void {
    this.destroyed = true;
    this.socket?.close();
    for (const listener of this.handlers) listener();
  }
  async loadURL(url: string): Promise<void> {
    this.socket = new WebSocket(new URL('/overlay/live', url), { origin: new URL(url).origin });
    this.socket.on('message', (data) => this.events.push(JSON.parse(data.toString()) as ChatEvent));
    await once(this.socket, 'open');
  }
}

afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

describe('T17 full-session certification through public application services', () => {
  it('certifies baseline, variable latency, labeled media, retries, roster and exactly-once synchronized outputs', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'lonely-cert-'));
    folders.push(directory);
    await writeFile(path.join(directory, 'index.html'), '<html>Read-only chat</html>');
    const clock = new FakeClock();
    const chat = new ChatService();
    const audience = new AudienceService(directory, 3);
    await audience.open();
    const inputs: InferenceInput[] = [];
    const pending: Array<{ resolve: (value: unknown) => void; reject: (reason: Error) => void }> =
      [];
    const provider: InferenceProvider = {
      generateRoster: (count, excluded, signal) =>
        new FakeInference().generateRoster(count, excluded, signal),
      generate: (input) => {
        inputs.push(input);
        return new Promise((resolve, reject) => pending.push({ resolve, reject }));
      },
      resourceMeasurements: async () => ({
        ramUsedMiB: 940,
        vramUsedMiB: null,
        gpuComputePercent: null,
      }),
    };
    const session = new SessionController(
      chat,
      undefined,
      clock,
      {
        ...DEFAULT_PREFERENCES,
        baselineMs: 1000,
        cycleIntervalMs: 3000,
        historyMaxCount: 4,
        ramBudgetMiB: 1024,
        videoCaptureIntervalMs: 1000,
      },
      provider,
      audience,
    );
    const overlay = new OverlayServer(chat, directory);
    const url = await overlay.start();
    const browser = new WebSocket(new URL('/overlay/live', url), { origin: new URL(url).origin });
    const browserEvents: ChatEvent[] = [];
    browser.on('message', (data) => browserEvents.push(JSON.parse(data.toString()) as ChatEvent));
    const windows: CaptureWindow[] = [];
    const floating = new FloatingChatWindowController(
      () => {
        const window = new CaptureWindow();
        windows.push(window);
        return window;
      },
      () => url,
    );
    try {
      await once(browser, 'open');
      floating.open();
      await until(() => browserEvents.length === 1 && windows[0].events.length === 1);
      expect(browserEvents).toEqual([{ type: 'snapshot', sequence: 0, messages: [] }]);
      expect(windows[0].events).toEqual(browserEvents);
      const denied = await fetch(new URL('/api/config', url));
      expect(denied.status).toBe(404);
      expect((await fetch(url, { method: 'POST' })).status).toBe(405);
      const input = () =>
        session.recordVideoFrame({
          sourceId: 'camera:fixture',
          observedAt: clock.wallNow(),
          width: 160,
          height: 90,
          dataUrl: jpeg,
        });
      session.selectVideoSource('camera:fixture');
      session.start('Playing a platformer', 'native', 'fixture-model');
      input();
      session.recordTranscript({
        sourceId: 'mic',
        source: 'Streamer',
        text: 'Jump now',
        observedAt: clock.wallNow(),
      });
      session.recordTranscript({
        sourceId: 'voice',
        source: 'Guest',
        text: 'I see it',
        observedAt: clock.wallNow(),
      });
      clock.advance(999);
      await flushMicrotasks();
      expect(inputs).toHaveLength(0);
      clock.advance(1);
      input();
      await until(() => inputs.length === 1);
      expect(inputs).toHaveLength(1);
      expect(inputs[0].recentTranscripts?.map((entry) => entry.source)).toEqual([
        'Streamer',
        'Guest',
      ]);
      expect(inputs[0].frames?.length).toBeGreaterThan(0);
      expect(inputs[0].roster?.map((person) => person.author)).toEqual([
        'pixelpilot',
        'lunar_fox',
        'nightowl',
      ]);
      expect(session.snapshot().phase).toBe('running');
      for (let step = 1; step <= 30; step++) {
        clock.advance(1000);
        input();
        if (step === 10) {
          session.recordTranscript({
            sourceId: 'voice',
            source: 'Guest',
            text: 'That was close',
            observedAt: clock.wallNow(),
          });
        }
      }
      expect(inputs).toHaveLength(1); // No concurrent inference queue.
      const firstBoundary = inputs[0].boundary!;
      pending[0].resolve({
        events: [{ kind: 'reaction', summary: 'Player jumps', ageMs: 500 }],
        messages: [
          { author: AUTHOR_PLACEHOLDER, text: 'jump!', color: '#ffffff', offsetMs: 0 },
          { author: 'lunar_fox', text: 'late reaction', color: '#ffffff', offsetMs: 3000 },
        ],
      });
      await flushMicrotasks();
      expect(session.snapshot().events).toMatchObject([
        {
          summary: 'Player jumps',
          observedAt: firstBoundary.throughMs - 500,
        },
      ]);
      expect(chat.snapshot().messages.map((message) => message.text)).toEqual(['jump!']);
      expect(session.snapshot().latestInferenceMs).toBe(30000);
      expect(session.snapshot().pendingMessages).toBe(1);
      clock.advance(0);
      await flushMicrotasks();
      expect(inputs).toHaveLength(2);
      expect(inputs[1].videoWindow).toEqual({
        fromMs: firstBoundary.throughMs,
        throughMs: clock.wallNow(),
        truncated: false,
      });
      expect(inputs[1].frames!.length).toBeGreaterThanOrEqual(2);
      expect(inputs[1].frames!.length).toBeLessThanOrEqual(24);
      expect(inputs[1].frames?.at(0)?.observedAt).toBeGreaterThan(firstBoundary.throughMs);
      expect(inputs[1].frames?.at(-1)?.observedAt).toBe(clock.wallNow());
      expect(inputs[1].recentTranscripts?.map((item) => item.source)).toEqual([
        'Streamer',
        'Guest',
        'Guest',
      ]);
      expect(inputs[1].recentEvents?.map((event) => event.summary)).toEqual(['Player jumps']);
      expect(inputs[1].recentChat?.map((item) => item.text)).toEqual(['jump!']);
      clock.advance(500);
      input(); // Arrives after snapshot; excluded from retry input.
      pending[1].reject(new Error('Native worker crashed'));
      await flushMicrotasks();
      expect(session.snapshot().warning).toMatch(/Native worker crashed/);
      clock.advance(500);
      await flushMicrotasks();
      expect(inputs).toHaveLength(3);
      expect(inputs[2].seed).not.toBe(inputs[1].seed);
      expect({ ...inputs[2], seed: inputs[1].seed }).toEqual(inputs[1]);
      pending[2].resolve({
        events: [{ kind: 'context', summary: 'Guest reacts', ageMs: 100 }],
        messages: [
          { author: AUTHOR_PLACEHOLDER, text: 'welcome back', color: '#ffffff', offsetMs: 0 },
          { author: 'nightowl', text: 'follow up', color: '#ffffff', offsetMs: 1000 },
        ],
      });
      await flushMicrotasks();
      expect(session.snapshot().workerRamMiB).toBe(940);
      expect(session.snapshot().adaptationReason).toMatch(/Worker RAM/);
      expect(chat.snapshot().messages.map((message) => message.text)).toEqual([
        'jump!',
        'welcome back',
      ]);
      clock.advance(1000);
      expect(chat.snapshot().messages.map((message) => message.text)).toEqual([
        'jump!',
        'welcome back',
        'follow up',
      ]);
      clock.advance(2000);
      expect(chat.snapshot().messages.map((message) => message.text)).toEqual([
        'jump!',
        'welcome back',
        'follow up',
        'late reaction',
      ]);
      await until(() => browserEvents.length === 5 && windows[0].events.length === 5);
      const expected = chat.snapshot();
      expect(expected.messages.map((message) => message.id)).toEqual([
        'chat-1',
        'chat-2',
        'chat-3',
        'chat-4',
      ]);
      expect(
        expected.messages.every((message) =>
          audience.snapshot().members.some((member) => member.author === message.author),
        ),
      ).toBe(true);
      expect(browserEvents.slice(1).map((event) => event.type)).toEqual([
        'append',
        'append',
        'append',
        'append',
      ]);
      expect(windows[0].events).toEqual(browserEvents);
      const lateBrowser = new WebSocket(new URL('/overlay/live', url), {
        origin: new URL(url).origin,
      });
      try {
        const reconnectEvents: ChatEvent[] = [];
        lateBrowser.on('message', (data) =>
          reconnectEvents.push(JSON.parse(data.toString()) as ChatEvent),
        );
        await once(lateBrowser, 'open');
        await until(() => reconnectEvents.length === 1);
        expect(reconnectEvents).toEqual([expected]);
      } finally {
        lateBrowser.close();
        await once(lateBrowser, 'close');
      }
      const saved = JSON.parse(await readFile(path.join(directory, 'audience.json'), 'utf8'));
      expect(saved.members).toEqual(audience.snapshot().members);
      session.stop();
      expect(session.snapshot().pendingMessages).toBe(0);
      expect(chat.snapshot()).toEqual(expected);
      session.selectVideoSource(null);
      session.start('Manual context, no capture', 'fake');
      clock.advance(1000);
      await flushMicrotasks();
      expect(session.snapshot().phase).toBe('running');
      expect(session.snapshot().events).toMatchObject([{ summary: 'Manual context, no capture' }]);
      expect(chat.snapshot().sequence).toBeGreaterThan(expected.sequence);
      await session.terminate();
    } finally {
      await session.terminate();
      floating.close();
      browser.close();
      await once(browser, 'close');
      await overlay.stop();
    }
  });
});
