import { describe, expect, it, vi } from 'vitest';
import {
  executeProfileExperiment,
  previewProfileExperiment,
  type ProfileAdapterFactory,
} from './profile-playground';
import type { InferenceProfile } from '../shared/inference-profile-contract';
import type { ProfileExperimentRequest } from '../shared/profile-playground-contract';
import type { UnifiedInferenceAdapter } from './inference-coordinator';

const profile: InferenceProfile = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Test split',
  revision: 3,
  values: {
    topology: 'split',
    roles: {
      observer: { kind: 'remote', modelId: 'vision-provider' },
      chat: { kind: 'local', modelId: 'chat-model' },
    },
    stageDefaults: {
      observer: { systemPrompt: 'Observe {{context}}', maxResponseTokens: 128 },
      chat: { systemPrompt: 'Write chat about {{scene}}', maxResponseTokens: 256 },
    },
    architecture: {
      execution: 'sequential',
      hybridMaxImages: 0,
      visionIntervalMs: 0,
      chatIntervalMs: 0,
      maximumWaitMs: 500,
      maximumAgeMs: 30000,
      strictWait: true,
    },
  },
};
const experiment: ProfileExperimentRequest = {
  profileId: profile.id,
  profileRevision: profile.revision,
  mode: 'pipeline',
  experiment: {
    modelId: 'chat-model',
    seed: 1,
    values: {
      context: 'A game',
      cycle: 1,
      playbackWindowMs: 3000,
      chatActivity: 'normal',
      roster: [{ author: 'viewer', color: '#123456' }],
      events: [],
      transcripts: [],
      observations: [],
      recentChat: [],
    },
  },
};
const scene = {
  sceneState: 'Player wins',
  events: [{ kind: 'reaction', summary: 'Victory', ageMs: 0 }],
  messages: [],
};
const chat = {
  events: [],
  messages: [{ author: 'viewer', color: '#123456', text: 'GG', offsetMs: 10 }],
};

