import { describe, expect, it, vi } from 'vitest';
import { SpeechPlaygroundService } from './speech-playground-service';
import { ChatService } from './chat-service';
import { SessionController } from './session-controller';
import type { NativeServiceStatus } from '../shared/native-service-contract';

function fakeWorker(transcribe = vi.fn(async (_samples: Float32Array) => ' hello there ')) {
  const subscribers = new Set<(status: NativeServiceStatus) => void>();
  return {
    start: vi.fn(async () => {}),
    stop: vi.fn(),
    shutdown: vi.fn(async () => {}),
    transcribe,
    subscribe: vi.fn((cb: (status: NativeServiceStatus) => void) => {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    }),
    failed(message: string) {
      for (const cb of subscribers) cb({ revision: 1, phase: 'failed', error: message });
    },
  };
}

function pcm(rate: number, duration: number, intervals: readonly [number, number][]): Float32Array {
  return Float32Array.from({ length: Math.round(rate * duration) }, (_v, index) =>
    intervals.some(([start, end]) => index / rate >= start && index / rate < end)
      ? 0.15 * Math.sin(index * 0.3)
      : 0,
  );
}

async function feed(service: SpeechPlaygroundService, samples: Float32Array, rate: number) {
  const block = rate / 10;
  for (let i = 0; i < samples.length; i += block)
    await service.push(samples.subarray(i, i + block), true);
}

