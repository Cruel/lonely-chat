import { describe, expect, it } from 'vitest';
import { ChatService } from './chat-service';
import { SessionController } from './session-controller';
import { FakeClock, flushMicrotasks } from './test-support/fake-clock';
import { DEFAULT_PREFERENCES } from '../shared/session-contract';
import type { InferenceInput, InferenceProvider } from './fake-inference';

const jpeg = 'data:image/jpeg;base64,/9j/';

describe('end-to-end temporal video inference windows', () => {
  it('covers a 30-second latency window with more frames than a 3-second window, preserves retry snapshots and timestamps', async () => {
    const clock = new FakeClock();
    const chat = new ChatService();
    const inputs: InferenceInput[] = [];
    const pending: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }> =
      [];
    const provider: InferenceProvider = {
      generate: (input) => {
        inputs.push(input);
        return new Promise((resolve, reject) => pending.push({ resolve, reject }));
      },
    };
    const session = new SessionController(
      chat,
      undefined,
      clock,
      {
        ...DEFAULT_PREFERENCES,
        cycleIntervalMs: 3000,
        videoCaptureIntervalMs: 500,
        videoCoverageMs: 60000,
        videoMinFrames: 2,
        videoMaxFrames: 24,
      },
      provider,
    );
    session.selectVideoSource('camera:game');
    const start = clock.wallNow();
    const add = () =>
      session.recordVideoFrame({
        sourceId: 'camera:game',
        observedAt: clock.wallNow(),
        width: 160,
        height: 90,
        dataUrl: jpeg,
      });
    add();
    session.start('Playing a platformer', 'native');
    await flushMicrotasks();
    expect(inputs).toHaveLength(1);
    expect(inputs[0].frames?.map((frame) => frame.observedAt)).toEqual([start]);

    for (let index = 0; index < 60; index++) {
      clock.advance(500);
      add();
    }
    pending[0].resolve({ events: [], messages: [] });
    await flushMicrotasks();
    clock.advance(0);
    await flushMicrotasks();

    expect(inputs).toHaveLength(2);
    const long = inputs[1];
    expect(long.videoWindow).toEqual({
      fromMs: start,
      throughMs: start + 30000,
      truncated: false,
    });
    expect(long.frames).toHaveLength(24);
    expect(long.frames?.at(0)?.observedAt).toBe(start + 500);
    expect(long.frames?.at(-1)?.observedAt).toBe(start + 30000);
    expect(
      long.frames?.every(
        (frame, i, array) => i === 0 || frame.observedAt > array[i - 1].observedAt,
      ),
    ).toBe(true);

    // Retry must reuse its exact media snapshot; new frames go exclusively to the next cycle.
    pending[1].reject(new Error('temporary worker failure'));
    await flushMicrotasks();
    clock.advance(500);
    add();
    await flushMicrotasks();
    expect(inputs).toHaveLength(3);
    expect(inputs[2]).toBe(long);
    pending[2].resolve({
      events: [{ kind: 'reaction', summary: 'A jump at 1s', ageMs: 29000 }],
      messages: [{ author: 'pixelpilot', color: '#bba5ff', text: 'Nice jump!', offsetMs: 0 }],
    });
    await flushMicrotasks();
    expect(session.snapshot().events).toEqual([
      {
        kind: 'reaction',
        summary: 'A jump at 1s',
        observedAt: start + 1000,
      },
    ]);
    expect(chat.snapshot().messages.map((message) => message.text)).toContain('Nice jump!');

    for (let index = 0; index < 5; index++) {
      clock.advance(500);
      add();
    }
    await flushMicrotasks();
    expect(inputs).toHaveLength(4);
    const short = inputs[3];
    expect(short.videoWindow).toEqual({
      fromMs: start + 30000,
      throughMs: start + 33000,
      truncated: false,
    });
    // At 33s the timer snapshots before the producer adds its same-tick frame.
    expect(short.frames).toHaveLength(5);
    expect(short.frames?.map((frame) => frame.observedAt)).toEqual(
      Array.from({ length: 5 }, (_, i) => start + 30500 + i * 500),
    );
    expect(
      short.frames?.some((frame) =>
        long.frames?.some((previous) => previous.observedAt === frame.observedAt),
      ),
    ).toBe(false);

    await session.terminate();
  });

  it('exposes clipped coverage explicitly when inference lasts beyond the configured lookback', async () => {
    const clock = new FakeClock();
    const inputs: InferenceInput[] = [];
    let resolveFirst!: (value: unknown) => void;
    const provider: InferenceProvider = {
      generate: (input) => {
        inputs.push(input);
        return inputs.length === 1
          ? new Promise((resolve) => {
              resolveFirst = resolve;
            })
          : Promise.resolve({ events: [], messages: [] });
      },
    };
    const session = new SessionController(
      new ChatService(),
      undefined,
      clock,
      {
        ...DEFAULT_PREFERENCES,
        cycleIntervalMs: 3000,
        videoCoverageMs: 10000,
        videoCaptureIntervalMs: 1000,
      },
      provider,
    );
    session.selectVideoSource('camera:game');
    session.start('game', 'native');
    await flushMicrotasks();
    for (let i = 0; i < 30; i++) {
      clock.advance(1000);
      session.recordVideoFrame({
        sourceId: 'camera:game',
        observedAt: clock.wallNow(),
        width: 160,
        height: 90,
        dataUrl: jpeg,
      });
    }
    resolveFirst({ events: [], messages: [] });
    await flushMicrotasks();
    clock.advance(0);
    await flushMicrotasks();
    expect(inputs).toHaveLength(2);
    expect(inputs[1].videoWindow).toMatchObject({
      truncated: true,
      fromMs: clock.wallNow() - 10000,
      throughMs: clock.wallNow(),
    });
    expect(inputs[1].frames).toHaveLength(10);
    expect(inputs[1].frames?.at(0)?.observedAt).toBe(clock.wallNow() - 10000);
    expect(inputs[1].frames?.every((frame) => frame.observedAt >= clock.wallNow() - 10000)).toBe(
      true,
    );
    await session.terminate();
  });
});
