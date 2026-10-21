import { expect, it, vi } from 'vitest';
import { PlaygroundService } from './playground-service';
import type { ProfileAdapterFactory } from './profile-playground';
import type { InferenceProfile } from '../shared/inference-profile-contract';
import type { ProfileExperimentRequest } from '../shared/profile-playground-contract';

const profile: InferenceProfile = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Vision comparison', revision: 2,
  values: {
    topology: 'split',
    roles: {
      observer: { kind: 'remote', modelId: 'observer-v1' },
      chat: { kind: 'local', modelId: 'chat-v1' },
    },
    stageDefaults: {},
    architecture: { execution: 'sequential', hybridMaxImages: 0,
      visionIntervalMs: 0, chatIntervalMs: 0, maximumWaitMs: 500, maximumAgeMs: 10000, strictWait: true },
  },
};

const experiment: ProfileExperimentRequest = {
  profileId: profile.id, profileRevision: 2, mode: 'vision',
  experiment: {
    modelId: 'chat-v1', seed: 17,
    values: {
      context: 'Playing chess', cycle: 1, playbackWindowMs: 3000,
      chatActivity: 'normal', roster: [{ author: 'viewer', color: '#123456' }],
      events: [], transcripts: [], observations: [], recentChat: [],
    },
  },
};

it('owns bounded Vision references privately, replays Chat without running Vision, and clears refs on Stop', async () => {
  const calls: string[] = [];
  const closed = vi.fn(async () => {});
  const factory: ProfileAdapterFactory = async (_ref, role) => ({
    adapter: {
      capabilities: { images: true },
      complete: async (submitted) => {
        calls.push(submitted.role);
        const normalized = role === 'observer'
          ? { sceneState: 'A chess checkmate', events: [], messages: [] }
          : { events: [], messages: [{ author: 'viewer', color: '#123456', text: 'GG!', offsetMs: 1 }] };
        return { raw: normalized, normalized };
      },
    },
    stop: closed,
  });
  const makeProvider = vi.fn(() => { throw new Error('No worker needed for stage adapters.'); });
  const service = new PlaygroundService(() => true, makeProvider);
  const vision = await service.runProfile(experiment, profile, factory);
  expect(vision.error).toBeNull();
  expect(vision.visionReference).not.toBeNull();
  expect(calls).toEqual(['vision']);
  const replayRequest = { ...experiment, mode: 'chat' as const,
    visionReferenceId: vision.visionReference!.id };
  expect(service.previewProfile(replayRequest, profile).stages[0].request)
    .toMatchObject({ role: 'chat' });
  const chat = await service.runProfile(replayRequest, profile, factory);
  expect(chat.error).toBeNull();
  expect(chat.accepted?.messages[0].text).toBe('GG!');
  expect(calls).toEqual(['vision', 'chat']);
  expect(makeProvider).not.toHaveBeenCalled();
  expect(closed).toHaveBeenCalledTimes(2);
  await service.stop();
  expect(() => service.previewProfile(replayRequest, profile)).toThrow(/not found/);
});

it('blocks simultaneous worker ownership and cancels stages on Stop without leaking Vision references', async () => {
  let complete!: (value: { sceneState: string; events: never[]; messages: never[] }) => void;
  const waiting = new Promise<{ sceneState: string; events: never[]; messages: never[] }>((resolve) => {
    complete = resolve;
  });
  let notifyStarted!: () => void;
  const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
  const adapterFactory: ProfileAdapterFactory = async () => ({
    adapter: {
      capabilities: { images: true },
      complete: async () => {
        notifyStarted();
        const result = await waiting;
        return { raw: result, normalized: result };
      },
    },
    stop: async () => {},
  });
  const service = new PlaygroundService(() => true, () => {
    throw new Error('No native worker expected.');
  });
  const ongoing = service.runProfile(experiment, profile, adapterFactory);
  await started;
  expect(service.busy).toBe(true);
  expect(() => service.runProfile(experiment, profile, adapterFactory)).toThrow(/Another Playground/);
  const stopping = service.stop();
  complete({ sceneState: 'Late after Stop', events: [], messages: [] });
  const final = await ongoing;
  await stopping;
  expect(final.error).toMatch(/cancelled/i);
  expect(final.visionReference).toBeNull();
  expect(service.busy).toBe(false);
});
