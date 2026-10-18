import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { ChatService, publishSample } from './chat-service';
import { OverlayServer } from './overlay-server';
import type { ChatEvent } from '../shared/chat-contract';

describe('read-only loopback chat overlay', () => {
  let directory: string;
  let chat: ChatService;
  let overlay: OverlayServer;
  let url: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'lonely-chat-overlay-'));
    await writeFile(path.join(directory, 'index.html'), '<html>overlay</html>');
    chat = new ChatService();
    overlay = new OverlayServer(chat, directory);
    url = await overlay.start(0);
  });

  afterEach(async () => {
    await overlay.stop();
    await rm(directory, { recursive: true, force: true });
  });

  it('releases resources after a real bind conflict and can retry later', async () => {
    const blockedPort = Number(new URL(url).port);
    const second = new OverlayServer(chat, directory);
    await expect(second.start(blockedPort)).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await overlay.stop();
    expect(await second.start(blockedPort)).toBe(url);
    await second.stop();
  });

  it('serves overlay only, rejects methods, paths and remote browser origins', async () => {
    const endpoint = new URL(url);
    expect(endpoint.hostname).toBe('127.0.0.1');
    const page = await fetch(url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('overlay');
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
    for (const blocked of [
      '/api/config',
      '/config',
      '/transcripts',
      '/chat:sample',
      '/index.html',
      '/overlay/live',
    ]) {
      expect((await fetch(new URL(blocked, url))).status).toBe(404);
    }
    expect((await fetch(url, { method: 'POST' })).status).toBe(405);
    const unsafe = new WebSocket(new URL('/overlay/live', url), {
      origin: 'https://attacker.example',
    });
    const error = await new Promise<Error>((resolve) => unsafe.once('error', resolve));
    expect(error.message).toContain('403');
  });

  it('sends an authoritative snapshot then ordered live messages and late-reconnect snapshot', async () => {
    publishSample(chat);
    const connect = async () => {
      const ws = new WebSocket(new URL('/overlay/live', url), {
        origin: new URL(url).origin,
      });
      const events: ChatEvent[] = [];
      ws.on('message', (buffer) => events.push(JSON.parse(buffer.toString()) as ChatEvent));
      await once(ws, 'open');
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { ws, events };
    };
    const first = await connect();
    expect(first.events[0]).toMatchObject({ type: 'snapshot', sequence: 1 });
    expect(first.events[0].type === 'snapshot' && first.events[0].messages).toHaveLength(1);
    publishSample(chat);
    publishSample(chat);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(first.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    first.ws.close();
    await once(first.ws, 'close');
    const reconnect = await connect();
    expect(reconnect.events).toHaveLength(1);
    expect(reconnect.events[0]).toMatchObject({ type: 'snapshot', sequence: 3 });
    expect(reconnect.events[0].type === 'snapshot' && reconnect.events[0].messages).toHaveLength(3);
    reconnect.ws.close();
    await once(reconnect.ws, 'close');
  });

  it('excludes private recorded chat from both live events and late-joining overlay snapshots', async () => {
    const connect = async () => {
      const socket = new WebSocket(new URL('/overlay/live', url));
      const messages: ChatEvent[] = [];
      socket.on('message', (raw) => messages.push(JSON.parse(raw.toString()) as ChatEvent));
      await once(socket, 'open');
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { socket, messages };
    };
    const first = await connect();
    chat.publish({ author: 'private', text: 'hidden', color: '#ffffff' }, Date.now(), false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(first.messages).toHaveLength(1);
    expect(chat.snapshot().messages).toHaveLength(1);
    expect(chat.publicSnapshot().messages).toEqual([]);
    chat.publish({ author: 'public', text: 'shown', color: '#ffffff' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(first.messages.at(-1)).toMatchObject({ type: 'append', sequence: 1 });
    first.socket.close();
    await once(first.socket, 'close');
    const second = await connect();
    expect(second.messages[0]).toMatchObject({ type: 'snapshot', sequence: 1 });
    if (second.messages[0].type !== 'snapshot') throw new Error('Expected snapshot');
    expect(second.messages[0].messages.map((message) => message.text)).toEqual(['shown']);
    second.socket.close();
    await once(second.socket, 'close');
  });
});
