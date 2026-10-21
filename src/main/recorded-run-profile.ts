import {
  validateProfileSnapshot,
  validateProfileValues,
  type InferenceProfile,
  type ProfileModelReference,
  type InferenceRole,
} from '../shared/inference-profile-contract';
import type { RecordedScenarioConfig } from '../shared/recorded-scenario-contract';

/** Saved settings use the recorded revision even if the profile was subsequently
 * changed or deleted. Provider/role availability is always revalidated live. */
export async function resolveRunStartProfile(
  id: string | null | undefined,
  revision: number | null | undefined,
  recorded: RecordedScenarioConfig | null,
  resolveCurrent: (id: string, revision?: number) => Promise<InferenceProfile>,
  available: (ref: ProfileModelReference, role: InferenceRole) => boolean,
): Promise<InferenceProfile | null> {
  const saved = recorded?.settingsPolicy === 'saved' ? recorded.profileSnapshot : null;
  if (saved) {
    const profile = validateProfileSnapshot(saved);
    if (profile.id !== id || profile.revision !== revision)
      throw new Error('Saved Run profile does not match the selected Scenario revision.');
    validateProfileValues(profile.values, available);
    return profile;
  }
  return id ? resolveCurrent(id, revision ?? undefined) : null;
}
