import { describe, expect, it } from 'vitest';
import { ChatService } from './chat-service';
import { SessionController } from './session-controller';
import type { InferenceInput, InferenceProvider } from './fake-inference';
import { DEFAULT_PREFERENCES } from '../shared/session-contract';
import { FakeClock, flushMicrotasks } from './test-support/fake-clock';

describe('session-level workload adaptation', () => {
  const jpeg = 'data:image/jpeg;base64,/9j/';

  it('applies measured RAM and latency pressure to next-cycle visual sampling and pacing', async () => {
    const clock = new FakeClock();
    const inputs: InferenceInput[] = [];
    let finishFirst!: (result: unknown) => void;
    const provider: InferenceProvider = {
      generate: (input) => {
        inputs.push(input);
        return inputs.length === 1
          ? new Promise((resolve) => {
              finishFirst = resolve;
            })
          : Promise.resolve({ events: [], messages: [] });
      },
      resourceMeasurements: async () => ({
        ramUsedMiB: 940,
        vramUsedMiB: null,
        gpuComputePercent: null,
      }),
    };
    const session = new SessionController(
      new ChatService(),
      undefined,
      clock,
      {
        ...DEFAULT_PREFERENCES,
        cycleIntervalMs: 3000,
        ramBudgetMiB: 1000,
        videoMinFrames: 2,
        videoMaxFrames: 12,
        videoCaptureIntervalMs: 250,
        gpuComputeTargetPercent: 40,
      },
      provider,
    );
    session.selectVideoSource('camera:game');
    session.start('playing a game', 'native');
    await flushMicrotasks();
    for (let i = 0; i < 16; i++) {
      clock.advance(250);
      session.recordVideoFrame({
        sourceId: 'camera:game',
        observedAt: clock.wallNow(),
        width: 160,
        height: 90,
        dataUrl: jpeg,
      });
    }
    finishFirst({ events: [], messages: [] });
    await flushMicrotasks();
    expect(session.snapshot().latestInferenceMs).toBe(4000);
    expect(session.snapshot().estimatedNextInferenceMs).toBe(4000);
    expect(session.snapshot().workerRamMiB).toBe(940);
    expect(session.snapshot().effectiveCycleMs).toBe(4800);
    clock.advance(799);
    await flushMicrotasks();
    expect(inputs).toHaveLength(1);
    clock.advance(1);
    await flushMicrotasks();
    expect(inputs).toHaveLength(2);
    expect(session.snapshot()).toMatchObject({
      effectiveCycleMs: 3000,
      adaptiveFrameLimit: 4,
    });
    expect(session.snapshot().adaptationReason).toMatch(/Worker RAM/);
    expect(inputs[1].frames?.length).toBe(4);
    session.stop();
  });

  it('ignores monitoring failures rather than pausing inference or chat delivery', async () => {
    const clock = new FakeClock();
    let calls = 0;
    const chat = new ChatService();
    const provider: InferenceProvider = {
      generate: async () => {
        calls++;
        return {
          events: [],
          messages: [
            {
              author: 'pixelpilot',
              color: '#bba5ff',
              text: 'still running',
              offsetMs: 0,
            },
          ],
        };
      },
      resourceMeasurements: async () => {
        throw new Error('Telemetry unavailable');
      },
    };
    const session = new SessionController(chat, undefined, clock, DEFAULT_PREFERENCES, provider);
    session.start('game', 'native');
    await flushMicrotasks();
    expect(session.snapshot().phase).toBe('running');
    expect(session.snapshot().workerRamMiB).toBeNull();
    expect(chat.snapshot().messages).toHaveLength(1);
    clock.advance(3000);
    await flushMicrotasks();
    expect(calls).toBe(2);
    expect(chat.snapshot().messages).toHaveLength(2);
    expect(session.snapshot().adaptationReason).toBeNull();
    session.stop();
  });
});
