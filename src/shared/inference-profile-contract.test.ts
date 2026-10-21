import { expect, test } from 'vitest';
import { DEFAULT_PREFERENCES } from './session-contract';
import {
  resolveUnifiedProfilePolicy,
  validateProfileValues,
  type InferenceProfile,
} from './inference-profile-contract';

const profile: InferenceProfile = {
  id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
  name: 'Stream',
  revision: 3,
  values: {
    topology: 'unified',
    roles: { unified: { kind: 'remote', modelId: 'cloud' } },
    stageDefaults: { unified: { settings: { cycleIntervalMs: 9000, videoMaxFrames: 8 } } },
    contextDefaults: { context: 'Follow the story.', chatActivity: 'quiet' },
  },
};

test('validates independent Hybrid frame policies and requires an explicit consent field', () => {
  const values = {
    topology: 'hybrid',
    roles: {
      observer: { kind: 'local', modelId: 'vision' },
      chat: { kind: 'remote', modelId: 'chat' },
    },
    stageDefaults: {
      observer: {
        frameSampling: {
          maxFrames: 6,
          windowMs: 10000,
          strategy: 'uniform',
          maxWidth: 1280,
          maxHeight: 720,
        },
      },
      chat: {
        frameSampling: {
          maxFrames: 2,
          windowMs: 3000,
          strategy: 'latest',
          maxWidth: 640,
          maxHeight: 360,
        },
      },
    },
    architecture: { execution: 'sequential', hybridMaxImages: 2, remoteChatImagesConsent: true },
  };
  const validated = validateProfileValues(values, () => true);
  expect(validated.stageDefaults.chat?.frameSampling?.maxWidth).toBe(640);
  expect(validated.architecture?.remoteChatImagesConsent).toBe(true);
  expect(() =>
    validateProfileValues(
      {
        ...values,
        stageDefaults: {
          ...values.stageDefaults,
          chat: { frameSampling: { ...values.stageDefaults.chat.frameSampling, maxWidth: 4096 } },
        },
      },
      () => true,
    ),
  ).toThrow(/frame sampling/);
  expect(() =>
    validateProfileValues(
      { ...values, architecture: { ...values.architecture, remoteChatImagesConsent: 'yes' } },
      () => true,
    ),
  ).toThrow(/consent/);
});

test('allows per-stage timeout overrides but rejects unsupported Split worker settings', () => {
  const values = {
    topology: 'split',
    roles: {
      observer: { kind: 'local', modelId: 'vision' },
      chat: { kind: 'remote', modelId: 'chat' },
    },
    stageDefaults: {
      observer: { settings: { inferenceTimeoutMs: 123000 } },
      chat: { settings: { inferenceTimeoutMs: 456000 } },
    },
  };
  expect(
    validateProfileValues(values, () => true).stageDefaults.chat?.settings?.inferenceTimeoutMs,
  ).toBe(456000);
  expect(() =>
    validateProfileValues(
      { ...values, stageDefaults: { chat: { settings: { imageMaxTokens: 1024 } } } },
      () => true,
    ),
  ).toThrow(/only support inferenceTimeoutMs/);
});

test('rejects enabled Unified narrative memory rather than silently failing to schedule it', () => {
  expect(() =>
    validateProfileValues(
      {
        ...profile.values,
        memory: { enabled: true, intervalMs: 30000, maxCharacters: 2000, expireAfterMs: 0 },
      },
      () => true,
    ),
  ).toThrow(/not supported for Unified/);
  expect(
    validateProfileValues(
      {
        ...profile.values,
        memory: { enabled: false, intervalMs: 30000, maxCharacters: 2000, expireAfterMs: 0 },
      },
      () => true,
    ).memory?.enabled,
  ).toBe(false);
});

test('freezes profile model/scheduling independently of prompt preset context and chat activity', () => {
  const base = { ...DEFAULT_PREFERENCES };
  const effective = resolveUnifiedProfilePolicy(profile, base, '', {
    context: 'Only this scene matters.',
    chatActivity: 'busy',
  });
  expect(effective.context).toBe('Only this scene matters.');
  expect(effective.settings.chatActivity).toBe('busy');
  expect(effective.settings.cycleIntervalMs).toBe(9000);
  expect(effective.settings.videoMaxFrames).toBe(8);
  expect(effective.model).toEqual({ kind: 'remote', modelId: 'cloud' });
  expect(base).toEqual(DEFAULT_PREFERENCES);
  expect(resolveUnifiedProfilePolicy(profile, base, '').context).toBe('Follow the story.');
  expect(resolveUnifiedProfilePolicy(profile, base, 'Manual context').context).toBe(
    'Manual context',
  );
  expect(resolveUnifiedProfilePolicy(null, base, 'Manual context').settings).toEqual(base);
});
