import { describe, expect, it } from 'vitest';
import { ChatService } from './chat-service';
import { SessionController } from './session-controller';
import { FakeClock, flushMicrotasks as flush } from './test-support/fake-clock';
import type { InferenceInput, InferenceProvider } from './fake-inference';
import { DEFAULT_PREFERENCES } from '../shared/session-contract';
import { validInferenceSeed } from './inference-seeds';

const message = (text: string, offsetMs = 0) => ({
  author: 'pixelpilot',
  color: '#bba5ff',
  text,
  offsetMs,
});
const response = (text: string, ageMs = 0) => ({
  events: [{ kind: 'reaction', summary: text, ageMs }],
  messages: [message(text, 0), message('later ' + text, 5000)],
});

describe('continuous inference loop', () => {
  it('assigns an effective session and request seed when none is configured', async () => {
    const inputs: InferenceInput[] = [];
    const provider: InferenceProvider = {
      generate: async (input) => {
        inputs.push(input);
        return { events: [], messages: [] };
      },
    };
    const session = new SessionController(new ChatService(), provider, new FakeClock());
    const started = session.start('unspecified seed');
    expect(validInferenceSeed(started.sessionSeed)).toBe(true);
    await flush();
    expect(inputs).toHaveLength(1);
    expect(validInferenceSeed(inputs[0].seed)).toBe(true);
    expect(session.snapshot().effectiveSeed).toBe(inputs[0].seed);
    session.stop();
  });

  it('waits for a configurable baseline; records a fixed observation window; starts again while chat drains', async () => {
    const clock = new FakeClock();
    const chat = new ChatService();
    const inputs: InferenceInput[] = [];
    const pending: Array<(value: unknown) => void> = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const provider: InferenceProvider = {
      generate: (input) => {
        inputs.push(input);
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        return new Promise((resolve) =>
          pending.push((value) => {
            concurrent--;
            resolve(value);
          }),
        );
      },
    };
    const session = new SessionController(
      chat,
      undefined,
      clock,
      {
        ...DEFAULT_PREFERENCES,
        baselineMs: 1000,
        cycleIntervalMs: 1500,
      },
      provider,
    );
    session.start('a live stream', 'native');
    session.recordObservation({
      kind: 'visual',
      source: 'screen',
      description: 'level start',
      observedAt: clock.wallNow(),
    });
    clock.advance(999);
    await flush();
    expect(inputs).toHaveLength(0);
    clock.advance(1);
    await flush();
    expect(inputs).toHaveLength(1);
    expect(inputs[0].observations?.map((item) => item.description)).toEqual(['level start']);
    session.recordObservation({
      kind: 'visual',
      source: 'screen',
      description: 'enemy appears',
      observedAt: clock.wallNow(),
    });
    clock.advance(2400);
    expect(inputs).toHaveLength(1); // In-flight request must not create a queue.
    pending[0](response('initial event', 200));
    await flush();
    expect(session.snapshot().events[0].observedAt).toBe(inputs[0].boundary!.throughMs - 200);
    expect(session.snapshot()).toMatchObject({
      latestInferenceMs: 2400,
      smoothedInferenceMs: 2400,
      playbackWindowMs: 2400,
      pendingMessages: 1,
    });
    clock.advance(0);
    await flush();
    expect(inputs).toHaveLength(2);
    expect(maxConcurrent).toBe(1);
    expect(inputs[1].boundary).toMatchObject({
      fromSequence: 1,
      throughSequence: 2,
    });
    expect(inputs[1].observations?.map((item) => item.description)).toEqual(['enemy appears']);
    expect(inputs[1].recentChat?.map((item) => item.text)).toEqual(['initial event']);
    expect(inputs[1].recentEvents?.map((item) => item.summary)).toEqual(['initial event']);
    expect(chat.snapshot().messages.map((item) => item.text)).toEqual(['initial event']);
    clock.advance(2400); // Prior batch plays while the next inference remains unresolved.
    expect(chat.snapshot().messages.map((item) => item.text)).toEqual([
      'initial event',
      'later initial event',
    ]);
    pending[1]({ events: [], messages: [message('second')] });
    await flush();
    expect(chat.snapshot().messages.map((item) => item.text)).toEqual([
      'initial event',
      'later initial event',
      'second',
    ]);
    session.stop();
  });

  it('retries the identical snapshot on invalid output, retaining new observations for the next cycle', async () => {
    const clock = new FakeClock();
    const chat = new ChatService();
    const inputs: InferenceInput[] = [];
    let attempts = 0;
    const provider: InferenceProvider = {
      generate: async (input) => {
        inputs.push(input);
        attempts++;
        return attempts === 1
          ? { events: [{ kind: 'context', summary: 'bad', ageMs: -1 }], messages: [message('bad')] }
          : { events: [], messages: [message('good')] };
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
    session.start('stream', 'native', null, {
      inputMode: 'live',
      publishToOverlay: true,
      seed: 42,
    });
    session.recordObservation({
      kind: 'audio',
      source: 'game',
      description: 'voice',
      observedAt: clock.wallNow(),
    });
    await flush();
    expect(session.snapshot().warning).toMatch(/Retrying/);
    expect(chat.snapshot().sequence).toBe(0);
    session.recordObservation({
      kind: 'visual',
      source: 'screen',
      description: 'next frame',
      observedAt: clock.wallNow(),
    });
    clock.advance(500);
    await flush();
    expect(inputs).toHaveLength(2);
    expect(inputs[0].seed).toBeDefined();
    expect(inputs[1].seed).not.toBe(inputs[0].seed);
    expect({ ...inputs[1], seed: inputs[0].seed }).toEqual(inputs[0]);
    expect(session.snapshot().sessionSeed).toBe(42);
    expect(session.snapshot().recentAttemptSeeds).toEqual([
      { cycle: 1, attempt: 1, seed: inputs[0].seed },
      { cycle: 1, attempt: 2, seed: inputs[1].seed },
    ]);
    expect(chat.snapshot().messages.map((item) => item.text)).toEqual(['good']);
    clock.advance(1000);
    await flush();
    expect(inputs).toHaveLength(3);
    expect(inputs[2].observations?.map((item) => item.description)).toEqual([
      'voice',
      'next frame',
    ]);
    expect(inputs[2].seed).not.toBe(inputs[1].seed);
    // The first observation occurred after cycle one's snapshot, so it remains pending.
    session.stop();
  });

  it('smooths measured inference durations and preserves validated history through retry exhaustion', async () => {
    const clock = new FakeClock();
    const chat = new ChatService();
    const pending: Array<(output: unknown) => void> = [];
    let generated = 0;
    const provider: InferenceProvider = {
      generate: () => {
        generated++;
        if (generated >= 3) return Promise.reject(new Error('server crashed'));
        return new Promise((resolve) => pending.push(resolve));
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
    clock.advance(2000);
    pending[0](response('first'));
    await flush();
    expect(session.snapshot().smoothedInferenceMs).toBe(2000);
    clock.advance(0);
    await flush();
    clock.advance(6000);
    pending[1](response('second'));
    await flush();
    expect(session.snapshot().smoothedInferenceMs).toBe(3400);
    expect(session.snapshot().playbackWindowMs).toBe(3400);
    expect(session.snapshot().events.map((item) => item.summary)).toEqual(['first', 'second']);
    clock.advance(0);
    await flush();
    expect(session.snapshot().warning).toMatch(/server crashed/);
    clock.advance(500);
    await flush();
    clock.advance(1000);
    await flush();
    expect(session.snapshot().phase).toBe('error');
    expect(session.snapshot().error).toMatch(/3 attempts: server crashed/);
    const failedSeeds = session.snapshot().recentAttemptSeeds!.filter((item) => item.cycle === 3);
    expect(failedSeeds).toHaveLength(3);
    expect(new Set(failedSeeds.map((item) => item.seed)).size).toBe(3);
    expect(session.snapshot().events).toHaveLength(2);
    session.stop();
    expect(session.snapshot().events).toHaveLength(2);
    session.start('new run', 'fake');
    await flush();
    expect(session.snapshot().events.map((item) => item.summary)).toEqual(['new run']);
    session.stop();
  });
});
