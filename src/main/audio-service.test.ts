import { describe, expect, it } from 'vitest';
import { AudioService } from './audio-service';
import { ChatService } from './chat-service';
import { SessionController } from './session-controller';
import { FakeClock, flushMicrotasks } from './test-support/fake-clock';
import type { InferenceProvider } from './fake-inference';
import type { NativeSpeech } from './native-speech';

describe('speech integration and optional input lifecycle', () => {
  it('includes completed labeled transcript in next bounded inference snapshot without forcing inference', async () => {
    const clock = new FakeClock();
    const chat = new ChatService();
    const inputs: Array<import('./fake-inference').InferenceInput> = [];
    const inference: InferenceProvider = {
      generate: async (input) => {
        inputs.push(input);
        return { events: [], messages: [] };
      },
    };
    const session = new SessionController(chat, inference, clock, { cycleIntervalMs: 1500 });
    const speech = {
      start: async () => {},
      transcribe: async () => 'watch out!',
      stop: () => {},
    } as unknown as NativeSpeech;
    const service = new AudioService(
      () => speech,
      (entry) => {
        if (session.snapshot().phase === 'running') session.recordTranscript(entry);
      },
      clock.wallNow,
    );
    session.start('hello');
    await flushMicrotasks();
    expect(inputs[0].recentTranscripts).toEqual([]);
    const state = await service.start('streamer', 'ordinary-microphone', 'Streamer', 'capture-1');
    expect(state.sources[0]?.phase).toBe('ready');
    service.submit({ samples: new Float32Array(16000).fill(0.1) }, 'capture-1');
    await flushMicrotasks();
    expect(service.snapshot().transcripts).toMatchObject([
      { source: 'Streamer', text: 'watch out!', observedAt: clock.wallNow() },
    ]);
    clock.advance(1500);
    await flushMicrotasks();
    expect(inputs[1].recentTranscripts).toMatchObject([{ source: 'Streamer', text: 'watch out!' }]);
    service.stop();
    clock.advance(1500);
    await flushMicrotasks();
    expect(inputs[2].recentTranscripts).toHaveLength(1);
    session.stop();
    // Audio can be omitted entirely from future sessions.
    session.start('no mic');
    await flushMicrotasks();
    expect(inputs.at(-1)?.recentTranscripts).toEqual([]);
    session.stop();
  });

  it('rejects invalid devices/PCM, bounds visible history, preserves manual-only operation', async () => {
    const segments: Float32Array[] = [];
    const speech = {
      start: async () => {},
      transcribe: async (pcm: Float32Array) => {
        segments.push(pcm);
        return 'hello';
      },
      stop: () => {},
    } as unknown as NativeSpeech;
    const service = new AudioService(
      () => speech,
      () => {},
      () => 1_700_000_000_000,
    );
    await expect(service.start('id', 'with a space', 'Mic', 'capture-2')).rejects.toThrow(/device/);
    await expect(service.start('id', 'mic', '', 'capture-2')).rejects.toThrow(/label/);
    expect(service.snapshot().sources).toEqual([]);
    await service.start('id', 'mic', ' Voice ', 'capture-2');
    expect(() => service.submit({ samples: new Float32Array(50) }, 'capture-2')).toThrow(/PCM/);
    expect(() =>
      service.submit({ samples: new Float32Array(1600).fill(Infinity) }, 'capture-2'),
    ).toThrow(/PCM/);
    for (let n = 0; n < 12; n++) {
      service.submit({ samples: new Float32Array(1600).fill(0.1) }, 'capture-2');
      await flushMicrotasks();
    }
    expect(segments.length).toBe(12);
    expect(service.snapshot().transcripts).toHaveLength(10);
    expect(service.snapshot().transcripts[0].source).toBe('Voice');
    expect(service.stop('obsolete-capture').sources[0]?.phase).toBe('ready');
    expect(() =>
      service.submit({ samples: new Float32Array(1600).fill(0.1) }, 'obsolete-capture'),
    ).toThrow(/previous capture/);
    service.stop('capture-2');
    expect(service.snapshot().sources[0]?.phase).toBe('off');
    expect(() => service.submit({ samples: new Float32Array(1600) }, 'capture-2')).toThrow(
      /previous capture/,
    );
  });

  it('ignores stale completion after stop and surfaces worker failure independently', async () => {
    let complete: ((text: string) => void) | null = null;
    const speech = {
      start: async () => {},
      transcribe: () =>
        new Promise<string>((resolve) => {
          complete = resolve;
        }),
      stop: () => {},
    } as unknown as NativeSpeech;
    const service = new AudioService(
      () => speech,
      () => {
        throw new Error('must not call');
      },
    );
    await service.start('id', 'mic', 'Tester', 'capture-3');
    service.submit({ samples: new Float32Array(1600).fill(0.1) }, 'capture-3');
    service.stop();
    const resolve = complete!;
    resolve('late speech');
    await flushMicrotasks();
    expect(service.snapshot().transcripts).toEqual([]);
    expect(service.snapshot().sources[0]?.phase).toBe('off');
  });
});
