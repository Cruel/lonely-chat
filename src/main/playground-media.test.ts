import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  validatePlaygroundFrames,
  type PlaygroundFrame,
} from '../shared/playground-media-contract';
import { validateFreeformRequest, DEFAULT_FREEFORM_SAMPLING } from '../shared/playground-contract';
import { validateSimulationExperiment } from './simulation-experiment';
import { nativeFreeformRequest, nativeChatRequest } from './native-inference';
import { PlaygroundService, type PlaygroundProvider } from './playground-service';
import { ChatService } from './chat-service';
import { SessionController } from './session-controller';
import { AudienceService } from './audience-service';
import { AUDIENCE } from './fake-inference';

function frame(color: 'red' | 'blue', mediaTimeMs?: number): PlaygroundFrame {
  const dataUrl =
    'data:image/jpeg;base64,' +
    readFileSync(new URL(`../../tests/fixtures/playground-${color}.jpg`, import.meta.url)).toString(
      'base64',
    );
  return {
    sourceId: `video:${color}`,
    width: 4,
    height: 4,
    dataUrl,
    ...(mediaTimeMs === undefined ? {} : { mediaTimeMs }),
  };
}
const red = frame('red', 9000);
const blue = frame('blue', 1000);
const freeform = {
  modelId: 'installed-vision',
  systemPrompt: 'Describe the images',
  userPrompt: 'What changed?',
  ...DEFAULT_FREEFORM_SAMPLING,
  seed: 7,
};
const simulation = {
  modelId: 'installed-vision',
  values: {
    context: 'gameplay',
    cycle: 1,
    playbackWindowMs: 3000,
    chatActivity: 'normal' as const,
    roster: AUDIENCE,
    events: [],
    transcripts: [],
    observations: [],
    recentChat: [],
  },
};

