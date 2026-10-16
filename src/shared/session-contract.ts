export type SessionPhase = 'stopped' | 'running' | 'error';

/** Private desktop-only lifecycle information. Never served through /overlay. */
export interface SessionSnapshot {
  readonly revision: number;
  readonly phase: SessionPhase;
  readonly error: string | null;
  readonly cycle: number;
  readonly pendingMessages: number;
}

export interface SessionPreferences {
  readonly cycleIntervalMs: number;
}

export const DEFAULT_PREFERENCES: SessionPreferences = { cycleIntervalMs: 3000 };
export const CYCLE_INTERVAL_OPTIONS = [1500, 3000, 5000] as const;

export function validateContext(context: unknown): string {
  if (typeof context !== 'string' || context.trim().length === 0) {
    throw new Error('Enter some context to start the test simulation.');
  }
  if (context.length > 2000) throw new Error('Manual context must be 2000 characters or fewer.');
  return context.trim();
}

export function validatePreferences(value: unknown): SessionPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid simulation preferences.');
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 1 ||
    !CYCLE_INTERVAL_OPTIONS.some((interval) => interval === record.cycleIntervalMs)
  ) {
    throw new Error('Invalid simulation cycle interval.');
  }
  return { cycleIntervalMs: record.cycleIntervalMs as number };
}
