import { expect, it, vi } from 'vitest';
import { ChatService } from './chat-service';
import { SessionController } from './session-controller';
import { FakeClock, flushMicrotasks } from './test-support/fake-clock';
import type { InferenceProfile } from '../shared/inference-profile-contract';
import type { UnifiedInferenceAdapter } from './inference-coordinator';

const profile = (revision: number): InferenceProfile => ({
  id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
  name: 'Asynchronous stages',
  revision,
  values: {
    topology: 'split',
    roles: {
      observer: { kind: 'remote', modelId: 'vision' },
      chat: { kind: 'remote', modelId: 'chat' },
    },
    stageDefaults: { observer: { systemPrompt: 'vision revision ' + revision } },
    architecture: {
      execution: 'asynchronous',
      hybridMaxImages: 0,
      visionIntervalMs: 100,
      chatIntervalMs: 200,
      maximumWaitMs: 0,
      maximumAgeMs: 5000,
      strictWait: false,
    },
  },
});
const scene = {
  sceneState: 'The winner crosses the line',
  events: [{ kind: 'reaction', summary: 'Winner!', ageMs: 0 }],
  messages: [],
};
const chat = { events: [], messages: [] };

it('recorded EOF waits for outstanding independent Vision and then hands it to Chat', async () => {
  const clock = new FakeClock();
  const session = new SessionController(new ChatService(), undefined, clock, {
    cycleIntervalMs: 1500,
  });
  let finishVision!: (output: typeof scene) => void;
  const visionPending = new Promise<typeof scene>((resolve) => {
    finishVision = resolve;
  });
  let visionCalls = 0;
  const vision: UnifiedInferenceAdapter = {
    capabilities: { images: true },
    complete: vi.fn(async () => {
      if (++visionCalls > 1) return new Promise<never>(() => {});
      const result = await visionPending;
      return { raw: result, normalized: result };
    }),
  };
  const chatter: UnifiedInferenceAdapter = {
    capabilities: { images: false },
    complete: vi.fn(async () => ({ raw: chat, normalized: chat })),
  };
  session.configureSplit(() => ({ vision, chat: chatter }), false);
  session.start(
    'A race',
    'remote',
    'chat',
    { inputMode: 'recorded', publishToOverlay: false },
    undefined,
    undefined,
    profile(1),
  );
  await flushMicrotasks();
  await flushMicrotasks();
  expect(chatter.complete).toHaveBeenCalledTimes(1);
  expect(vision.complete).toHaveBeenCalledTimes(1);
  session.finishRecorded();
  await flushMicrotasks();
  expect(session.snapshot().recordedPlayback).toBe('draining');
  finishVision(scene);
  await flushMicrotasks();
  await flushMicrotasks();
  expect(session.snapshot().recordedPlayback).toBe('draining');
  clock.advance(200);
  await flushMicrotasks();
  await flushMicrotasks();
  expect(chatter.complete).toHaveBeenCalledTimes(2);
  // EOF only drains accepted Vision; it never starts a fresh request.
  expect(vision.complete).toHaveBeenCalledTimes(1);
  expect(session.snapshot().events).toEqual(
    expect.arrayContaining([expect.objectContaining({ summary: 'Winner!' })]),
  );
  expect(session.snapshot().recordedPlayback).toBe('completed');
});

it('admits queued profile revisions at new independent Vision boundaries while Chat remains busy', async () => {
  const clock = new FakeClock();
  const session = new SessionController(new ChatService(), undefined, clock, {
    cycleIntervalMs: 1500,
  });
  let finishChat!: (output: typeof chat) => void;
  const pendingChat = new Promise<typeof chat>((resolve) => {
    finishChat = resolve;
  });
  const vision: UnifiedInferenceAdapter = {
    capabilities: { images: true },
    complete: vi.fn(async () => ({ raw: scene, normalized: scene })),
  };
  const chatter: UnifiedInferenceAdapter = {
    capabilities: { images: false },
    complete: vi.fn(async () => {
      const result = await pendingChat;
      return { raw: result, normalized: result };
    }),
  };
  session.configureSplit(() => ({ vision, chat: chatter }), false);
  session.start(
    'A race',
    'remote',
    'chat',
    { inputMode: 'live', publishToOverlay: true },
    undefined,
    undefined,
    profile(1),
  );
  await flushMicrotasks();
  await flushMicrotasks();
  expect(chatter.complete).toHaveBeenCalledTimes(1);
  expect(vi.mocked(vision.complete).mock.calls[0][0].instructions).toContain('vision revision 1');
  session.queueProfileUpdate(profile(2));
  expect(session.snapshot().pendingProfileRevision).toBe(2);
  clock.advance(100);
  await flushMicrotasks();
  await flushMicrotasks();
  expect(vi.mocked(vision.complete).mock.calls[1][0].instructions).toContain('vision revision 2');
  expect(session.snapshot().inferenceProfile?.revision).toBe(2);
  expect(chatter.complete).toHaveBeenCalledTimes(1);
  finishChat(chat);
  await flushMicrotasks();
  session.stop();
});
