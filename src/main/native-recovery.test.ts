import { describe, expect, it } from 'vitest';
import { AudioService } from './audio-service';
import { FakeClock, flushMicrotasks as flush } from './test-support/fake-clock';
import type { NativeServiceStatus } from '../shared/native-service-contract';
import type { NativeSpeech } from './native-speech';

describe('speech worker recovery', () => {
  it('restarts only the crashed source with bounded exponential backoff then permits manual retry', async () => {
    const clock = new FakeClock();
    const crashes: Array<() => void> = [];
    let created = 0;
    const service = new AudioService(
      () => {
        const index = ++created;
        let listener: ((status: NativeServiceStatus) => void) | null = null;
        crashes.push(() =>
          listener?.({ revision: index, phase: 'failed', error: `crash ${index}` }),
        );
        return {
          start: async () => {},
          transcribe: async () => '',
          stop: () => {},
          subscribe: (fn: (status: NativeServiceStatus) => void) => {
            listener = fn;
            return () => {
              listener = null;
            };
          },
        } as unknown as NativeSpeech;
      },
      () => {},
      clock.wallNow,
      clock,
    );
    await service.start('mic', 'device-one', 'Streamer', 'capture-1');
    expect(service.snapshot().sources[0].phase).toBe('ready');
    crashes[0]();
    expect(service.snapshot().sources[0]).toMatchObject({ phase: 'starting' });
    clock.advance(499);
    await flush();
    expect(created).toBe(1);
    clock.advance(1);
    await flush();
    expect(created).toBe(2);
    crashes[1]();
    clock.advance(999);
    await flush();
    expect(created).toBe(2);
    clock.advance(1);
    await flush();
    expect(created).toBe(3);
    crashes[2]();
    expect(service.snapshot().sources[0]).toMatchObject({ phase: 'error' });
    expect(service.snapshot().sources[0].error).toMatch(/after 2 restarts: crash 3/);
    clock.advance(100_000);
    await flush();
    expect(created).toBe(3);
    const recovered = await service.retry('mic');
    expect(recovered.sources[0].phase).toBe('ready');
    expect(created).toBe(4);
    // An old worker's failure notification must not harm the new source.
    crashes[2]();
    expect(service.snapshot().sources[0].phase).toBe('ready');
    service.stop();
  });

  it('retires all speech processes before changing models, and preserves capture identity', async () => {
    const clock = new FakeClock();
    let finishRetirement: () => void = () => {};
    const labels: string[] = [];
    let selected = 'model-a';
    const service = new AudioService(
      () =>
        ({
          start: async () => {
            labels.push(selected);
          },
          transcribe: async () => '',
          stop: () => {},
          shutdown: () =>
            new Promise<void>((resolve) => {
              finishRetirement = resolve;
            }),
        }) as unknown as NativeSpeech,
      () => {},
      clock.wallNow,
      clock,
    );
    await service.start('mic', 'device', 'Streamer', 'capture-one');
    expect(labels).toEqual(['model-a']);
    let activated = false;
    const switching = service.reloadWorkers(async () => {
      activated = true;
      selected = 'model-b';
    });
    expect(service.snapshot().sources[0].phase).toBe('starting');
    await flush();
    expect(activated).toBe(false);
    finishRetirement();
    await switching;
    expect(activated).toBe(true);
    expect(labels).toEqual(['model-a', 'model-b']);
    expect(service.snapshot().sources[0]).toMatchObject({ phase: 'ready', sourceId: 'device' });
    let retired = false;
    const exiting = service.terminate().then(() => {
      retired = true;
    });
    await flush();
    expect(retired).toBe(false);
    finishRetirement();
    await exiting;
    expect(retired).toBe(true);
    expect(service.snapshot().sources[0].phase).toBe('off');
  });
});
