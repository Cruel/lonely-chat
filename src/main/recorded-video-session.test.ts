import { describe, expect, it } from 'vitest';
import { ChatService } from './chat-service';
import { SessionController } from './session-controller';
import { RecordedVideoTimeline } from '../renderer/recorded-video-timeline';
import { FakeClock, flushMicrotasks } from './test-support/fake-clock';
import { DEFAULT_PREFERENCES } from '../shared/session-contract';
import type { InferenceInput, InferenceProvider } from './fake-inference';

const jpeg = 'data:image/jpeg;base64,/9j/';
const recorded = { inputMode: 'recorded' as const, publishToOverlay: false, hasVideoFile: true };

describe('real-time recorded producer through the production session', () => {
  it('uses monotonic observation timestamps, preserves PTS, and drops duplicate/over-cadence samples', () => {
    const timeline = new RecordedVideoTimeline(1700, 100, 500);
    expect(timeline.sample(0, 100)).toEqual({ observedAt: 1700, mediaTimeMs: 0 });
    expect(timeline.sample(0.03, 130)).toBeNull();
    expect(timeline.sample(0.5, 600)).toEqual({ observedAt: 2200, mediaTimeMs: 500 });
    expect(timeline.sample(0.5, 1100)).toBeNull();
    expect(timeline.sample(1.5, 1600)).toEqual({ observedAt: 3200, mediaTimeMs: 1500 });
    // Late decoder wakeups retain their media timestamps instead of acquiring
    // a new wall-time timestamp and hiding gaps in real-time decoding.
    expect(timeline.sample(2, 2600)).toEqual({ observedAt: 3700, mediaTimeMs: 2000 });
    // Decoder discontinuities must not move timestamps backwards.
    expect(timeline.sample(0.2, 1800)).toBeNull();
  });

  it('shifts observation time by paused wall time without advancing media PTS', () => {
    const timeline = new RecordedVideoTimeline(20000, 1000, 100);
    expect(timeline.sample(0, 1000)).toEqual({ observedAt: 20000, mediaTimeMs: 0 });
    expect(timeline.sample(0.1, 1100)).toEqual({ observedAt: 20100, mediaTimeMs: 100 });
    timeline.shiftObservationTime(30000);
    expect(timeline.sample(0.2, 31100)).toEqual({ observedAt: 50200, mediaTimeMs: 200 });
    expect(timeline.sample(0.2, 31200)).toBeNull();
    expect(timeline.sample(0.3, 31200)).toEqual({ observedAt: 50300, mediaTimeMs: 300 });
  });

  it('keeps sampling at 1× while native inference is blocked and uses ordinary boundaries, events, chat and retries', async () => {
    const clock = new FakeClock();
    const chat = new ChatService();
    const inputs: InferenceInput[] = [];
    let completeFirst!: (value: unknown) => void;
    let attempts = 0;
    const successful = {
      events: [{ kind: 'reaction', summary: 'door opened', ageMs: 100 }],
      messages: [{ author: 'observer', color: '#ffffff', text: 'wow', offsetMs: 0 }],
    };
    const provider: InferenceProvider = {
      generate: (input) => {
        inputs.push(input);
        attempts++;
        if (attempts === 1)
          return new Promise((resolve) => {
            completeFirst = resolve;
          });
        if (attempts === 2) return Promise.reject(new Error('transient worker failure'));
        return Promise.resolve(successful);
      },
    };
    const session = new SessionController(
      chat,
      undefined,
      clock,
      { ...DEFAULT_PREFERENCES, baselineMs: 1000, cycleIntervalMs: 3000 },
      provider,
    );
    session.selectVideoSource('recorded:video');
    const timeline = new RecordedVideoTimeline(clock.wallNow(), clock.now(), 500);
    const frame = (positionMs: number) => {
      const timestamp = timeline.sample(positionMs / 1000, clock.now());
      if (!timestamp) return;
      session.recordVideoFrame({
        sourceId: 'recorded:video',
        ...timestamp,
        dataUrl: jpeg,
        width: 160,
        height: 90,
      });
    };
    frame(0);
    session.start('', 'native', 'installed-model', recorded);
    clock.advance(500);
    frame(500);
    clock.advance(500); // Baseline starts inference; file frames are independent.
    await flushMicrotasks();
    expect(inputs[0].frames?.map((item) => item.mediaTimeMs)).toEqual([0, 500]);
    expect(inputs[0].context).toContain('recorded video');
    for (let position = 1500; position <= 5500; position += 500) {
      clock.advance(500);
      frame(position);
    }
    expect(session.snapshot().cycle).toBe(1);
    expect(inputs).toHaveLength(1); // Native request remains in-flight.
    completeFirst(successful);
    await flushMicrotasks();
    expect(session.snapshot().events[0].summary).toBe('door opened');
    expect(chat.snapshot().messages.map((item) => item.text)).toEqual(['wow']);
    expect(chat.publicSnapshot().messages).toEqual([]);
    // Production timer and retry policy are still responsible for the second cycle.
    clock.advance(5000);
    await flushMicrotasks();
    expect(inputs.length).toBeGreaterThanOrEqual(2);
    expect(inputs[1].frames?.every((item) => (item.mediaTimeMs ?? 0) >= 1500)).toBe(true);
    clock.advance(500);
    await flushMicrotasks();
    expect(inputs).toHaveLength(3);
    expect(inputs[2].frames).toEqual(inputs[1].frames); // Exact snapshot retried.
    expect(chat.snapshot().messages.length).toBeGreaterThan(1);
    expect(chat.publicSnapshot().messages).toEqual([]);
    await session.terminate();
  });

  it('keeps recorded zero-file mode and explicit publication opt-in functional', async () => {
    const clock = new FakeClock();
    const chat = new ChatService();
    const session = new SessionController(chat, undefined, clock);
    session.start('No video provided', 'fake', null, {
      inputMode: 'recorded',
      publishToOverlay: true,
      hasVideoFile: false,
    });
    await flushMicrotasks();
    expect(session.snapshot().phase).toBe('running');
    expect(chat.publicSnapshot().messages.length).toBeGreaterThan(0);
    expect(session.snapshot().inputMode).toBe('recorded');
    session.stop();
    expect(() => session.failRecordedVideo('decoder died')).toThrow(/No recorded simulation/);
    await session.terminate();
  });

  it('surfaces decoder failure and cancels scheduled inference and chat without leaking private output', async () => {
    const clock = new FakeClock();
    const chat = new ChatService();
    const session = new SessionController(chat, undefined, clock);
    session.start('recorded source', 'fake', null, recorded);
    await flushMicrotasks();
    expect(session.failRecordedVideo('codec not supported').error).toContain('codec not supported');
    expect(session.snapshot().phase).toBe('error');
    expect(() => session.retry()).toThrow(/Select a supported file/);
    const count = chat.snapshot().messages.length;
    clock.advance(60000);
    await flushMicrotasks();
    expect(chat.snapshot().messages).toHaveLength(count);
    expect(chat.publicSnapshot().messages).toEqual([]);
    await session.terminate();
  });
});
