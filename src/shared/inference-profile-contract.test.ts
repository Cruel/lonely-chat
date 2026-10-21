import { expect, test } from 'vitest';
import { DEFAULT_PREFERENCES } from './session-contract';
import { resolveUnifiedProfilePolicy, type InferenceProfile } from './inference-profile-contract';

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