describe('Playground selected media contract and multimodal transport', () => {
  it('rejects oversized, unsupported and mismatched JPEGs before worker acquisition', () => {
    const valid = validatePlaygroundFrames([red, blue]);
    expect(valid).toEqual([red, blue]);
    expect(() => validatePlaygroundFrames([red, { ...blue, width: 8 }])).toThrow(
      /dimensions do not match/,
    );
    expect(() =>
      validatePlaygroundFrames([{ ...red, dataUrl: 'data:image/png;base64,AAAA' }]),
    ).toThrow(/JPEG/);
    expect(() =>
      validatePlaygroundFrames([{ ...red, dataUrl: 'data:image/jpeg;base64,AAAA' }]),
    ).toThrow(/JPEG/);
    expect(() => validatePlaygroundFrames([{ ...red, mediaTimeMs: -1 }])).toThrow(/timestamp/);
    expect(() => validatePlaygroundFrames(Array(9).fill(red))).toThrow(/at most 8/);
    expect(() =>
      validatePlaygroundFrames([
        { ...red, dataUrl: 'data:image/jpeg;base64,' + 'A'.repeat(120000) },
      ]),
    ).toThrow(/too large/);
    expect(() =>
      validateFreeformRequest({ ...freeform, frames: [{ ...red, height: 10 }] }),
    ).toThrow(/dimensions do not match/);
    expect(() =>
      validateSimulationExperiment({ ...simulation, frames: [{ ...red, sourceId: '' }] }),
    ).toThrow(/source label/);
  });

  it('preserves exact JPEG bytes and selected order for both native transport modes', () => {
    const request = validateFreeformRequest({ ...freeform, frames: [blue, red] });
    const payload = nativeFreeformRequest(request);
    const parts = payload.messages.at(-1)?.content;
    expect(parts).toEqual([
      { type: 'text', text: freeform.userPrompt },
      { type: 'text', text: 'Selected frame 1, source=video:blue, mediaTimeMs=1000' },
      { type: 'image_url', image_url: { url: blue.dataUrl } },
      { type: 'text', text: 'Selected frame 2, source=video:red, mediaTimeMs=9000' },
      { type: 'image_url', image_url: { url: red.dataUrl } },
    ]);
    if (!Array.isArray(parts)) throw new Error('Expected multimodal request');
    const imageUrls = parts
      .filter((part) => part.type === 'image_url')
      .map((part) => ('image_url' in part ? part.image_url.url : ''));
    expect(imageUrls.map((url) => Buffer.from(url.split(',')[1], 'base64'))).toEqual([
      readFileSync(new URL('../../tests/fixtures/playground-blue.jpg', import.meta.url)),
      readFileSync(new URL('../../tests/fixtures/playground-red.jpg', import.meta.url)),
    ]);
    const native = nativeChatRequest({
      context: 'gameplay',
      cycle: 1,
      frames: [
        { ...blue, observedAt: 2000 },
        { ...red, observedAt: 3000 },
      ],
      videoWindow: { fromMs: 1000, throughMs: 3000, truncated: false },
    });
    const content = native.messages[1].content;
    expect(Array.isArray(content)).toBe(true);
    if (!Array.isArray(content)) throw new Error('Expected multimodal content');
    expect(content.filter((item) => item.type === 'image_url')).toEqual([
      { type: 'image_url', image_url: { url: blue.dataUrl } },
      { type: 'image_url', image_url: { url: red.dataUrl } },
    ]);
    expect(JSON.parse(String(content[0].text))).toMatchObject({
      videoFrames: [{ mediaTimeMs: 1000 }, { mediaTimeMs: 9000 }],
    });
  });

  it('cancels an in-flight multimodal completion and releases its native worker', async () => {
    const stop = vi.fn(async () => {});
    const completeSimulationRequest = vi.fn(
      (_input: unknown, _request: unknown, signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        }),
    );
    const service = new PlaygroundService(
      () => true,
      () => ({
        completeFreeform: vi.fn(),
        completeSimulationRequest,
        stop,
      }),
    );
    const pending = service.runSimulation({ ...simulation, frames: [red] });
    await vi.waitFor(() => expect(completeSimulationRequest).toHaveBeenCalledOnce());
    expect(service.busy).toBe(true);
    const stopping = service.stop();
    const result = await pending;
    await stopping;
    expect(result).toMatchObject({ errorStage: 'transport', error: 'cancelled', accepted: null });
    expect(stop).toHaveBeenCalledOnce();
    expect(service.busy).toBe(false);
  });

  it('serializes worker ownership, validates raw image identity, and never publishes to Session/Chat', async () => {
    const chat = new ChatService();
    const audience = new AudienceService(null, 3);
    await audience.open();
    const session = new SessionController(chat);
    const before = {
      session: session.snapshot(),
      chat: chat.snapshot(),
      roster: audience.snapshot(),
    };
    let release!: (value: unknown) => void;
    const send = vi.fn(
      (
        _input: import('./fake-inference').InferenceInput,
        _request: unknown,
        _signal: AbortSignal,
      ) =>
        new Promise<unknown>((resolve) => {
          release = resolve;
        }),
    );
    const stop = vi.fn(async () => {});
    const make = vi.fn((_id: string, _vision: boolean): PlaygroundProvider => ({
      completeFreeform: vi.fn(async () => {
        throw new Error('not used');
      }),
      completeSimulationRequest: send,
      stop,
    }));
    const service = new PlaygroundService(() => true, make);
    const selection = { ...simulation, frames: [red, blue] };
    const preview = service.previewSimulation(selection);
    const tampered = JSON.parse(JSON.stringify(preview.constructedRequest));
    const content = tampered.messages[1].content;
    // Swap the image payloads while leaving the same explicit selection.
    [content[2].image_url.url, content[4].image_url.url] = [
      content[4].image_url.url,
      content[2].image_url.url,
    ];
    expect(() =>
      service.runSimulation({
        ...selection,
        rawRequestJson: JSON.stringify(tampered),
      }),
    ).toThrow(/exactly match/);
    expect(make).not.toHaveBeenCalled();
    const task = service.runSimulation(selection);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(make).toHaveBeenCalledWith('installed-vision', true);
    const [inferenceInput, actualRequest] = send.mock.calls[0];
    expect(inferenceInput.frames?.map((item: PlaygroundFrame) => item.dataUrl)).toEqual([
      red.dataUrl,
      blue.dataUrl,
    ]);
    expect(actualRequest).toEqual(nativeChatRequest(inferenceInput));
    expect(() => service.run({ ...freeform, frames: [blue] })).toThrow(/Another Playground/);
    const halted = service.stop();
    release({
      choices: [{ finish_reason: 'stop', message: { content: '{"events":[],"messages":[]}' } }],
    });
    const result = await task;
    await halted;
    expect(result.submittedFrames).toEqual([red, blue]);
    expect(stop).toHaveBeenCalledOnce();
    expect(service.busy).toBe(false);
    expect({
      session: session.snapshot(),
      chat: chat.snapshot(),
      roster: audience.snapshot(),
    }).toEqual(before);
  });
});
