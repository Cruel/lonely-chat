import { describe, expect, it, vi } from 'vitest';
import { AudioService } from './audio-service';
import { ChatService } from './chat-service';
import { SessionController } from './session-controller';
import { SessionMedia } from './session-media';
import { FakeClock, flushMicrotasks } from './test-support/fake-clock';
import { recordedAudioPosition } from '../renderer/recorded-audio-timeline';
import type { NativeSpeech } from './native-speech';
import type { InferenceInput, InferenceProvider } from './fake-inference';

const block = (rate: number, talking: boolean) =>
  new Float32Array(rate / 10).fill(talking ? 0.2 : 0);

describe('recorded multi-track audio', () => {
  it('aligns positive/negative offsets from independent rate sources, flushes on EOF and reaches production inference', async () => {
    const clock = new FakeClock();
    const inputs: InferenceInput[] = [];
    const provider: InferenceProvider = {
      generate: async (input) => {
        inputs.push(input);
        return { events: [], messages: [] };
      },
    };
    const session = new SessionController(new ChatService(), provider, clock, {
      cycleIntervalMs: 3000,
      baselineMs: 5000,
    });
    let media!: SessionMedia;
    const chunks: Float32Array[] = [];
    const workers = [
      {
        start: async () => {},
        transcribe: async (pcm: Float32Array) => {
          chunks.push(pcm);
          return 'Guest speaking';
        },
        stop: vi.fn(),
      },
      {
        start: async () => {},
        transcribe: async (pcm: Float32Array) => {
          chunks.push(pcm);
          return 'Streamer speaking';
        },
        stop: vi.fn(),
      },
    ];
    let workerIndex = 0;
    const audio = new AudioService(
      () => workers[workerIndex++] as unknown as NativeSpeech,
      (entry) => media.recordTranscript(entry),
      clock.wallNow,
      clock,
    );
    media = new SessionMedia(session, audio, () => {});
    session.start('', 'fake', null, {
      inputMode: 'recorded',
      publishToOverlay: false,
      hasVideoFile: false,
      hasAudioFiles: true,
    });
    expect(session.snapshot().inputMode).toBe('recorded');
    const origin = clock.wallNow();
    await audio.startRecorded({
      id: 'guest',
      label: 'Discord guest',
      captureId: 'capture-guest',
      sampleRate: 16000,
      offsetMs: -1000,
      seekMs: 1000,
    });
    await audio.startRecorded({
      id: 'streamer',
      label: 'Microphone',
      captureId: 'capture-streamer',
      sampleRate: 48000,
      offsetMs: 2000,
      seekMs: 0,
    });
    audio.armRecorded('capture-guest', origin, 1000);
    audio.armRecorded('capture-streamer', origin, 0);

    // The guest track starts at media 1s while the shared presentation clock is at 0.
    for (let i = 0; i < 16; ++i) {
      clock.advance(100);
      audio.pushRecorded(block(16000, i < 8), 'capture-guest');
    }
    audio.finishRecorded('capture-guest');
    await flushMicrotasks();
    expect(audio.snapshot().transcripts).toMatchObject([
      { sourceId: 'guest', source: 'Discord guest', text: 'Guest speaking' },
    ]);
    expect(audio.snapshot().transcripts[0].observedAt).toBeGreaterThan(origin);
    expect(audio.snapshot().transcripts[0].observedAt).toBeLessThan(origin + 1601);

    clock.advance(400);
    // A 48-kHz track begins 2 seconds later and resamples to Whisper's 16-kHz.
    for (let i = 0; i < 16; ++i) {
      clock.advance(100);
      audio.pushRecorded(block(48000, i < 8), 'capture-streamer');
    }
    audio.finishRecorded('capture-streamer');
    await flushMicrotasks();
    expect(chunks).toHaveLength(2);
    expect(chunks.every((pcm) => pcm.length >= 1600 && pcm.length <= 16000 * 8)).toBe(true);
    expect(audio.snapshot().transcripts).toHaveLength(2);
    const streamer = audio.snapshot().transcripts[1];
    expect(streamer).toMatchObject({
      sourceId: 'streamer',
      source: 'Microphone',
      text: 'Streamer speaking',
    });
    expect(streamer.observedAt).toBeGreaterThan(origin + 2000);
    expect(streamer.observedAt).toBeLessThan(origin + 3601);

    clock.advance(1400);
    await flushMicrotasks();
    expect(inputs).toHaveLength(1);
    expect(inputs[0].context).toBe('React to the recorded audio inputs.');
    expect(inputs[0].recentTranscripts?.map((item) => item.source)).toEqual([
      'Discord guest',
      'Microphone',
    ]);
    expect(inputs[0].recentTranscripts?.map((item) => item.sourceId)).toEqual([
      'guest',
      'streamer',
    ]);
    expect(session.snapshot().cycle).toBe(1);
    media.stop();
    await audio.terminate();
  });

  it('does not pause media or other tracks on a slow/failed STT worker or an in-flight VLM', async () => {
    const clock = new FakeClock();
    let resolveInference!: (value: unknown) => void;
    const inputs: InferenceInput[] = [];
    const provider: InferenceProvider = {
      generate: (input) => {
        inputs.push(input);
        return new Promise((resolve) => {
          resolveInference = resolve;
        });
      },
    };
    const session = new SessionController(new ChatService(), undefined, clock, undefined, provider);
    let media!: SessionMedia;
    const failWorker = vi.fn(async () => {
      throw new Error('Whisper timeout');
    });
    const goodWorker = vi.fn(async () => 'Still recording');
    const audio = new AudioService(
      (() => {
        let index = 0;
        return () =>
          ({
            start: async () => {},
            stop: () => {},
            transcribe: index++ === 0 ? failWorker : goodWorker,
          }) as unknown as NativeSpeech;
      })(),
      (entry) => media.recordTranscript(entry),
      clock.wallNow,
      clock,
    );
    media = new SessionMedia(session, audio, () => {});
    session.start('game', 'native', null, {
      inputMode: 'recorded',
      publishToOverlay: false,
      hasVideoFile: false,
    });
    await flushMicrotasks();
    expect(inputs).toHaveLength(1);
    const origin = clock.wallNow();
    await audio.startRecorded({
      id: 'bad',
      label: 'Timeout track',
      captureId: 'bad-cap',
      sampleRate: 16000,
      offsetMs: 0,
      seekMs: 0,
    });
    await audio.startRecorded({
      id: 'good',
      label: 'Other speaker',
      captureId: 'good-cap',
      sampleRate: 16000,
      offsetMs: 0,
      seekMs: 0,
    });
    audio.armRecorded('bad-cap', origin, 0);
    audio.armRecorded('good-cap', origin, 0);
    for (let i = 0; i < 16; ++i) {
      clock.advance(100);
      audio.pushRecorded(block(16000, i < 8), 'bad-cap');
      audio.pushRecorded(block(16000, i < 8), 'good-cap');
    }
    await flushMicrotasks();
    expect(failWorker).toHaveBeenCalledOnce();
    expect(goodWorker).toHaveBeenCalledOnce();
    expect(audio.snapshot().transcripts).toMatchObject([
      { sourceId: 'good', source: 'Other speaker', text: 'Still recording' },
    ]);
    expect(inputs).toHaveLength(1); // VLM still waiting; audio clocks do not wait for inference.
    resolveInference({ events: [], messages: [] });
    await flushMicrotasks();
    clock.advance(1400);
    await flushMicrotasks();
    expect(inputs).toHaveLength(2);
    expect(inputs[1].recentTranscripts?.map((entry) => entry.sourceId)).toEqual(['good']);
    media.stop();
    await audio.terminate();
  });

  it('retains recorded transcripts while the VLM has exhausted retries and is awaiting manual recovery', async () => {
    const clock = new FakeClock();
    const inputs: InferenceInput[] = [];
    let failed = true;
    const provider: InferenceProvider = {
      generate: async (input) => {
        inputs.push(input);
        if (failed) throw new Error('VLM unavailable');
        return { events: [], messages: [] };
      },
    };
    const session = new SessionController(new ChatService(), undefined, clock, undefined, provider);
    const audio = new AudioService(
      () =>
        ({
          start: async () => {},
          stop: () => {},
          transcribe: async () => 'Late speech',
        }) as unknown as NativeSpeech,
      (entry) => media.recordTranscript(entry),
      clock.wallNow,
      clock,
    );
    const media = new SessionMedia(session, audio, () => {});
    session.start('', 'native', null, {
      inputMode: 'recorded',
      publishToOverlay: false,
      hasAudioFiles: true,
    });
    await flushMicrotasks();
    clock.advance(500);
    await flushMicrotasks();
    clock.advance(1000);
    await flushMicrotasks();
    expect(session.snapshot().phase).toBe('error');
    const origin = clock.wallNow();
    await audio.startRecorded({
      id: 'late',
      label: 'Guest',
      captureId: 'capture-late',
      sampleRate: 16000,
      offsetMs: 0,
      seekMs: 0,
    });
    audio.armRecorded('capture-late', origin, 0);
    for (let i = 0; i < 16; i++) {
      clock.advance(100);
      audio.pushRecorded(block(16000, i < 8), 'capture-late');
    }
    audio.finishRecorded('capture-late');
    await flushMicrotasks();
    expect(audio.snapshot().transcripts.at(-1)?.text).toBe('Late speech');
    failed = false;
    session.retry();
    await flushMicrotasks();
    expect(inputs.at(-1)?.recentTranscripts?.map((item) => item.text)).toEqual(['Late speech']);
    media.stop();
    await audio.terminate();
  });

  it('rejects stale capture and invalid PCM, accepts signed offsets without making up media time', async () => {
    const clock = new FakeClock();
    const audio = new AudioService(
      () =>
        ({
          start: async () => {},
          transcribe: async () => '',
          stop: () => {},
        }) as unknown as NativeSpeech,
      () => {},
      clock.wallNow,
      clock,
    );
    await expect(
      audio.startRecorded({
        id: 'bad',
        label: 'Guest',
        captureId: 'one',
        sampleRate: 0,
        offsetMs: 0,
        seekMs: 0,
      }),
    ).rejects.toThrow(/rate/);
    await expect(
      audio.startRecorded({
        id: 'bad',
        label: 'Guest',
        captureId: 'one',
        sampleRate: 16000,
        offsetMs: -2000,
        seekMs: 1000,
      }),
    ).rejects.toThrow(/alignment/);
    await audio.startRecorded({
      id: 'good',
      label: 'Guest',
      captureId: 'two',
      sampleRate: 16000,
      offsetMs: -2000,
      seekMs: 2000,
    });
    expect(() => audio.pushRecorded(block(16000, true), 'two')).toThrow(/not active/);
    audio.armRecorded('two', clock.wallNow(), 2000);
    expect(() => audio.armRecorded('two', clock.wallNow(), 2000)).toThrow(/not ready/);
    expect(() => audio.pushRecorded(new Float32Array([NaN]), 'two')).toThrow(/PCM/);
    audio.stop('two');
    expect(() => audio.pushRecorded(block(16000, true), 'two')).toThrow(/not active/);
    await audio.terminate();
  });

  it('computes playback position at one shared monotonic time regardless of video presence', () => {
    expect(recordedAudioPosition(2000, 500, 5000)).toEqual({ mediaMs: 0, delayMs: 1500 });
    expect(recordedAudioPosition(-2000, 0, 5000)).toEqual({ mediaMs: 2000, delayMs: 0 });
    expect(recordedAudioPosition(2000, 2500, 5000)).toEqual({ mediaMs: 500, delayMs: 0 });
    expect(recordedAudioPosition(-2000, 4000, 5000)).toBeNull();
    expect(recordedAudioPosition(0, 1000, 1000)).toBeNull();
  });
});
