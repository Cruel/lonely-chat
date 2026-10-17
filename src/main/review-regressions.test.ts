import { afterEach, expect, it, vi } from 'vitest';
import { ChatService } from './chat-service';
import { SessionController } from './session-controller';
import { systemClock } from './chat-scheduler';
import { VideoFrameBuffer } from './video-frame-buffer';
import { DiagnosticCapture } from './diagnostic-capture';
import { FakeClock, flushMicrotasks } from './test-support/fake-clock';

afterEach(() => vi.restoreAllMocks());

it('keeps observation timestamps and sampling increasing when the calendar clock jumps backward', () => {
  let elapsed = 100;
  vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
  vi.spyOn(Date, 'now').mockReturnValue(1);
  const before = systemClock.wallNow();
  const video = new VideoFrameBuffer();
  video.selectSource('camera:test');
  const frame = {
    sourceId: 'camera:test',
    width: 1,
    height: 1,
    dataUrl: 'data:image/jpeg;base64,/9j/',
    observedAt: before,
  };
  video.push(frame, before);
  elapsed += 1000;
  vi.spyOn(Date, 'now').mockReturnValue(-1_000_000);
  const after = systemClock.wallNow();
  expect(after - before).toBe(1000);
  video.push({ ...frame, observedAt: after }, after);
  expect(video.sample(before, after, false).frames.map((item) => item.observedAt)).toEqual([after]);
});

it('rejects events predating the supplied evidence atomically at the session boundary', async () => {
  const clock = new FakeClock();
  const chat = new ChatService();
  const session = new SessionController(
    chat,
    {
      generate: async () => ({
        events: [{ kind: 'reaction', summary: 'invented earlier event', ageMs: 50000 }],
        messages: [
          { author: 'pixelpilot', color: '#ffffff', text: 'must not publish', offsetMs: 0 },
        ],
      }),
    },
    clock,
  );
  session.start('current context');
  await flushMicrotasks();
  expect(session.snapshot().warning).toMatch(/invalid event/);
  expect(session.snapshot().events).toEqual([]);
  expect(chat.snapshot().messages).toEqual([]);
  session.stop();
});

it('keeps opt-in samples bounded, discards them on disable and rejects stale capture generations', () => {
  const capture = new DiagnosticCapture(600, 2);
  const input = { context: 'private context', cycle: 1 };
  const disabledToken = capture.token();
  capture.record(input, 10, {});
  expect(capture.status().samples).toBe(0);
  expect(() => capture.export()).toThrow(/Enable/);
  capture.configure(true);
  capture.record(input, 10, {}, disabledToken);
  expect(capture.status().samples).toBe(0);
  const token = capture.token();
  for (let cycle = 1; cycle <= 3; cycle++) capture.record({ ...input, cycle }, 10, {});
  expect(capture.status()).toMatchObject({ samples: 2, dropped: 1 });
  expect(
    JSON.parse(capture.export()).samples.map(
      (item: { input: { cycle: number } }) => item.input.cycle,
    ),
  ).toEqual([2, 3]);
  capture.record({ ...input, context: 'x'.repeat(1000) }, 20, {});
  expect(capture.status()).toMatchObject({ samples: 2, dropped: 2 });
  capture.configure(false);
  expect(capture.status()).toMatchObject({ enabled: false, samples: 0, bytes: 0 });
  capture.configure(true);
  capture.record(input, 10, {}, token);
  expect(capture.status().samples).toBe(0);
});
