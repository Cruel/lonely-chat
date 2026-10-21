import { describe, expect, it, vi } from 'vitest';
import { ChatService } from './chat-service';
import { SessionController } from './session-controller';
import { FakeClock, flushMicrotasks } from './test-support/fake-clock';
import type { InferenceProfile } from '../shared/inference-profile-contract';

const profile = (revision: number, modelId = 'local-1'): InferenceProfile => ({
  id: 'run-profile', name: 'Live profile', revision,
  values: {
    topology: 'unified',
    roles: { unified: { kind: 'local', modelId } },
    stageDefaults: { unified: { systemPrompt: `revision ${revision}` } },
  },
});

describe('live profile admission', () => {
  it('holds a queued saved revision until the next admission', async () => {
    const clock = new FakeClock();
    const controller = new SessionController(new ChatService(), undefined, clock);
    controller.start('stream', 'fake', null, undefined, undefined, undefined, profile(1));
    expect(controller.snapshot().inferenceProfile?.revision).toBe(1);
    await flushMicrotasks();
    const queued = controller.queueProfileUpdate(profile(2));
    expect(queued.inferenceProfile?.revision).toBe(1);
    expect(queued.pendingProfileRevision).toBe(2);
    expect(() => controller.queueProfileUpdate(profile(3, 'different-model')))
      .toThrow(/explicit transition/);
    expect(() => controller.queueProfileUpdate(profile(1))).toThrow(/newer/);
    clock.advance(10_000);
    await flushMicrotasks();
    expect(controller.snapshot().inferenceProfile?.revision).toBe(2);
    expect(controller.snapshot().pendingProfileRevision).toBeNull();
    controller.stop();
  });
  it('keeps an in-flight input immutable while queuing a cadence/history revision', async () => {
    const clock = new FakeClock();
    const seen: unknown[] = [];
    let release!: (value: unknown) => void;
    const pending = new Promise<unknown>((resolve) => { release = resolve; });
    const inference = { generate: vi.fn((input: unknown) => { seen.push(input); return pending; }) };
    const controller = new SessionController(new ChatService(), inference, clock);
    controller.start('stream', 'fake', null, undefined, undefined, undefined, profile(1));
    await flushMicrotasks();
    const inputBefore = JSON.stringify(seen[0]);
    const revised: InferenceProfile = {
      ...profile(2), values: { ...profile(2).values,
        stageDefaults: { unified: { systemPrompt: 'new prompt',
          settings: { cycleIntervalMs: 6000, historyMaxCount: 12 } } },
      },
    };
    controller.queueProfileUpdate(revised);
    expect(controller.getRunPreferences().cycleIntervalMs).toBe(3000);
    expect(JSON.stringify(seen[0])).toBe(inputBefore);
    expect(controller.snapshot().pendingProfileRevision).toBe(2);
    release({ events: [], messages: [] });
    await flushMicrotasks();
    expect(controller.snapshot().inferenceProfile?.revision).toBe(1);
    clock.advance(6000);
    await flushMicrotasks();
    expect(controller.snapshot().inferenceProfile?.revision).toBe(2);
    expect(controller.getRunPreferences()).toMatchObject({ cycleIntervalMs: 6000, historyMaxCount: 12 });
    controller.stop();
  });
});
