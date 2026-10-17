import { describe, expect, it } from 'vitest';
import { AudioService } from './audio-service';
import { ChatService } from './chat-service';
import { SessionController } from './session-controller';
import { FakeClock, flushMicrotasks } from './test-support/fake-clock';
import type { InferenceProvider } from './fake-inference';
import type { NativeSpeech } from './native-speech';

const pcm = () => ({ samples: new Float32Array(1600).fill(0.2) });

describe('independent labeled audio inputs', () => {
  it('keeps overlapping captures separate, preserves timestamps and supports live renaming', async () => {
    const clock = new FakeClock();
    const captured: Array<import('./fake-inference').InferenceInput> = [];
    const inference: InferenceProvider = {
      generate: async (input) => {
        captured.push(input);
        return { events: [], messages: [] };
      },
    };
    const session = new SessionController(new ChatService(), inference, clock, {
      cycleIntervalMs: 1500,
    });
    const completions: Array<(text: string) => void> = [];
    const service = new AudioService(
      () =>
        ({
          start: async () => {},
          transcribe: () =>
            new Promise<string>((resolve) => {
              completions.push(resolve);
            }),
          stop: () => {},
        }) as unknown as NativeSpeech,
      (entry) => session.recordTranscript(entry),
      clock.wallNow,
    );
    expect(service.snapshot().sources).toEqual([]);
    session.start('stream');
    await flushMicrotasks();
    await service.start('streamer', 'mic-a', 'Streamer', 'capture-a');
    await service.start('chat', 'mic-b', 'Voice chat', 'capture-b');
    service.submit(pcm(), 'capture-a');
    clock.advance(20);
    service.submit(pcm(), 'capture-b');
    service.changeLabel('chat', 'Discord');
    completions[1]('hello from chat');
    completions[0]('hello from mic');
    await flushMicrotasks();
    expect(service.snapshot().sources.map((s) => s.phase)).toEqual(['ready', 'ready']);
    expect(service.snapshot().transcripts).toMatchObject([
      { sourceId: 'streamer', source: 'Streamer', text: 'hello from mic' },
      { sourceId: 'chat', source: 'Voice chat', text: 'hello from chat' },
    ]);
    expect(service.snapshot().transcripts[0]!.observedAt).toBeLessThan(
      service.snapshot().transcripts[1]!.observedAt,
    );
    clock.advance(1480);
    await flushMicrotasks();
    expect(captured[1]!.recentTranscripts?.map((s) => s.sourceId)).toEqual(['streamer', 'chat']);
    service.submit(pcm(), 'capture-b');
    completions[2]('new label');
    await flushMicrotasks();
    expect(service.snapshot().transcripts.at(-1)?.source).toBe('Discord');
    service.stop('capture-a');
    expect(service.snapshot().sources).toMatchObject([
      { id: 'streamer', phase: 'off' },
      { id: 'chat', phase: 'ready' },
    ]);
    service.stop();
    session.stop();
  });

  it('isolates disconnections, reconnects by stable identity and ignores stale workers', async () => {
    const resolves: Array<(text: string) => void> = [];
    let stops = 0;
    const service = new AudioService(
      () =>
        ({
          start: async () => {},
          transcribe: () =>
            new Promise<string>((resolve) => {
              resolves.push(resolve);
            }),
          stop: () => {
            stops++;
          },
        }) as unknown as NativeSpeech,
      () => {},
    );
    await service.start('streamer', 'mic-1', 'Streamer', 'token-1');
    await service.start('chat', 'mic-2', 'Friend', 'token-2');
    service.submit(pcm(), 'token-1');
    service.disconnected('token-1');
    expect(service.snapshot().sources).toMatchObject([
      { id: 'streamer', phase: 'disconnected' },
      { id: 'chat', phase: 'ready' },
    ]);
    await service.start('streamer', 'mic-1', 'Streamer', 'token-3');
    resolves[0]('stale');
    await flushMicrotasks();
    expect(service.snapshot().transcripts).toEqual([]);
    expect(() => service.submit(pcm(), 'token-1')).toThrow(/previous capture/);
    service.submit(pcm(), 'token-2');
    resolves[1]('still working');
    await flushMicrotasks();
    expect(service.snapshot().transcripts).toMatchObject([
      { sourceId: 'chat', text: 'still working' },
    ]);
    service.remove('streamer');
    expect(service.snapshot().sources.map((s) => s.id)).toEqual(['chat']);
    service.stop();
    expect(stops).toBeGreaterThanOrEqual(3);
  });

  it('reports a failed speech worker without affecting another active source', async () => {
    let created = 0;
    const service = new AudioService(
      () => {
        const failed = created++ === 0;
        return {
          start: async () => {},
          transcribe: async () => {
            if (failed) throw new Error('worker crashed');
            return 'other input is still live';
          },
          stop: () => {},
        } as unknown as NativeSpeech;
      },
      () => {},
    );
    await service.start('first', 'mic-a', 'Streamer', 'token-a');
    await service.start('second', 'mic-b', 'Voice', 'token-b');
    service.submit(pcm(), 'token-a');
    service.submit(pcm(), 'token-b');
    await flushMicrotasks();
    expect(service.snapshot().sources).toMatchObject([
      { phase: 'error', error: 'worker crashed', pendingSegments: 0 },
      { phase: 'ready', error: null, pendingSegments: 0 },
    ]);
    expect(service.snapshot().transcripts).toMatchObject([
      { sourceId: 'second', source: 'Voice', text: 'other input is still live' },
    ]);
    service.stop();
  });
});
