import { describe, expect, it } from 'vitest';
import { ChatService } from './chat-service';
import { SessionController } from './session-controller';
import type { InferenceInput, InferenceProvider } from './fake-inference';
import { FakeClock, flushMicrotasks as flush } from './test-support/fake-clock';
import { DEFAULT_PREFERENCES } from '../shared/session-contract';

const chatMessage = (text: string, offsetMs = 0) => ({
  author: 'pixelpilot',
  text,
  color: '#bba5ff',
  offsetMs,
});

describe('native model hot switching', () => {
  it('retires the old worker before activation, preserves scheduled chat/history and ignores stale inference', async () => {
    const clock = new FakeClock();
    const chat = new ChatService();
    const inputs: InferenceInput[] = [];
    const pending: Array<(value: unknown) => void> = [];
    let runningWorkers = 0;
    let starts = 0;
    let stops = 0;
    let completeFirst: (value: unknown) => void = () => {};
    const provider: InferenceProvider = {
      prepare: async () => {
        runningWorkers++;
        starts++;
      },
      stop: async () => {
        runningWorkers = 0;
        stops++;
      },
      generate: (input) => {
        inputs.push(input);
        if (inputs.length === 2) return new Promise((resolve) => pending.push(resolve));
        if (inputs.length === 1)
          return new Promise((resolve) => {
            completeFirst = resolve;
          });
        return Promise.resolve({ events: [], messages: [chatMessage('resumed')] });
      },
    };
    const session = new SessionController(
      chat,
      undefined,
      clock,
      {
        ...DEFAULT_PREFERENCES,
        cycleIntervalMs: 1500,
      },
      provider,
    );
    session.start('stream', 'native');
    await flush();
    clock.advance(2400);
    completeFirst({
      events: [{ kind: 'reaction', summary: 'first event', ageMs: 0 }],
      messages: [chatMessage('first'), chatMessage('queued', 2100)],
    });
    await flush();
    expect(chat.snapshot().messages.map((item) => item.text)).toEqual(['first']);
    clock.advance(0);
    await flush();
    expect(inputs).toHaveLength(2);
    const phases: string[] = [];
    session.subscribe((snapshot) => phases.push(snapshot.phase));
    let activated = false;
    const changed = session.switchNativeModel(async () => {
      expect(runningWorkers).toBe(0);
      expect(stops).toBeGreaterThan(0);
      activated = true;
    }, 'new-install');
    expect(session.snapshot().phase).toBe('switching');
    await changed;
    await flush();
    expect(activated).toBe(true);
    expect(starts).toBeGreaterThanOrEqual(2);
    expect(session.snapshot().phase).toBe('running');
    expect(session.snapshot().modelId).toBe('new-install');
    expect(phases).toContain('switching');
    expect(inputs).toHaveLength(3);
    expect(inputs[2].recentEvents?.map((event) => event.summary)).toEqual(['first event']);
    expect(inputs[2].recentChat?.map((item) => item.text)).toEqual(['first']);
    expect(chat.snapshot().messages.map((item) => item.text)).toEqual(['first', 'resumed']);
    pending[0]({ events: [], messages: [chatMessage('STALE')] });
    await flush();
    expect(chat.snapshot().messages.some((item) => item.text === 'STALE')).toBe(false);
    clock.advance(2100);
    expect(chat.snapshot().messages.map((item) => item.text)).toEqual([
      'first',
      'resumed',
      'queued',
    ]);
    session.stop();
  });

  it('rejects simultaneous switches, cancels switching on Stop, and keeps original history', async () => {
    const clock = new FakeClock();
    const chat = new ChatService();
    let release: () => void = () => {};
    let loads = 0;
    const provider: InferenceProvider = {
      prepare: () => {
        loads++;
        return loads === 1
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              release = resolve;
            });
      },
      stop: async () => {},
      generate: async () => ({ events: [], messages: [chatMessage('first')] }),
    };
    const session = new SessionController(chat, undefined, clock, DEFAULT_PREFERENCES, provider);
    session.start('stream', 'native');
    await flush();
    const first = session.switchNativeModel(async () => {}, 'install-b');
    await flush();
    expect(session.snapshot().phase).toBe('switching');
    await expect(session.switchNativeModel(async () => {}, 'install-c')).rejects.toThrow(
      /must be active/,
    );
    session.stop();
    expect(() => session.start('too early', 'fake')).toThrow(/model switching to finish/);
    release();
    await first;
    await flush();
    expect(session.snapshot().phase).toBe('stopped');
    expect(chat.snapshot().messages.map((item) => item.text)).toEqual(['first']);
  });

  it('keeps validated events after a failed replacement load and retries without resetting context', async () => {
    const clock = new FakeClock();
    const chat = new ChatService();
    const inputs: InferenceInput[] = [];
    let loads = 0;
    const provider: InferenceProvider = {
      prepare: async () => {
        loads++;
        if (loads === 2) throw new Error('model load failed');
      },
      stop: async () => {},
      generate: async (input) => {
        inputs.push(input);
        return {
          events: input.cycle === 1 ? [{ kind: 'context', summary: 'earlier', ageMs: 0 }] : [],
          messages: [chatMessage('cycle ' + input.cycle)],
        };
      },
    };
    const session = new SessionController(chat, undefined, clock, DEFAULT_PREFERENCES, provider);
    session.start('playing chess', 'native');
    await flush();
    await session.switchNativeModel(async () => {}, 'broken-install');
    expect(session.snapshot().phase).toBe('error');
    expect(session.snapshot().error).toMatch(/model load failed/);
    expect(session.snapshot().events.map((item) => item.summary)).toEqual(['earlier']);
    expect(chat.snapshot().messages.map((item) => item.text)).toEqual(['cycle 1']);
    session.retry();
    await flush();
    expect(inputs.at(-1)?.context).toBe('playing chess');
    expect(inputs.at(-1)?.recentEvents?.map((item) => item.summary)).toEqual(['earlier']);
    expect(session.snapshot().phase).toBe('running');
    session.stop();
  });
});
