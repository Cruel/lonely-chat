import { describe, expect, it, vi } from 'vitest';
import { ChatService } from './chat-service';
import { AudioService } from './audio-service';
import { SessionMedia } from './session-media';
import type { NativeSpeech } from './native-speech';
import { DEFAULT_PREFERENCES } from '../shared/session-contract';
import { SessionController } from './session-controller';
import { InferenceTrace } from './inference-trace';
import { attemptTimeline } from '../renderer/run-timeline';
import type { InferenceProvider } from './fake-inference';
import { FakeClock, flushMicrotasks } from './test-support/fake-clock';

const recorded = { inputMode: 'recorded' as const, publishToOverlay: false };

describe('recorded Run pause, Stop and EOF', () => {
  it('freezes both cycle starts and scheduled visible chat, then resumes with remaining delays', async () => {
    const clock = new FakeClock();
    const chat = new ChatService();
    const session = new SessionController(chat, undefined, clock, { cycleIntervalMs: 1500 });
    session.start('scene', 'fake', null, recorded);
    await flushMicrotasks();
    expect(chat.snapshot().messages).toHaveLength(1);
    clock.advance(400);
    session.pauseRecorded();
    expect(session.snapshot().recordedPlayback).toBe('paused');
    clock.advance(10000);
    await flushMicrotasks();
    expect(session.snapshot().cycle).toBe(1);
    expect(chat.snapshot().messages).toHaveLength(1);
    session.resumeRecorded();
    clock.advance(499);
    expect(chat.snapshot().messages).toHaveLength(1);
    clock.advance(1);
    expect(chat.snapshot().messages).toHaveLength(2);
    clock.advance(600);
    await flushMicrotasks();
    expect(session.snapshot().cycle).toBe(2);
    session.stop();
  });

  it('uses one pause-adjusted Inspector clock for observations, deadlines and publications', async () => {
    const clock = new FakeClock();
    const chat = new ChatService();
    const trace = new InferenceTrace();
    const provider: InferenceProvider = {
      generate: async () => ({
        events: [],
        messages: [{ author: 'pixelpilot', color: '#bba5ff', text: 'later', offsetMs: 1500 }],
      }),
    };
    const session = new SessionController(
      chat,
      provider,
      clock,
      { cycleIntervalMs: 5000 },
      undefined,
      undefined,
      undefined,
      undefined,
      trace,
    );
    const physicalStart = clock.wallNow();
    session.start('scene', 'fake', null, recorded);
    await flushMicrotasks();
    const traceId = trace.list().attempts[0].id;
    const pendingBeforePause = attemptTimeline(trace.get(traceId)!).find(
      (item) => item.key === 'message-0',
    );
    expect(pendingBeforePause?.timestamp).toBe(physicalStart + 1500);
    expect(pendingBeforePause?.state).toBe('pending');
    clock.advance(400);
    session.pauseRecorded();
    clock.advance(10000);
    const pendingDuringPause = attemptTimeline(trace.get(traceId)!).find(
      (item) => item.key === 'message-0',
    );
    expect(pendingDuringPause?.timestamp).toBe(physicalStart + 1500);
    expect(pendingDuringPause?.state).toBe('pending');
    session.resumeRecorded();
    clock.advance(1100);
    await flushMicrotasks();
    const attempt = trace.get(traceId)!;
    const scheduled = attempt.scheduled as {
      enqueuedAt: number;
      enqueuedPhysicalAt: number;
      clockDomain: string;
    };
    expect(scheduled.clockDomain).toBe('pause-adjusted');
    expect(scheduled.enqueuedAt).toBe(physicalStart);
    expect(scheduled.enqueuedPhysicalAt).toBe(physicalStart);
    expect(attempt.presented).toMatchObject([
      { presentedAt: physicalStart + 11500, timelineAt: physicalStart + 1500 },
    ]);
    const entries = attemptTimeline(attempt);
    const planned = entries.find((item) => item.key === 'message-0');
    expect(planned?.timestamp).toBe(physicalStart + 1500);
    expect(planned?.state).toBe('shown');
    expect(planned?.physicalTimestamp).toBe(physicalStart + 11500);
    session.stop();
  });

  it('holds a completed native inference attempt while paused without regenerating it', async () => {
    const clock = new FakeClock();
    const chat = new ChatService();
    let complete!: (reply: unknown) => void;
    const generate = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          complete = resolve;
        }),
    );
    const native: InferenceProvider = { generate };
    const session = new SessionController(chat, undefined, clock, undefined, native);
    session.start('scene', 'native', 'model', recorded);
    await flushMicrotasks();
    expect(generate).toHaveBeenCalledTimes(1);
    session.pauseRecorded();
    complete({
      events: [],
      messages: [{ author: 'pixelpilot', color: '#bba5ff', text: 'hello', offsetMs: 0 }],
    });
    await flushMicrotasks();
    expect(chat.snapshot().messages).toHaveLength(0);
    expect(session.snapshot().pendingMessages).toBe(0);
    session.resumeRecorded();
    await flushMicrotasks();
    expect(chat.snapshot().messages.map((message) => message.text)).toEqual(['hello']);
    expect(generate).toHaveBeenCalledTimes(1);
    session.stop();
  });

  it('drains late transcripts through one last cycle, then waits for accepted chat deadlines', async () => {
    const clock = new FakeClock();
    const chat = new ChatService();
    let finishFirst!: (value: unknown) => void;
    const seen: string[][] = [];
    const native: InferenceProvider = {
      generate: (input) => {
        seen.push((input.recentTranscripts ?? []).map((entry) => entry.text));
        if (input.cycle === 1)
          return new Promise((resolve) => {
            finishFirst = resolve;
          });
        return Promise.resolve({
          events: [],
          messages: [
            {
              author: 'pixelpilot',
              color: '#bba5ff',
              text: 'last message',
              offsetMs: 1200,
            },
          ],
        });
      },
    };
    const session = new SessionController(
      chat,
      undefined,
      clock,
      { cycleIntervalMs: 1500 },
      native,
    );
    session.start('scene', 'native', 'model', recorded);
    await flushMicrotasks();
    session.recordTranscript({
      sourceId: 'one',
      source: 'Guest',
      text: 'first late transcript',
      observedAt: clock.wallNow(),
    });
    session.recordTranscript({
      sourceId: 'two',
      source: 'Host',
      text: 'second late transcript',
      observedAt: clock.wallNow(),
    });
    session.finishRecorded();
    expect(session.snapshot().recordedPlayback).toBe('draining');
    finishFirst({ events: [], messages: [] });
    await flushMicrotasks();
    expect(seen).toEqual([[], ['first late transcript', 'second late transcript']]);
    expect(session.snapshot().cycle).toBe(2);
    expect(session.snapshot().pendingMessages).toBe(1);
    expect(session.snapshot().phase).toBe('running');
    clock.advance(1199);
    expect(chat.snapshot().messages).toHaveLength(0);
    clock.advance(1);
    await flushMicrotasks();
    expect(chat.snapshot().messages.map((m) => m.text)).toEqual(['last message']);
    expect(session.snapshot().phase).toBe('stopped');
    expect(session.snapshot().recordedPlayback).toBe('completed');
    clock.advance(20000);
    await flushMicrotasks();
    expect(seen).toHaveLength(2);
  });

  it('Stop while paused cancels pending native output and scheduled chat immediately', async () => {
    const clock = new FakeClock();
    const chat = new ChatService();
    let complete!: (value: unknown) => void;
    const stop = vi.fn(async () => {});
    const native: InferenceProvider = {
      generate: () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
      stop,
    };
    const session = new SessionController(chat, undefined, clock, undefined, native);
    session.start('scene', 'native', 'model', recorded);
    await flushMicrotasks();
    session.pauseRecorded();
    expect(session.stop().phase).toBe('stopped');
    complete({
      events: [],
      messages: [{ author: 'pixelpilot', color: '#bba5ff', text: 'stale', offsetMs: 0 }],
    });
    clock.advance(20000);
    await flushMicrotasks();
    expect(chat.snapshot().messages).toHaveLength(0);
    expect(session.snapshot().recordedPlayback).toBeNull();
    expect(stop).toHaveBeenCalled();
  });

  it('waits for pending Whisper text while paused before its final inference cycle', async () => {
    const clock = new FakeClock();
    const observed: string[][] = [];
    const inference: InferenceProvider = {
      generate: async (input) => {
        observed.push((input.recentTranscripts ?? []).map((entry) => entry.text));
        return { events: [], messages: [] };
      },
    };
    const session = new SessionController(new ChatService(), inference, clock, {
      baselineMs: 5000,
      cycleIntervalMs: 1500,
    });
    let media!: SessionMedia;
    let deliverSpeech!: (text: string) => void;
    const transcribe = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          deliverSpeech = resolve;
        }),
    );
    const audio = new AudioService(
      () => ({ start: async () => {}, transcribe, stop: () => {} }) as unknown as NativeSpeech,
      (entry) => media.recordTranscript(entry),
      clock.wallNow,
      clock,
    );
    media = new SessionMedia(session, audio, () => {});
    session.start('stream', 'fake', null, recorded);
    await audio.startRecorded({
      id: 'speech-source',
      label: 'Guest',
      captureId: 'speech-capture',
      sampleRate: 16000,
      offsetMs: 0,
      seekMs: 0,
    });
    audio.armRecorded('speech-capture', clock.wallNow(), 0);
    for (let n = 0; n < 10; n++) {
      clock.advance(100);
      audio.pushRecorded(new Float32Array(1600).fill(0.2), 'speech-capture');
    }
    const finishing = audio.finishRecorded('speech-capture');
    await flushMicrotasks();
    expect(transcribe).toHaveBeenCalled();
    session.pauseRecorded();
    audio.pauseRecorded();
    deliverSpeech('Whisper completed during pause');
    await finishing;
    expect(session.snapshot().cycle).toBe(0);
    session.finishRecorded();
    clock.advance(10000);
    await flushMicrotasks();
    expect(observed).toHaveLength(0);
    audio.resumeRecorded();
    session.resumeRecorded();
    await flushMicrotasks();
    expect(observed).toEqual([['Whisper completed during pause']]);
    expect(session.snapshot().recordedPlayback).toBe('completed');
    await audio.terminate();
  });

  it('retains recorded video and late Whisper observations across a long pause', async () => {
    const clock = new FakeClock();
    const captured: Array<{ frames: number[]; transcripts: string[] }> = [];
    const inference: InferenceProvider = {
      generate: async (input) => {
        captured.push({
          frames: (input.frames ?? []).map((frame) => frame.observedAt),
          transcripts: (input.recentTranscripts ?? []).map((entry) => entry.text),
        });
        return { events: [], messages: [] };
      },
    };
    const session = new SessionController(new ChatService(), inference, clock, {
      ...DEFAULT_PREFERENCES,
      baselineMs: 5000,
    });
    session.selectVideoSource('recorded:video');
    session.start('scene', 'fake', null, recorded);
    const originalTime = clock.wallNow();
    session.recordVideoFrame({
      sourceId: 'recorded:video',
      observedAt: originalTime,
      mediaTimeMs: 0,
      width: 32,
      height: 18,
      dataUrl: 'data:image/jpeg;base64,/9j/',
    });
    clock.advance(500);
    session.pauseRecorded();
    clock.advance(180000); // Longer than both the transcript and video history windows.
    session.recordTranscript({
      sourceId: 'guest',
      source: 'Guest',
      text: 'speech resolved during pause',
      observedAt: originalTime + 250,
    });
    expect(captured).toHaveLength(0);
    session.resumeRecorded();
    clock.advance(4500);
    await flushMicrotasks();
    expect(captured).toHaveLength(1);
    expect(captured[0].frames).toEqual([originalTime]);
    expect(captured[0].transcripts).toEqual(['speech resolved during pause']);
    session.stop();
  });

  it('reschedules native inference when a model is switched during pause', async () => {
    const clock = new FakeClock();
    const generate = vi.fn(async () => ({ events: [], messages: [] }));
    const native: InferenceProvider = {
      generate,
      stop: vi.fn(async () => {}),
      prepare: vi.fn(async () => {}),
    };
    const session = new SessionController(new ChatService(), undefined, clock, undefined, native);
    session.start('scene', 'native', 'initial-model', recorded);
    await flushMicrotasks();
    expect(generate).toHaveBeenCalledTimes(1);
    session.pauseRecorded();
    await session.switchNativeModel(async () => {}, 'next-model');
    clock.advance(5000);
    await flushMicrotasks();
    expect(generate).toHaveBeenCalledTimes(1);
    session.resumeRecorded();
    clock.advance(0);
    await flushMicrotasks();
    expect(generate).toHaveBeenCalledTimes(2);
    expect(session.snapshot().modelId).toBe('next-model');
    session.stop();
  });

  it('preserves a paused explicit retry when all sources end before resume', async () => {
    const clock = new FakeClock();
    let attempts = 0;
    const native: InferenceProvider = {
      generate: async () => {
        attempts++;
        if (attempts <= 3) throw new Error('transient native failure');
        return { events: [], messages: [] };
      },
    };
    const session = new SessionController(new ChatService(), undefined, clock, undefined, native);
    session.start('scene', 'native', 'model', recorded);
    await flushMicrotasks();
    clock.advance(500);
    await flushMicrotasks();
    clock.advance(1000);
    await flushMicrotasks();
    expect(session.snapshot().phase).toBe('error');
    session.pauseRecorded();
    session.retry();
    session.finishRecorded();
    clock.advance(10000);
    await flushMicrotasks();
    expect(attempts).toBe(3);
    session.resumeRecorded();
    clock.advance(0);
    await flushMicrotasks();
    expect(attempts).toBe(4);
    expect(session.snapshot().recordedPlayback).toBe('completed');
  });

  it('rejects pause and EOF controls for live and stopped sessions', () => {
    const session = new SessionController(new ChatService());
    expect(() => session.pauseRecorded()).toThrow(/recorded simulation/);
    session.start('live', 'fake');
    expect(() => session.finishRecorded()).toThrow(/recorded simulation/);
    session.stop();
    expect(() => session.resumeRecorded()).toThrow(/recorded simulation/);
  });
});
