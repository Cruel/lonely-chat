import { expect, it, vi } from 'vitest';
import { SessionMedia } from './session-media';
import { SessionController } from './session-controller';
import { AudioService } from './audio-service';
import { ChatService } from './chat-service';
import type { NativeSpeech } from './native-speech';
import type { InferenceInput, InferenceProvider } from './fake-inference';
import { FakeClock, flushMicrotasks } from './test-support/fake-clock';

it('retains STT completed during switching and stops all producers through the desktop/tray seam', async () => {
  const clock = new FakeClock();
  const inputs: InferenceInput[] = [];
  const provider: InferenceProvider = {
    generate: async (input) => {
      inputs.push(input);
      return {
        events: [],
        messages: [
          { author: 'viewer', color: '#ffffff', text: 'visible', offsetMs: 0 },
          { author: 'viewer', color: '#ffffff', text: 'pending', offsetMs: 5000 },
        ],
      };
    },
  };
  const chat = new ChatService();
  const session = new SessionController(chat, undefined, clock, undefined, provider);
  const retire = vi.fn();
  let media!: SessionMedia;
  const audio = new AudioService(
    () =>
      ({
        start: async () => {},
        stop: retire,
        transcribe: async () => 'speech during model switch',
      }) as unknown as NativeSpeech,
    (entry) => media.recordTranscript(entry),
    clock.wallNow,
  );
  const stopCapture = vi.fn();
  media = new SessionMedia(session, audio, stopCapture);
  session.start('stream', 'native');
  await flushMicrotasks();
  await audio.start('streamer', 'mic-a', 'Streamer', 'capture-a');
  await audio.start('guest', 'mic-b', 'Guest', 'capture-b');
  let finishActivation!: () => void;
  const switching = session.switchNativeModel(
    () =>
      new Promise<void>((resolve) => {
        finishActivation = resolve;
      }),
    'next',
  );
  await flushMicrotasks();
  expect(session.snapshot().phase).toBe('switching');
  clock.advance(10);
  audio.submit({ samples: new Float32Array(1600).fill(0.2) }, 'capture-b');
  await flushMicrotasks();
  finishActivation();
  await switching;
  await flushMicrotasks();
  expect(inputs.at(-1)?.recentTranscripts).toMatchObject([
    { source: 'Guest', text: 'speech during model switch', observedAt: clock.wallNow() },
  ]);
  session.selectVideoSource('camera:test');
  const retained = chat.snapshot().sequence;
  expect(retained).toBeGreaterThan(0);
  expect(media.stop().phase).toBe('stopped');
  expect(stopCapture).toHaveBeenCalledOnce();
  expect(retire).toHaveBeenCalledTimes(2);
  expect(audio.snapshot().sources.every((source) => source.phase === 'off')).toBe(true);
  expect(() =>
    session.recordVideoFrame({
      sourceId: 'camera:test',
      observedAt: clock.wallNow(),
      width: 1,
      height: 1,
      dataUrl: 'data:image/jpeg;base64,/9j/',
    }),
  ).toThrow(/inactive/);
  clock.advance(10000);
  await flushMicrotasks();
  expect(chat.snapshot().sequence).toBe(retained);
  expect(session.snapshot().pendingMessages).toBe(0);
  await session.terminate();
  await audio.terminate();
});

it('continues accepting recorded frames through retry exhaustion and manual Retry using the IPC media boundary', async () => {
  const clock = new FakeClock();
  const inputs: InferenceInput[] = [];
  let fail = true;
  const provider: InferenceProvider = {
    generate: async (input) => {
      inputs.push(input);
      if (fail) throw new Error('temporary llama failure');
      return {
        events: [],
        messages: [{ author: 'viewer', color: '#ffffff', text: 'recovered', offsetMs: 0 }],
      };
    },
  };
  const chat = new ChatService();
  const session = new SessionController(chat, undefined, clock, undefined, provider);
  const audio = new AudioService(
    () =>
      ({
        start: async () => {},
        stop: () => {},
        transcribe: async () => '',
      }) as unknown as NativeSpeech,
    () => {},
  );
  const media = new SessionMedia(session, audio, () => {});
  session.selectVideoSource('recorded:video');
  session.start('recorded playback', 'native', 'model', {
    inputMode: 'recorded',
    publishToOverlay: false,
    hasVideoFile: true,
  });
  const frame = (at: number) =>
    media.recordVideoFrame({
      sourceId: 'recorded:video',
      observedAt: at,
      mediaTimeMs: at - 1700000000000,
      width: 2,
      height: 2,
      dataUrl: 'data:image/jpeg;base64,/9j/',
    });
  frame(clock.wallNow());
  await flushMicrotasks();
  clock.advance(500);
  await flushMicrotasks();
  clock.advance(1000);
  await flushMicrotasks();
  expect(session.snapshot().phase).toBe('error');
  // Frames from the recorded producer are still accepted by the same video:frame delegate.
  frame(clock.wallNow());
  expect(() =>
    media.recordVideoFrame({
      sourceId: 'camera:stale',
      observedAt: clock.wallNow(),
      width: 2,
      height: 2,
      dataUrl: 'data:image/jpeg;base64,/9j/',
    }),
  ).not.toThrow();
  fail = false;
  session.retry();
  await flushMicrotasks();
  expect(inputs.at(-1)?.frames?.length).toBeGreaterThan(0);
  expect(chat.snapshot().messages.some((message) => message.text === 'recovered')).toBe(true);
  expect(chat.publicSnapshot().messages).toEqual([]);
  media.stop();
  await session.terminate();
  await audio.terminate();
});

it('retiring a failed recorded decoder stops audio and renderer capture while retaining the visible error', async () => {
  const clock = new FakeClock();
  const session = new SessionController(new ChatService(), undefined, clock);
  const stopWorker = vi.fn(async () => {});
  const audio = new AudioService(
    () =>
      ({
        start: async () => {},
        stop: stopWorker,
        transcribe: async () => '',
      }) as unknown as NativeSpeech,
    () => {},
    clock.wallNow,
  );
  const stopCapture = vi.fn();
  const media = new SessionMedia(session, audio, stopCapture);
  await audio.start('microphone', 'mic', 'Voice', 'capture');
  session.selectVideoSource('recorded:video');
  session.start('stream', 'fake', null, {
    inputMode: 'recorded',
    publishToOverlay: false,
    hasVideoFile: true,
  });
  const state = media.failRecordedVideo('Unsupported codec');
  expect(state.phase).toBe('error');
  expect(state.error).toContain('Unsupported codec');
  expect(stopWorker).toHaveBeenCalledOnce();
  expect(stopCapture).toHaveBeenCalledOnce();
  expect(audio.snapshot().sources.every((source) => source.phase === 'off')).toBe(true);
  expect(() =>
    session.recordVideoFrame({
      sourceId: 'recorded:video',
      observedAt: clock.wallNow(),
      width: 1,
      height: 1,
      dataUrl: 'data:image/jpeg;base64,/9j/',
    }),
  ).toThrow(/inactive/);
  await session.terminate();
  await audio.terminate();
});
