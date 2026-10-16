import { describe, expect, it } from 'vitest';
import { ChatService } from './chat-service';
import { SessionController } from './session-controller';
import { nativeChatRequest } from './native-inference';
import { FakeClock, flushMicrotasks } from './test-support/fake-clock';
import { DEFAULT_PREFERENCES } from '../shared/session-contract';
import type { InferenceInput, InferenceProvider } from './fake-inference';
import type { VideoFrame } from '../shared/video-contract';

const jpeg = 'data:image/jpeg;base64,/9j/';
function frame(clock: FakeClock): VideoFrame {
  return {
    sourceId: 'camera:test-camera',
    observedAt: clock.wallNow(),
    dataUrl: jpeg,
    width: 160,
    height: 90,
  };
}

describe('live video across the session and native inference boundary', () => {
  it('includes preview baseline and new interval frames, reacts with original event timestamps and outputs chat', async () => {
    const clock = new FakeClock();
    const chat = new ChatService();
    const inputs: InferenceInput[] = [];
    const provider: InferenceProvider = {
      generate: async (input) => {
        inputs.push(input);
        return {
          events: [{ kind: 'reaction', summary: 'A character jumped', ageMs: 500 }],
          messages: [{ author: 'pixelpilot', color: '#bba5ff', text: 'nice jump!', offsetMs: 0 }],
        };
      },
    };
    const session = new SessionController(
      chat,
      undefined,
      clock,
      { ...DEFAULT_PREFERENCES, baselineMs: 1000, cycleIntervalMs: 3000 },
      provider,
    );
    session.selectVideoSource('camera:test-camera');
    // Capture can begin before Start; a baseline observation must not be lost.
    session.recordVideoFrame(frame(clock));
    clock.advance(500);
    expect(session.start('', 'native').phase).toBe('starting');
    clock.advance(900);
    session.recordVideoFrame(frame(clock));
    clock.advance(100);
    await flushMicrotasks();
    expect(inputs).toHaveLength(1);
    expect(inputs[0].context).toContain('live video');
    expect(inputs[0].frames?.map((item) => item.observedAt)).toEqual([
      clock.wallNow() - 1500,
      clock.wallNow() - 100,
    ]);
    expect(session.snapshot().events).toEqual([
      {
        kind: 'reaction',
        summary: 'A character jumped',
        observedAt: clock.wallNow() - 500,
      },
    ]);
    expect(chat.snapshot().messages.map((item) => item.text)).toEqual(['nice jump!']);
    clock.advance(500);
    session.recordVideoFrame(frame(clock));
    clock.advance(1000);
    session.recordVideoFrame(frame(clock));
    clock.advance(1500);
    await flushMicrotasks();
    expect(inputs).toHaveLength(2);
    expect(inputs[1].frames?.map((item) => item.observedAt)).toEqual([
      clock.wallNow() - 2500,
      clock.wallNow() - 1500,
    ]);
    session.selectVideoSource(null);
    clock.advance(3000);
    await flushMicrotasks();
    expect(inputs.at(-1)?.frames).toEqual([]);
    await session.terminate();
  });

  it('supplies ordered real images to llama.cpp without duplicating bytes in the text prompt', () => {
    const input: InferenceInput = {
      context: 'gameplay',
      cycle: 3,
      frames: [
        { sourceId: 'display:screen:0:0', observedAt: 1000, width: 160, height: 90, dataUrl: jpeg },
        { sourceId: 'display:screen:0:0', observedAt: 3000, width: 160, height: 90, dataUrl: jpeg },
      ],
    };
    const request = nativeChatRequest(input);
    const content = request.messages[1].content;
    expect(Array.isArray(content)).toBe(true);
    if (!Array.isArray(content)) throw new Error('Expected multimodal content array');
    expect(content.map((item) => item.type)).toEqual([
      'text',
      'text',
      'image_url',
      'text',
      'image_url',
    ]);
    expect(
      JSON.parse(content[0].text ?? '').videoFrames.map((item: VideoFrame) => item.observedAt),
    ).toEqual([1000, 3000]);
    expect(content[0].text ?? '').not.toContain('data:image/jpeg');
    expect(content[2]).toMatchObject({ image_url: { url: jpeg } });
    expect(content[3].text ?? '').toContain('observedAt=3000');
    expect(content[4]).toMatchObject({ image_url: { url: jpeg } });
  });

  it('rejects stale and mismatched capture while keeping a zero-video session functional', async () => {
    const clock = new FakeClock();
    const chat = new ChatService();
    const session = new SessionController(chat, undefined, clock);
    session.selectVideoSource('camera:test-camera');
    expect(() => session.recordVideoFrame({ ...frame(clock), sourceId: 'camera:wrong' })).toThrow();
    expect(() =>
      session.recordVideoFrame({ ...frame(clock), observedAt: clock.wallNow() - 46000 }),
    ).toThrow();
    session.selectVideoSource(null);
    expect(() => session.recordVideoFrame(frame(clock))).toThrow();
    session.start('no video');
    await flushMicrotasks();
    expect(session.snapshot().phase).toBe('running');
    await session.terminate();
  });
});
