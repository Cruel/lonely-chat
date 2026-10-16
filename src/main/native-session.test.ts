import { describe, expect, it } from 'vitest';
import { ChatService } from './chat-service';
import { SessionController } from './session-controller';
import type { InferenceProvider } from './fake-inference';
import { FakeClock, flushMicrotasks } from './test-support/fake-clock';

describe('native session integration', () => {
  it('reports model loading, validates and publishes events and chat, then stops', async () => {
    const chat = new ChatService();
    const clock = new FakeClock();
    let ready: () => void = () => {};
    const provider: InferenceProvider = {
      prepare: () =>
        new Promise<void>((resolve) => {
          ready = resolve;
        }),
      generate: async () => ({
        events: [{ kind: 'context', summary: 'playing chess', ageMs: 100 }],
        messages: [{ author: 'pixelpilot', text: 'nice', color: '#bba5ff', offsetMs: 0 }],
      }),
    };
    const session = new SessionController(chat, undefined, clock, undefined, provider);
    expect(session.start('chess game', 'native')).toMatchObject({
      phase: 'starting',
      mode: 'native',
    });
    await flushMicrotasks();
    expect(chat.snapshot().messages).toHaveLength(0);
    ready();
    await flushMicrotasks();
    expect(session.snapshot().phase).toBe('running');
    expect(session.snapshot().events).toEqual([
      { kind: 'context', summary: 'playing chess', observedAt: clock.wallNow() - 100 },
    ]);
    expect(chat.snapshot().messages.map((message) => message.text)).toEqual(['nice']);
    session.stop();
    expect(session.snapshot().phase).toBe('stopped');
  });

  it('rejects an invalid native event without partially publishing its chat', async () => {
    const chat = new ChatService();
    const clock = new FakeClock();
    const provider: InferenceProvider = {
      generate: async () => ({
        events: [{ kind: 'context', summary: 'wrong', ageMs: -999 }],
        messages: [
          { author: 'pixelpilot', text: 'must not appear', color: '#bba5ff', offsetMs: 0 },
        ],
      }),
    };
    const session = new SessionController(chat, undefined, clock, undefined, provider);
    session.start('manual context', 'native');
    await flushMicrotasks();
    expect(session.snapshot().warning).toMatch(/Retrying/);
    clock.advance(500);
    await flushMicrotasks();
    clock.advance(1000);
    await flushMicrotasks();
    expect(session.snapshot().phase).toBe('error');
    expect(session.snapshot().error).toMatch(/invalid event/);
    expect(session.snapshot().events).toEqual([]);
    expect(chat.snapshot().messages).toEqual([]);
    session.stop();
  });

  it('keeps prior validated pending chat when a later inference cycle is rejected', async () => {
    const chat = new ChatService();
    const clock = new FakeClock();
    let cycles = 0;
    const provider: InferenceProvider = {
      generate: async () => {
        cycles++;
        return cycles === 1
          ? {
              events: [],
              messages: [
                { author: 'pixelpilot', text: 'still queued', color: '#bba5ff', offsetMs: 2100 },
              ],
            }
          : { events: [{ kind: 'context', summary: 'bad', ageMs: -1 }], messages: [] };
      },
    };
    const session = new SessionController(
      chat,
      undefined,
      clock,
      { cycleIntervalMs: 1500 },
      provider,
    );
    session.start('stream', 'native');
    await flushMicrotasks();
    expect(session.snapshot().pendingMessages).toBe(1);
    clock.advance(1500);
    await flushMicrotasks();
    expect(session.snapshot().warning).toMatch(/Retrying/);
    clock.advance(500);
    await flushMicrotasks();
    clock.advance(1000);
    await flushMicrotasks();
    expect(session.snapshot().phase).toBe('error');
    expect(session.snapshot().pendingMessages).toBe(0);
    expect(chat.snapshot().messages.map((message) => message.text)).toEqual(['still queued']);
    session.stop();
  });

  it('stops loading without accepting a late completion, then allows a fake restart', async () => {
    const chat = new ChatService();
    const clock = new FakeClock();
    let resolve: () => void = () => {};
    const signals: AbortSignal[] = [];
    let calls = 0;
    const native: InferenceProvider = {
      prepare: (signal) => {
        signals.push(signal);
        return new Promise<void>((done) => {
          resolve = done;
        });
      },
      generate: async () => {
        calls++;
        return { messages: [], events: [] };
      },
    };
    const session = new SessionController(chat, undefined, clock, undefined, native);
    session.start('old context', 'native');
    await flushMicrotasks();
    session.stop();
    expect(signals[0].aborted).toBe(true);
    resolve();
    await flushMicrotasks();
    expect(calls).toBe(0);
    session.start('new context', 'fake');
    await flushMicrotasks();
    expect(chat.snapshot().messages[0].text).toContain('new context');
    session.stop();
  });
});
