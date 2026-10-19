import type { SessionPreferences } from '../shared/session-contract';

interface PreferenceSource {
  getPreferences(): SessionPreferences;
  getRunPreferences(): SessionPreferences;
}

/** Separate worker configuration lifetimes: ongoing Run vs independent Playground experiment. */
export function nativeWorkerSettings(
  source: PreferenceSource,
  owner: 'simulation' | 'playground',
): () => SessionPreferences {
  if (owner === 'simulation') return () => source.getRunPreferences();
  const captured = source.getPreferences();
  return () => captured;
}
