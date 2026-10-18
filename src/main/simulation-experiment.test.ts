import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlaygroundService } from './playground-service';
import { AUDIENCE, type InferenceInput, type InferenceProvider } from './fake-inference';
import { nativeChatRequest, extractNativeChat } from './native-inference';
import { ChatService } from './chat-service';
import { SessionController } from './session-controller';
import { FakeClock, flushMicrotasks } from './test-support/fake-clock';
import type { SimulationExperimentRequest } from '../shared/playground-contract';

const input: SimulationExperimentRequest = {
  modelId: 'managed-model',
  values: {
    context: 'campfire',
    cycle: 1,
    playbackWindowMs: 3000,
    chatActivity: 'normal',
    roster: AUDIENCE,
    events: [],
    transcripts: [{ source: 'microphone', text: 'what is that?', ageMs: 100 }],
    observations: [],
    recentChat: [],
  },
};

const reply = (body: unknown) => ({
  choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(body) } }],
  usage: { prompt_tokens: 15, completion_tokens: 20, total_tokens: 35 },
});

afterEach(() => vi.restoreAllMocks());

describe('structured Playground and production Session seam', () => {
  it('submits the production builder/schema, validates the same result, and never mutates session/chat/roster', async () => {
    const chat = new ChatService();
    const session = new SessionController(chat);
    const before = { session: session.snapshot(), chat: chat.snapshot() };
    const completeSimulationRequest = vi.fn(
      async (actualInput: InferenceInput, request: unknown) => {
        expect(request).toEqual(nativeChatRequest(actualInput));
        return reply({
          events: [{ kind: 'reaction', summary: 'Heard a question', ageMs: 100 }],
          messages: [{ author: 'pixelpilot', text: 'Who is there?', offsetMs: 200 }],
        });
      },
    );
    const stop = vi.fn(async () => {});
    const playground = new PlaygroundService(
      () => true,
      () => ({
        completeFreeform: vi.fn(),
        completeSimulationRequest,
        stop,
      }),
    );
    const result = await playground.runSimulation(input);
    expect(result.error).toBeNull();
    expect(result.errorStage).toBeNull();
    expect(result.rawNativeOutput).toEqual(
      reply({
        events: [{ kind: 'reaction', summary: 'Heard a question', ageMs: 100 }],
        messages: [{ author: 'pixelpilot', text: 'Who is there?', offsetMs: 200 }],
      }),
    );
    expect(result.normalizedResult).toMatchObject({
      messages: [{ author: 'pixelpilot', color: '#bba5ff' }],
    });
    expect(result.accepted?.messages).toEqual([
      { author: 'pixelpilot', color: '#bba5ff', text: 'Who is there?', offsetMs: 200 },
    ]);
    expect(result.accepted?.events[0].summary).toBe('Heard a question');
    expect(result.usage).toMatchObject({ totalTokens: 35 });
    expect(stop).toHaveBeenCalledOnce();
    expect({ session: session.snapshot(), chat: chat.snapshot() }).toEqual(before);
  });

  it('reports normalization and validation failures with native content preserved, and does not accept a batch', async () => {
    const responses = [
      reply({ events: [], messages: [{ author: 'unknown', text: 'bad', offsetMs: 0 }] }),
      reply({ events: [{ kind: 'reaction', summary: 'invalid', ageMs: -1 }], messages: [] }),
      reply({ events: [], messages: [{ author: 'pixelpilot', text: 'hi', offsetMs: 0 }] }),
    ];
    const stop = vi.fn(async () => {});
    const playground = new PlaygroundService(
      () => true,
      () => ({
        completeFreeform: vi.fn(),
        completeSimulationRequest: vi.fn(async () => responses.shift()),
        stop,
      }),
    );
    const first = await playground.runSimulation(input);
    expect(first).toMatchObject({
      errorStage: 'normalization',
      accepted: null,
      normalizedResult: null,
    });
    expect(first.rawNativeOutput).not.toBeNull();
    const second = await playground.runSimulation(input);
    expect(second).toMatchObject({ errorStage: 'validation', accepted: null });
    expect(second.normalizedResult).not.toBeNull();
    const third = await playground.runSimulation(input);
    expect(third).toMatchObject({ errorStage: null, error: null });
    expect(third.accepted?.messages).toHaveLength(1);
    expect(stop).toHaveBeenCalledTimes(3);
  });

  it('validates advanced raw JSON before worker acquisition and records constructed vs submitted requests', async () => {
    const provider = {
      completeFreeform: vi.fn(),
      completeSimulationRequest: vi.fn(async () => reply({ events: [], messages: [] })),
      stop: vi.fn(async () => {}),
    };
    const create = vi.fn(() => provider);
    const playground = new PlaygroundService(() => true, create);
    const preview = playground.previewSimulation(input);
    const overridden = {
      ...(preview.constructedRequest as Record<string, unknown>),
      temperature: 0.25,
      seed: 1234,
    };
    expect(() => playground.runSimulation({ ...input, rawRequestJson: '{' })).toThrow(/valid JSON/);
    expect(() =>
      playground.runSimulation({
        ...input,
        rawRequestJson: JSON.stringify({ ...overridden, response_format: null }),
      }),
    ).toThrow(/response format/);
    expect(create).not.toHaveBeenCalled();
    const result = await playground.runSimulation({
      ...input,
      rawRequestJson: JSON.stringify(overridden),
    });
    expect(result.constructedRequest).toMatchObject({ temperature: 0.7 });
    expect(result.submittedRequest).toMatchObject({ temperature: 0.25, seed: 1234 });
    expect(provider.completeSimulationRequest).toHaveBeenCalledWith(
      expect.anything(),
      overridden,
      expect.any(AbortSignal),
    );
  });

  it('shares production request construction and accepted-output semantics with the continuous Session', async () => {
    const clock = new FakeClock();
    vi.spyOn(Date, 'now').mockImplementation(clock.wallNow);
    const chat = new ChatService();
    const nativeReply = reply({
      events: [{ kind: 'context', summary: 'campfire', ageMs: 0 }],
      messages: [{ author: 'pixelpilot', text: 'warm night', offsetMs: 0 }],
    });
    let sessionInput: InferenceInput | null = null;
    const provider: InferenceProvider = {
      generate: async (value) => {
        sessionInput = value;
        return extractNativeChat(nativeReply, value.roster);
      },
    };
    const session = new SessionController(chat, undefined, clock, undefined, provider);
    session.start('campfire', 'native');
    await flushMicrotasks();
    expect(sessionInput).not.toBeNull();
    const playground = new PlaygroundService(
      () => true,
      () => ({
        completeFreeform: vi.fn(),
        completeSimulationRequest: vi.fn(async () => nativeReply),
        stop: vi.fn(async () => {}),
      }),
    );
    const result = await playground.runSimulation({
      ...input,
      values: { ...input.values, transcripts: [] },
    });
    const sessionPrompt = nativeChatRequest(sessionInput!);
    const constructed = result.constructedRequest as ReturnType<typeof nativeChatRequest>;
    expect(constructed.messages[0]).toEqual(sessionPrompt.messages[0]);
    expect(constructed.response_format).toEqual(sessionPrompt.response_format);
    expect(JSON.parse(constructed.messages[1].content as string)).toMatchObject({
      manualContext: 'campfire',
      cycle: 1,
      roster: AUDIENCE,
      chatActivity: 'normal',
    });
    expect(result.accepted?.messages.map((message) => message.text)).toEqual(
      chat.snapshot().messages.map((message) => message.text),
    );
    expect(result.accepted?.events).toEqual(session.snapshot().events);
    session.stop();
  });

  it('uses active Session history limits and clips accepted native chat offsets', async () => {
    const playground = new PlaygroundService(
      () => true,
      () => ({
        completeFreeform: vi.fn(),
        completeSimulationRequest: vi.fn(async () =>
          reply({
            events: [],
            messages: [{ author: 'pixelpilot', text: 'later', offsetMs: 5500 }],
          }),
        ),
        stop: vi.fn(async () => {}),
      }),
      async () => {},
      () => ({ historyMaxAgeMs: 60000, historyMaxCount: 1 }),
    );
    const request = {
      ...input,
      values: {
        ...input.values,
        transcripts: [
          { source: 'mic', text: 'older', ageMs: 500 },
          { source: 'mic', text: 'newer', ageMs: 100 },
        ],
      },
    };
    const preview = playground.previewSimulation(request);
    const prompt = preview.constructedRequest as ReturnType<typeof nativeChatRequest>;
    const userContent = JSON.parse(prompt.messages[1].content as string);
    expect(userContent.recentTranscripts.map((item: { text: string }) => item.text)).toEqual([
      'newer',
    ]);
    const result = await playground.runSimulation(request);
    expect(result.normalizedResult).toMatchObject({
      messages: [{ offsetMs: 5500 }],
    });
    expect(result.accepted?.messages).toMatchObject([{ offsetMs: 3000 }]);
  });

  it('keeps the in-flight lock across both Playground modes', async () => {
    let release!: (value: unknown) => void;
    const playground = new PlaygroundService(
      () => true,
      () => ({
        completeFreeform: vi.fn(),
        completeSimulationRequest: () =>
          new Promise((resolve) => {
            release = resolve;
          }),
        stop: vi.fn(async () => {}),
      }),
    );
    const pending = playground.runSimulation(input);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(playground.busy).toBe(true);
    expect(() => playground.runSimulation(input)).toThrow(/Another Playground/);
    release(reply({ events: [], messages: [] }));
    await pending;
    expect(playground.busy).toBe(false);
  });
});