describe('isolated speech Playground', () => {
  it('runs resampling and real live VAD over synthetic PCM, reports labeled boundaries and leaves chat/history untouched', async () => {
    const chat = new ChatService();
    const session = new SessionController(chat);
    const beforeChat = chat.snapshot();
    const beforeSession = session.snapshot();
    const worker = fakeWorker();
    const service = new SpeechPlaygroundService(() => worker);
    await service.start({
      mode: 'live-equivalent',
      sourceId: 'mic-1',
      label: 'Caster',
      sampleRate: 48000,
    });
    const audio = pcm(48000, 1.9, [[0.3, 0.85]]);
    await feed(service, audio, 48000);
    await service.finish();
    const status = service.snapshot();
    expect(status.segments).toHaveLength(1);
    expect(status.segments[0]).toMatchObject({
      sourceId: 'mic-1',
      label: 'Caster',
      phase: 'transcribed',
      text: 'hello there',
    });
    expect(status.segments[0].startMs).toBeGreaterThanOrEqual(100);
    expect(status.segments[0].startMs).toBeLessThanOrEqual(300);
    expect(status.segments[0].endMs).toBeGreaterThan(850);
    expect(status.segments[0].endMs).toBeLessThanOrEqual(1200);
    expect(worker.transcribe).toHaveBeenCalledTimes(1);
    expect(worker.transcribe.mock.calls[0][0].length).toBeGreaterThan(8000);
    expect(chat.snapshot()).toEqual(beforeChat);
    expect(session.snapshot()).toEqual(beforeSession);
    await service.stop();
    expect(worker.stop).toHaveBeenCalled();
    expect(worker.shutdown).toHaveBeenCalled();
    expect(service.snapshot().segments[0].text).toBe('hello there');
    expect(service.snapshot().phase).toBe('idle');
  });

  it('separates explicitly whole-file mode from live VAD and transcribes one complete clip', async () => {
    const worker = fakeWorker();
    const service = new SpeechPlaygroundService(() => worker);
    await service.start({
      mode: 'whole-file',
      sourceId: 'file',
      label: 'Uploaded interview',
      sampleRate: 16000,
    });
    await feed(
      service,
      pcm(16000, 2, [
        [0.2, 0.5],
        [1.2, 1.6],
      ]),
      16000,
    );
    await service.finish();
    expect(worker.transcribe).toHaveBeenCalledTimes(1);
    expect(service.snapshot().segments).toMatchObject([
      { label: 'Uploaded interview', sourceId: 'file', startMs: 0, phase: 'transcribed' },
    ]);
    expect(service.snapshot().segments[0].endMs).toBeGreaterThan(1900);
    await service.stop();
  });

  it('records native worker errors and segment failures without sending them to a Session', async () => {
    const transcribe = vi.fn(async (_samples: Float32Array) => {
      throw new Error('whisper IPC broken');
    });
    const worker = fakeWorker(transcribe);
    const service = new SpeechPlaygroundService(() => worker);
    await service.start({ mode: 'whole-file', sourceId: 'file', label: 'Test', sampleRate: 16000 });
    await feed(service, pcm(16000, 1, [[0, 1]]), 16000);
    await service.finish();
    expect(service.snapshot().segments[0]).toMatchObject({
      phase: 'failed',
      error: 'whisper IPC broken',
    });
    expect(service.snapshot().error).toBe('whisper IPC broken');
    worker.failed('worker crashed, exit 1');
    expect(service.snapshot().phase).toBe('error');
    expect(service.snapshot().error).toBe('worker crashed, exit 1');
    await service.stop();
  });

  it('rejects invalid input and prevents overlapping tests or running beside Simulation', async () => {
    let allowed = false;
    const make = vi.fn(() => fakeWorker());
    const service = new SpeechPlaygroundService(make, () => allowed);
    const config = {
      mode: 'live-equivalent' as const,
      sourceId: 'mic',
      label: 'Mic',
      sampleRate: 48000,
    };
    await expect(service.start(config)).rejects.toThrow(/Stop Simulation/);
    expect(make).not.toHaveBeenCalled();
    allowed = true;
    await expect(service.start({ ...config, label: '' })).rejects.toThrow(/Invalid speech/);
    await service.start(config);
    await expect(service.start(config)).rejects.toThrow(/previous speech test/);
    await expect(service.push(new Float32Array([Number.NaN]))).rejects.toThrow(
      /Invalid speech test PCM/,
    );
    await service.stop();
    expect(service.snapshot().phase).toBe('idle');
  });

  it('throttles accelerated file PCM instead of dropping speech while Whisper is busy', async () => {
    const finishers: Array<(text: string) => void> = [];
    const worker = fakeWorker(
      vi.fn(
        (_samples: Float32Array) =>
          new Promise<string>((resolve) => {
            finishers.push(resolve);
          }),
      ),
    );
    const service = new SpeechPlaygroundService(() => worker);
    await service.start({
      mode: 'live-equivalent',
      sourceId: 'file',
      label: 'Recording',
      sampleRate: 16000,
    });
    const feeding = feed(
      service,
      pcm(16000, 6.3, [
        [0.1, 0.7],
        [1.6, 2.2],
        [3.1, 3.7],
        [4.6, 5.2],
      ]),
      16000,
    );
    await vi.waitFor(() => expect(finishers).toHaveLength(2));
    expect(service.snapshot().segments.map((segment) => segment.phase)).toEqual([
      'pending',
      'pending',
    ]);
    finishers[0]('first');
    await vi.waitFor(() => expect(finishers).toHaveLength(3));
    finishers[1]('second');
    await vi.waitFor(() => expect(finishers).toHaveLength(4));
    finishers[2]('third');
    finishers[3]('fourth');
    await feeding;
    await service.finish();
    expect(service.snapshot().segments).toHaveLength(4);
    expect(service.snapshot().segments.every((segment) => segment.phase === 'transcribed')).toBe(
      true,
    );
    await service.stop();
  });

  it('stops and releases buffers with an in-flight worker; obsolete completions cannot repopulate results', async () => {
    let resolve!: (text: string) => void;
    const worker = fakeWorker(
      vi.fn(
        (_samples: Float32Array) =>
          new Promise<string>((finish) => {
            resolve = finish;
          }),
      ),
    );
    const service = new SpeechPlaygroundService(() => worker);
    await service.start({ mode: 'whole-file', sourceId: 'file', label: 'Old', sampleRate: 16000 });
    await feed(service, pcm(16000, 1, [[0, 1]]), 16000);
    const completing = service.finish();
    expect(service.snapshot().pending).toBe(1);
    await service.stop();
    expect(service.snapshot().pending).toBe(0);
    resolve('stale transcript');
    await completing;
    expect(service.snapshot().segments[0].text).toBeNull();
    expect(service.snapshot().phase).toBe('idle');
    expect(worker.shutdown).toHaveBeenCalled();
  });
});
