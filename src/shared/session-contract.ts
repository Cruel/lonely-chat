export type SessionPhase = 'stopped' | 'starting' | 'running' | 'error';
export type InferenceMode = 'fake' | 'native';

export interface InferredEvent {
  readonly kind: 'context' | 'reaction';
  readonly summary: string;
  readonly observedAt: number;
}

export interface CapturedObservation {
  readonly source: string;
  readonly kind: 'visual' | 'audio';
  readonly description: string;
  readonly observedAt: number;
}

export interface LabeledTranscript {
  readonly source: string;
  readonly text: string;
  readonly observedAt: number;
}

/** Private desktop-only lifecycle information. Never served through /overlay. */
export interface SessionSnapshot {
  readonly revision: number;
  readonly phase: SessionPhase;
  readonly error: string | null;
  readonly warning: string | null;
  readonly cycle: number;
  readonly retryAttempt: number;
  readonly pendingMessages: number;
  readonly mode: InferenceMode;
  readonly events: readonly InferredEvent[];
  readonly latestInferenceMs: number | null;
  readonly smoothedInferenceMs: number | null;
  readonly playbackWindowMs: number;
  readonly droppedObservations: number;
}

export interface SessionPreferences {
  /** Minimum interval between inference starts, independent of playback. */
  readonly cycleIntervalMs: number;
  readonly baselineMs: number;
  readonly historyMaxCount: number;
  readonly historyMaxAgeMs: number;
  /** Thinking/reasoning mode for the native model, applied at the next server start. */
  readonly reasoningEnabled: boolean;
}

export const DEFAULT_PREFERENCES: SessionPreferences = {
  cycleIntervalMs: 3000,
  baselineMs: 0,
  historyMaxCount: 32,
  historyMaxAgeMs: 60000,
  reasoningEnabled: false,
};
export const CYCLE_INTERVAL_OPTIONS = [1500, 3000, 5000] as const;
export const BASELINE_OPTIONS = [0, 1000, 3000] as const;
export const HISTORY_COUNT_OPTIONS = [16, 32, 64] as const;
export const HISTORY_AGE_OPTIONS = [30000, 60000, 300000] as const;

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
    Object.keys(record).some((key) => !Object.hasOwn(DEFAULT_PREFERENCES, key)) ||
    !CYCLE_INTERVAL_OPTIONS.some((interval) => interval === record.cycleIntervalMs) ||
    (record.baselineMs !== undefined &&
      !BASELINE_OPTIONS.some((value) => value === record.baselineMs)) ||
    (record.historyMaxCount !== undefined &&
      !HISTORY_COUNT_OPTIONS.some((value) => value === record.historyMaxCount)) ||
    (record.historyMaxAgeMs !== undefined &&
      !HISTORY_AGE_OPTIONS.some((value) => value === record.historyMaxAgeMs)) ||
    (record.reasoningEnabled !== undefined && typeof record.reasoningEnabled !== 'boolean')
  ) {
    throw new Error('Invalid simulation preferences.');
  }
  return { ...DEFAULT_PREFERENCES, ...record } as SessionPreferences;
}
