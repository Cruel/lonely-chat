import { describe, expect, it } from 'vitest';
import { SessionController } from './session-controller';
import { InferenceTrace } from './inference-trace';
import { ChatService } from './chat-service';
import type { InferenceProvider } from './fake-inference';
import { FakeClock, flushMicrotasks as flush } from './test-support/fake-clock';
import { deriveInferenceSeed } from './inference-seeds';
import { PrivateInferenceError } from './private-inference-error';

describe('private production inference tracing', () => {
  it('captures the frozen observed input, parsed events, accepted chat, and final scheduled batch', async () => {
    const clock = new FakeClock();
    const trace = new InferenceTrace();
    const session = new SessionController(
      new ChatService(),
      undefined,
      clock,
      { cycleIntervalMs: 1500, baselineMs: 1000 },
      undefined,
      undefined,
      undefined,
      undefined,
      trace,
    );
    session.start(
      'the campfire',
      'fake',
      null,
      { inputMode: 'recorded', publishToOverlay: false, seed: 123 },
      { id: 'preset', name: 'Pinned', revision: 7, chatActivity: 'normal' },
    );
    session.recordTranscript({
      source: 'mic',
      sourceId: 'microphone-1',
      text: 'hello there',
      observedAt: clock.wallNow(),
    });
    session.recordObservation({
      source: 'desktop',
      kind: 'visual',
      description: 'sudden explosion',
      observedAt: clock.wallNow(),
    });
    session.selectVideoSource('recorded:video');
    session.recordVideoFrame({
      sourceId: 'recorded:video',
      observedAt: clock.wallNow(),
      width: 1,
      height: 1,
      dataUrl: 'data:image/jpeg;base64,/9j/2Q==',
    });
    clock.advance(1000);
    await flush();
    const item = trace.list().attempts[0];
    expect(item).toMatchObject({
      runId: 1,
      cycle: 1,
      attempt: 1,
      stage: 'scheduled',
      seed: deriveInferenceSeed(123, 'cycle', 1, 1),
    });
    const detail = trace.get(item.id)!;
    expect(detail.promptPreset).toMatchObject({ id: 'preset', revision: 7 });
    expect(detail.input).toMatchObject({
      boundary: { fromSequence: 0, throughSequence: 2 },
      captureSelection: {
        observations: [2],
        transcripts: [1],
        chat: [],
        events: [],
        frames: [`recorded:video:${1700000010000}:0`],
      },
      recentTranscripts: [{ sourceId: 'microphone-1', text: 'hello there' }],
      observations: [{ description: 'sudden explosion' }],
    });
    expect(detail.request).toBeNull();
    expect((detail.input as { frames: unknown[] }).frames).toHaveLength(1);
    expect(detail.parsed).toMatchObject({ events: [{ kind: 'context', summary: 'the campfire' }] });
    expect((detail.accepted as { messages: Array<{ author: string }> }).messages[0].author).toBe(
      'pixelpilot',
    );
    expect(
      (detail.scheduled as { messages: Array<{ text: string; offsetMs: number }> }).messages[0],
    ).toMatchObject({ text: 'Chat is watching: the campfire', offsetMs: 0 });
    expect(detail.settings).toMatchObject({ chatActivity: 'normal' });
    session.stop();
    expect(trace.get(item.id)?.stage).toBe('scheduled');
  });

  it('retains each invalid native response and retry with exact effective seeds and stage attribution', async () => {
    const clock = new FakeClock();
    const trace = new InferenceTrace();
    const chat = new ChatService();
    const raw = {
      choices: [{ finish_reason: 'stop', message: { content: '{bad json' } }],
      usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
    };
    const provider: InferenceProvider = {
      generate: async (input, _signal, observer) => {
        observer?.('request', { stream: false, seed: input.seed, messages: ['request'] });
        observer?.('response', raw);
        throw new Error('llama.cpp generated malformed JSON.');
      },
    };
    const session = new SessionController(
      chat,
      undefined,
      clock,
      undefined,
      provider,
      undefined,
      undefined,
      undefined,
      trace,
    );
    session.start('campfire', 'native', 'model-one', {
      inputMode: 'live',
      publishToOverlay: true,
      seed: 81,
    });
    await flush();
    clock.advance(500);
    await flush();
    clock.advance(1000);
    await flush();
    expect(session.snapshot().phase).toBe('error');
    const attempts = trace.list().attempts;
    expect(attempts).toHaveLength(3);
    expect(attempts.map((item) => item.seed)).toEqual(
      [1, 2, 3].map((attempt) => deriveInferenceSeed(81, 'cycle', 1, attempt)),
    );
    for (const attempt of attempts) {
      expect(attempt).toMatchObject({ stage: 'failed', errorStage: 'normalization' });
      const data = trace.get(attempt.id)!;
      expect(data.request).toMatchObject({ seed: attempt.seed });
      expect(data.rawResponse).toEqual(raw);
      expect(data.usage).toEqual({ promptTokens: 5, completionTokens: 6, totalTokens: 11 });
      expect(data.normalized).toBeNull();
    }
    expect(chat.snapshot().sequence).toBe(0);
    session.stop();
  });

  it('separates rejected roster authors at normalization, schema validation, and worker transport', async () => {
    const cases = [
      {
        stage: 'transport',
        failAt: 'request',
        error: new PrivateInferenceError('HTTP 503', {
          httpStatus: 503,
          responseBody: { error: 'worker failed' },
        }),
      },
      {
        stage: 'normalization',
        failAt: 'response',
        error: new Error('chatter outside configured roster'),
      },
      { stage: 'validation', failAt: 'normalized', error: null },
    ] as const;
    for (const testcase of cases) {
      const clock = new FakeClock();
      const trace = new InferenceTrace();
      const provider: InferenceProvider = {
        generate: async (input, _signal, observer) => {
          observer?.('request', { seed: input.seed });
          if (testcase.failAt === 'request') throw testcase.error;
          observer?.('response', { choices: [], usage: { prompt_tokens: 1 } });
          if (testcase.failAt === 'response') throw testcase.error;
          const invalid = {
            events: [],
            messages: [{ author: 'outsider', color: '#ffffff', text: 'oops', offsetMs: -1 }],
          };
          observer?.('normalized', invalid);
          return invalid;
        },
      };
      const controller = new SessionController(
        new ChatService(),
        undefined,
        clock,
        undefined,
        provider,
        undefined,
        undefined,
        undefined,
        trace,
      );
      controller.start('stream', 'native', 'model', {
        inputMode: 'live',
        publishToOverlay: true,
        seed: 5,
      });
      await flush();
      const entry = trace.get(trace.list().attempts[0].id)!;
      expect(entry.stage).toBe('failed');
      expect(entry.errorStage).toBe(testcase.stage);
      if (testcase.stage === 'transport')
        expect(entry.transportError).toMatchObject({ httpStatus: 503 });
      controller.stop();
    }
  });

  it('bounds volatile entries and bytes, copies caller data, and cancels only unfinished attempts', () => {
    const trace = new InferenceTrace(1400, 2, 240);
    const mutable = { value: 'first' };
    const begin = (attempt: number) =>
      trace.begin({
        runId: 1,
        cycle: 1,
        attempt,
        seed: attempt,
        rosterSeed: 1,
        mode: 'fake',
        modelId: null,
        startedAt: 1,
        input: mutable,
        settings: {},
        promptPreset: null,
        adaptation: {},
      });
    const first = begin(1);
    mutable.value = 'changed';
    expect(trace.get(first)?.input).toEqual({ value: 'first' });
    trace.update(first, { stage: 'scheduled', scheduled: { events: [], messages: [] } });
    const second = begin(2);
    trace.update(second, { rawResponse: { huge: 'a'.repeat(5000) } });
    expect(trace.get(second)?.rawResponse).toMatchObject({ omitted: true });
    const third = begin(3);
    expect(trace.get(first)).toBeNull();
    trace.cancelPending(1);
    expect(trace.get(second)?.stage).toBe('cancelled');
    expect(trace.get(third)?.stage).toBe('cancelled');
    expect(trace.list().dropped).toBeGreaterThanOrEqual(1);
    expect(trace.list().bytes).toBeLessThanOrEqual(1400);
  });
});