describe('isolated Profile Playground', () => {
  it('previews resolved production stage templates and schemas without submitting', () => {
    const preview = previewProfileExperiment(experiment, profile, null);
    expect(preview.stages.map((stage) => stage.role)).toEqual(['observer', 'chat']);
    expect(preview.stages[0].request).toMatchObject({
      role: 'vision',
      instructions: 'Observe A game',
      sampling: { maxTokens: 128 },
      response: { schema: { required: ['events', 'messages', 'sceneState'] } },
    });
    expect(preview.stages[1].request).toMatchObject({
      role: 'chat',
      sampling: { maxTokens: 256 },
    });
  });

  it('runs mixed providers and forks accepted Vision output into repeated Chat experiments', async () => {
    const calls: { role: string; requestRole: string; request: unknown }[] = [];
    const stop = vi.fn(async () => {});
    const factory: ProfileAdapterFactory = async (model, role) => {
      const adapter: UnifiedInferenceAdapter = {
        capabilities: { images: true },
        complete: async (request, _signal, observe) => {
          observe?.('request', { wireRequest: request.role, image: 'data:image/jpeg;base64,AAAA' });
          calls.push({ role, requestRole: request.role, request });
          const normalized = String(request.role) === 'vision' ? scene : chat;
          return { raw: { text: 'raw' }, normalized };
        },
      };
      return { adapter, stop };
    };
    const first = await executeProfileExperiment(
      experiment,
      profile,
      null,
      factory,
      new AbortController().signal,
    );
    expect(first.result.error).toBeNull();
    expect(first.result.stages.map((stage) => stage.role)).toEqual(['observer', 'chat']);
    expect(first.result.stages.map((stage) => stage.status)).toEqual(['accepted', 'accepted']);
    expect(first.result.stages[0].constructedRequest).toMatchObject({ role: 'vision' });
    expect(first.result.stages[0].submittedRequest).toMatchObject({
      wireRequest: 'vision',
      image: { mediaOmitted: true },
    });
    expect(first.result.accepted?.messages[0].text).toBe('GG');
    expect(first.vision?.sceneState).toBe('Player wins');
    expect(stop).toHaveBeenCalledTimes(2);
    expect(calls.map((item) => item.requestRole)).toEqual(['vision', 'chat']);

    const chatOnly: ProfileExperimentRequest = {
      ...experiment,
      mode: 'chat',
      visionReferenceId: first.vision!.reference.id,
    };
    const second = await executeProfileExperiment(
      chatOnly,
      profile,
      first.vision,
      factory,
      new AbortController().signal,
    );
    expect(second.result.stages.map((stage) => stage.role)).toEqual(['chat']);
    expect(second.result.error).toBeNull();
    expect(calls.map((item) => item.requestRole)).toEqual(['vision', 'chat', 'chat']);
    expect(JSON.stringify(calls.at(-1)?.request)).toContain('Player wins');
    expect(second.result.sourceVisionReference).toBe(first.vision!.reference.id);
    expect(second.result.accepted?.messages[0].text).toBe('GG');
  });

  it('reuses the local Chat worker for default narrative Memory without another model load', async () => {
    const withMemory: InferenceProfile = {
      ...profile,
      values: {
        ...profile.values,
        memory: { enabled: true, intervalMs: 1000, maxCharacters: 2000, expireAfterMs: 0 },
        stageDefaults: {
          ...profile.values.stageDefaults,
          chat: { settings: { inferenceTimeoutMs: 20000 } },
          memory: { settings: { inferenceTimeoutMs: 60000 } },
        },
      },
    };
    const created: string[] = [];
    const completed: string[] = [];
    const stop = vi.fn(async () => {});
    const factory: ProfileAdapterFactory = async (ref, role) => {
      created.push(`${role}:${ref.modelId}`);
      return {
        adapter: {
          capabilities: { images: true },
          complete: async (request) => {
            const requestRole = (request as import('./unified-inference-request').InferenceRequest)
              .role;
            completed.push(requestRole);
            const value =
              requestRole === 'vision'
                ? scene
                : requestRole === 'memory'
                  ? { summary: 'A notable race finish' }
                  : chat;
            return { raw: value, normalized: value };
          },
        },
        stop,
      };
    };
    const outcome = await executeProfileExperiment(
      experiment,
      withMemory,
      null,
      factory,
      new AbortController().signal,
    );
    expect(outcome.result.error).toBeNull();
    expect(created).toHaveLength(2);
    expect(created).toContain('chat:chat-model');
    expect(created).toContain('observer:vision-provider');
    expect(created).not.toContain('memory:chat-model');
    expect(completed).toEqual(['vision', 'chat', 'memory']);
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it('waits for a completed Vision handoff in asynchronous full-pipeline experiments', async () => {
    let finishVision!: (outcome: typeof scene) => void;
    const pending = new Promise<typeof scene>((resolve) => {
      finishVision = resolve;
    });
    const called: string[] = [];
    const asyncProfile: InferenceProfile = {
      ...profile,
      values: {
        ...profile.values,
        architecture: {
          ...profile.values.architecture!,
          execution: 'asynchronous',
          strictWait: false,
        },
      },
    };
    const factory: ProfileAdapterFactory = async (_ref, role) => ({
      adapter: {
        capabilities: { images: true },
        complete: async (request) => {
          called.push(request.role);
          if (role === 'observer') return { raw: scene, normalized: await pending };
          expect(JSON.stringify(request.content)).toContain('Player wins');
          return { raw: chat, normalized: chat };
        },
      },
      stop: async () => {},
    });
    const running = executeProfileExperiment(
      experiment,
      asyncProfile,
      null,
      factory,
      new AbortController().signal,
    );
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(called).toEqual(['vision']);
    finishVision(scene);
    const completed = await running;
    expect(completed.result.error).toBeNull();
    expect(called).toEqual(['vision', 'chat']);
    expect(completed.result.accepted?.messages[0].text).toBe('GG');
  });

  it('returns reusable completed Vision when Chat validation fails in a pipeline', async () => {
    const failed: ProfileAdapterFactory = async (_ref, role) => ({
      adapter: {
        capabilities: { images: true },
        complete: async () => {
          const normalized = role === 'observer' ? scene : { messages: [{ invalid: true }] };
          return { raw: normalized, normalized };
        },
      },
      stop: async () => {},
    });
    const outcome = await executeProfileExperiment(
      experiment,
      profile,
      null,
      failed,
      new AbortController().signal,
    );
    expect(outcome.result.error).toBeTruthy();
    expect(outcome.result.stages.map((item) => item.status)).toEqual(['accepted', 'failed']);
    expect(outcome.vision?.sceneState).toBe('Player wins');
  });

  it('enforces remote Hybrid image consent before preview or execution', () => {
    const noConsent: InferenceProfile = {
      ...profile,
      values: {
        ...profile.values,
        topology: 'hybrid',
        roles: {
          ...profile.values.roles,
          chat: { kind: 'remote', modelId: 'remote-chat' },
        },
        architecture: {
          execution: 'sequential',
          hybridMaxImages: 1,
          remoteChatImagesConsent: false,
        },
      },
    };
    expect(() => previewProfileExperiment(experiment, noConsent, null)).toThrow(
      /explicit Hybrid consent/,
    );
  });

  it('runs Vision alone and rejects missing Chat-only observations', async () => {
    const factory: ProfileAdapterFactory = async () => ({
      adapter: {
        capabilities: { images: true },
        complete: vi.fn(async () => ({ raw: scene, normalized: scene })),
      },
      stop: async () => {},
    });
    const vision = await executeProfileExperiment(
      { ...experiment, mode: 'vision' },
      profile,
      null,
      factory,
      new AbortController().signal,
    );
    expect(vision.result.stages.map((stage) => stage.role)).toEqual(['observer']);
    expect(vision.vision?.sceneState).toBe('Player wins');
    expect(() => previewProfileExperiment({ ...experiment, mode: 'chat' }, profile, null)).toThrow(
      /visual observation/,
    );
    const supplied = {
      ...experiment,
      mode: 'chat' as const,
      experiment: {
        ...experiment.experiment,
        values: {
          ...experiment.experiment.values,
          observations: [
            { source: 'manual', kind: 'visual' as const, description: 'Chessboard', ageMs: 0 },
          ],
        },
      },
    };
    expect(previewProfileExperiment(supplied, profile, null).stages).toHaveLength(1);
  });

  it('attributes failed and cancelled stage attempts without carrying results into a later experiment', async () => {
    let release!: (value: typeof scene) => void;
    const pending = new Promise<typeof scene>((resolve) => {
      release = resolve;
    });
    const factory: ProfileAdapterFactory = async (_model, role) => ({
      adapter: {
        capabilities: { images: true },
        complete: async () => {
          if (role === 'observer') return { raw: scene, normalized: await pending };
          return { raw: chat, normalized: chat };
        },
      },
      stop: async () => {},
    });
    const abort = new AbortController();
    const task = executeProfileExperiment(experiment, profile, null, factory, abort.signal);
    await Promise.resolve();
    abort.abort();
    release(scene);
    const cancelled = await task;
    expect(cancelled.result.error).toMatch(/cancelled/i);
    expect(cancelled.vision).toBeNull();
    expect(cancelled.result.accepted).toBeNull();

    const badFactory: ProfileAdapterFactory = async () => ({
      adapter: {
        capabilities: { images: true },
        complete: async () => {
          throw new Error('Provider offline');
        },
      },
      stop: async () => {},
    });
    const failed = await executeProfileExperiment(
      { ...experiment, mode: 'vision' },
      profile,
      null,
      badFactory,
      new AbortController().signal,
    );
    expect(failed.result.stages[0].status).toBe('failed');
    expect(failed.vision).toBeNull();
  });
});
