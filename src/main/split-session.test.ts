import { expect, it, vi } from 'vitest';
import { ChatService } from './chat-service';
import { SessionController } from './session-controller';
import { FakeClock, flushMicrotasks } from './test-support/fake-clock';
import type { InferenceProfile } from '../shared/inference-profile-contract';
import type { UnifiedInferenceAdapter } from './inference-coordinator';

const profile: InferenceProfile = {
  id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
  name: 'Vision + Chat',
  revision: 2,
  values: {
    topology: 'split',
    roles: {
      observer: { kind: 'remote', modelId: 'vision' },
      chat: { kind: 'remote', modelId: 'chat' },
    },
    stageDefaults: {},
    architecture: { execution: 'sequential', hybridMaxImages: 0 },
  },
};
const visual = {
  sceneState: 'An object is falling near the player.',
  events: [{ kind: 'reaction', summary: 'An object falls', ageMs: 0 }],
  messages: [],
};
const chat = {
  events: [],
  messages: [
    {
      author: 'pixelpilot',
      color: '#bba5ff',
      text: 'Whoa!',
      offsetMs: 0,
    },
  ],
};
function transport(output: unknown): UnifiedInferenceAdapter {
  return {
    capabilities: { images: true },
    complete: vi.fn(async () => ({ raw: output, normalized: output })),
  };
}
async function run(kind: 'live' | 'recorded', failure?: 'vision' | 'chat') {
  const clock = new FakeClock();
  const messages = new ChatService();
  const session = new SessionController(messages, undefined, clock, { cycleIntervalMs: 1500 });
  const observer = transport(
    failure === 'vision'
      ? { events: [{ kind: 'reaction', summary: '', ageMs: 0 }], messages: [] }
      : visual,
  );
  const chatter = transport(
    failure === 'chat'
      ? { events: [], messages: [{ author: 'alien', text: 'x', offsetMs: 0 }] }
      : chat,
  );
  session.configureSplit(() => ({ vision: observer, chat: chatter }), false);
  const started = session.start(
    'Watch this',
    'remote',
    'chat',
    {
      inputMode: kind,
      publishToOverlay: kind === 'live',
    },
    undefined,
    undefined,
    profile,
  );
  expect(started.inferenceProfile).toMatchObject({ revision: 2, topology: 'split' });
  await flushMicrotasks();
  await flushMicrotasks();
  return { session, clock, messages, observer, chatter };
}
for (const kind of ['live', 'recorded'] as const) {
  it(`executes the validated sequential Split pipeline for ${kind} runs`, async () => {
    const result = await run(kind);
    expect(result.observer.complete).toHaveBeenCalled();
    expect(result.chatter.complete).toHaveBeenCalled();
    expect(result.session.snapshot().events, JSON.stringify(result.session.snapshot())).toEqual(
      expect.arrayContaining([expect.objectContaining({ summary: 'An object falls' })]),
    );
    result.session.stop();
  });
  it(`does not publish partial output from failed ${kind} Split stages`, async () => {
    for (const failure of ['vision', 'chat'] as const) {
      const result = await run(kind, failure);
      expect(result.session.snapshot().events).toEqual([]);
      expect(result.messages.snapshot().messages).toEqual([]);
      result.session.stop();
    }
  });
}
