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

it('resolves Unified prompt templates and sampling from an admission snapshot', async () => {
  const { resolveUnifiedStageRequest } = await import('./stage-context');
  const { buildUnifiedInferenceRequest } = await import('./unified-inference-request');
  const input = { context: 'arena', cycle: 5 };
  const base = buildUnifiedInferenceRequest(input);
  const stage = { systemPrompt: 'Observe {{context}} in cycle {{cycle}}',
    userPrompt: 'History {{events}}', maxResponseTokens: 512 };
  const captured = resolveUnifiedStageRequest(base, input, stage);
  expect(captured.instructions).toBe('Observe arena in cycle 5');
  expect(captured.content[0]).toEqual({ type: 'text', text: 'History []' });
  expect(captured.sampling.maxTokens).toBe(512);
  expect(base.instructions).not.toBe(captured.instructions);
  expect(base.sampling.maxTokens).not.toBe(512);
});

it('reconfigures a stage cadence without dropping the in-flight ownership', async () => {
  const { StageCadence } = await import('./stage-cadence');
  const cadence = new StageCadence(3000);
  expect(cadence.start(1000)).toBe(true);
  cadence.configure(6000);
  expect(cadence.nextDelay(4000)).toBe(Infinity);
  cadence.finish();
  expect(cadence.nextDelay(4000)).toBe(3000);
  expect(cadence.start(6999)).toBe(false);
  expect(cadence.start(7000)).toBe(true);
  cadence.finish();
});
