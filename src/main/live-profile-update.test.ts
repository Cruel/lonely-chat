import { describe, expect, it } from 'vitest';
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
});
