import { expect, it, vi } from 'vitest';
import { resolveRunStartProfile } from './recorded-run-profile';
import type { RecordedScenarioConfig } from '../shared/recorded-scenario-contract';
import type { InferenceProfile } from '../shared/inference-profile-contract';

const snapshot: InferenceProfile = {
  id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
  name: 'Saved',
  revision: 2,
  values: {
    topology: 'unified',
    roles: { unified: { kind: 'remote', modelId: 'model' } },
    stageDefaults: { unified: { userPrompt: 'Original frozen prompt' } },
  },
};
const recorded = { settingsPolicy: 'saved', profileSnapshot: snapshot } as RecordedScenarioConfig;

it('starts saved settings from a frozen profile without resolving the edited or deleted current profile', async () => {
  const resolveCurrent = vi.fn(async () => {
    throw new Error('profile was deleted');
  });
  expect(
    await resolveRunStartProfile(snapshot.id, 2, recorded, resolveCurrent, () => true),
  ).toEqual(snapshot);
  expect(resolveCurrent).not.toHaveBeenCalled();
  await expect(
    resolveRunStartProfile(snapshot.id, 2, recorded, resolveCurrent, () => false),
  ).rejects.toThrow(/Missing or incompatible/);
  await expect(
    resolveRunStartProfile(
      snapshot.id,
      2,
      { ...recorded, settingsPolicy: 'current' },
      resolveCurrent,
      () => true,
    ),
  ).rejects.toThrow('profile was deleted');
  expect(resolveCurrent).toHaveBeenCalledTimes(1);
});
