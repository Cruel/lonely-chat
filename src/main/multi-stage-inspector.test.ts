import { expect, it, vi } from 'vitest';
import { ChatService } from './chat-service';
import { SessionController } from './session-controller';
import { FakeClock, flushMicrotasks } from './test-support/fake-clock';
import type { InferenceProfile } from '../shared/inference-profile-contract';
import type { UnifiedInferenceAdapter } from './inference-coordinator';

const profile: InferenceProfile = {
  id: 'aaaa1111-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
  name: 'Inspector split',
  revision: 7,
  values: {
    topology: 'split',
    roles: {
      observer: { kind: 'remote', modelId: 'scene-model' },
      chat: { kind: 'remote', modelId: 'chat-model' },
      memory: { kind: 'remote', modelId: 'memory-model' },
    },
    stageDefaults: {},
    memory: { enabled: true, intervalMs: 1000, maxCharacters: 500, expireAfterMs: 0 },
    architecture: {
      execution: 'asynchronous', hybridMaxImages: 0,
      visionIntervalMs: 100, chatIntervalMs: 1500,
      maximumWaitMs: 0, maximumAgeMs: 5000, strictWait: false,
    },
  },
};
const chat = {
  events: [],
  messages: [{ author: 'pixelpilot', color: '#bba5ff', text: 'I saw that', offsetMs: 0 }],
};
const adapter = (complete: UnifiedInferenceAdapter['complete']): UnifiedInferenceAdapter =>
  ({ capabilities: { images: true }, complete });

it('tracks independent Vision arrivals and memory, while Chat references only the Vision context it actually consumed', async () => {
  const clock = new FakeClock();
  const session = new SessionController(new ChatService(), undefined, clock, { cycleIntervalMs: 1500 });
  let resolveFirstChat!: (value: typeof chat) => void;
  const firstChat = new Promise<typeof chat>((resolve) => { resolveFirstChat = resolve; });
  let visionCount = 0;
  let chatCount = 0;
  const vision = adapter(vi.fn(async (_request, _signal, observe) => {
    visionCount++;
    const output = {
      events: [{ kind: 'reaction', summary: visionCount === 1 ? 'A' : 'B', ageMs: 0 }],
      messages: [], sceneState: visionCount === 1 ? 'Scene A' : 'Scene B',
    };
    observe?.('request', { model: 'scene-model', authorization: 'secret' });
    observe?.('response', { ...output, usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 } });
    return { raw: output, normalized: output };
  }));
  const chatter = adapter(vi.fn(async () => {
    chatCount++;
    const result = chatCount === 1 ? await firstChat : chat;
    return { raw: result, normalized: result };
  }));
  const memory = adapter(vi.fn(async () => ({
    raw: { summary: 'An object fell' }, normalized: { summary: 'An object fell' },
  })));
  session.configureSplit(() => ({ vision, chat: chatter, memory }), false);
  session.start('A stream', 'remote', 'chat-model', { inputMode: 'live', publishToOverlay: true }, undefined, undefined, profile);
  await flushMicrotasks();
  await flushMicrotasks();
  const firstVision = session.trace.list().attempts.find((item) => item.role === 'vision');
  expect(firstVision).toMatchObject({ stage: 'accepted', profileRevision: 7, modelId: 'scene-model' });
  expect(JSON.stringify(session.trace.get(firstVision!.id))).not.toContain('authorization":"secret');
  clock.advance(100);
  await flushMicrotasks();
  const visionAttempts = session.trace.list().attempts.filter((item) => item.role === 'vision');
  expect(visionAttempts).toHaveLength(2);
  expect(visionAttempts[1].stage).toBe('accepted');
  resolveFirstChat(chat);
  await flushMicrotasks();
  const firstChatAttempt = session.trace.list().attempts.find((item) => item.role === 'chat');
  expect(firstChatAttempt?.stage).toBe('scheduled');
  expect(firstChatAttempt?.dependsOn).not.toContain(visionAttempts[1].id);
  expect(session.trace.get(visionAttempts[1].id)?.sceneState).toBe('Scene B');
  expect(session.trace.list().attempts.find((item) => item.role === 'memory')).toMatchObject({
    modelId: 'memory-model', stage: 'accepted',
  });
  clock.advance(1500);
  await flushMicrotasks();
  const nextChat = session.trace.list().attempts.filter((item) => item.role === 'chat').at(-1);
  expect(nextChat?.dependsOn).toContain(visionAttempts[1].id);
  const listing = JSON.stringify(session.trace.list());
  expect(listing).not.toContain('Scene B');
  expect(listing).not.toContain('An object fell');
  session.stop();
});

it('attributes a failed Vision validation to Vision rather than to a later successful Chat', async () => {
  const clock = new FakeClock();
  const session = new SessionController(new ChatService(), undefined, clock);
  session.configureSplit(() => ({
    vision: adapter(async () => ({ raw: { events: 'bad' }, normalized: { events: 'bad' } })),
    chat: adapter(async () => ({ raw: chat, normalized: chat })),
  }), false);
  session.start('Watch', 'remote', 'chat-model', { inputMode: 'live', publishToOverlay: true }, undefined, undefined,
    { ...profile, values: { ...profile.values, memory: { ...profile.values.memory!, enabled: false } } });
  await flushMicrotasks();
  await flushMicrotasks();
  const vision = session.trace.list().attempts.find((item) => item.role === 'vision');
  expect(vision).toMatchObject({ stage: 'failed', errorStage: 'validation' });
  expect(session.trace.list().attempts.some((item) => item.role === 'chat' && item.stage === 'scheduled')).toBe(true);
  const before = session.snapshot();
  session.trace.get(vision!.id); // inspection is read-only
  expect(session.snapshot()).toEqual(before);
  session.stop();
});
