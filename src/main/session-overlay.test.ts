import { describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { ChatService } from './chat-service';
import { SessionController } from './session-controller';
import { OverlayServer } from './overlay-server';
import { FakeClock, flushMicrotasks } from './test-support/fake-clock';
import type { ChatEvent } from '../shared/chat-contract';

async function waitForEvents(events: ChatEvent[], count: number): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (events.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${count} overlay messages; got ${events.length}`);
}

describe('authoritative scheduled output reaches a reconnecting browser', () => {
  it('sends only visible scheduled messages in a snapshot, then exactly-once ordered updates', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'lonely-session-overlay-'));
    const clock = new FakeClock();
    const chat = new ChatService();
    const session = new SessionController(chat, undefined, clock, { cycleIntervalMs: 1500 });
    const overlay = new OverlayServer(chat, directory);
    const sockets: WebSocket[] = [];
    try {
      await writeFile(path.join(directory, 'index.html'), '<html></html>');
      const url = await overlay.start(0);
      const connect = async () => {
        const events: ChatEvent[] = [];
        const ws = new WebSocket(new URL('/overlay/live', url), { origin: new URL(url).origin });
        sockets.push(ws);
        ws.on('message', (data) => events.push(JSON.parse(data.toString()) as ChatEvent));
        await once(ws, 'open');
        await waitForEvents(events, 1);
        return { ws, events };
      };

      session.start('a live demo');
      await flushMicrotasks();
      const early = await connect();
      expect(early.events[0]).toMatchObject({ type: 'snapshot', sequence: 1 });
      expect(early.events[0].type === 'snapshot' && early.events[0].messages).toHaveLength(1);
      clock.advance(900);
      await waitForEvents(early.events, 2);
      expect(early.events.map((event) => event.sequence)).toEqual([1, 2]);
      early.ws.close();
      await once(early.ws, 'close');

      const late = await connect();
      expect(late.events).toHaveLength(1);
      expect(late.events[0]).toMatchObject({ type: 'snapshot', sequence: 2 });
      expect(late.events[0].type === 'snapshot' && late.events[0].messages).toHaveLength(2);
      clock.advance(600);
      await flushMicrotasks();
      await waitForEvents(late.events, 2);
      expect(late.events[1]).toMatchObject({ type: 'append', sequence: 3 });
      session.stop();
      clock.advance(90000);
      await flushMicrotasks();
      expect(chat.snapshot().sequence).toBe(3);
      expect(late.events.map((event) => event.sequence)).toEqual([2, 3]);
    } finally {
      session.stop();
      for (const ws of sockets) ws.terminate();
      await overlay.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
