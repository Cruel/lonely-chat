export type SessionPhase = 'stopped' | 'starting' | 'running' | 'error';
export type InferenceMode = 'fake' | 'native';
export type VideoSamplingStrategy = 'uniform' | 'recent-weighted';

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
  /** Hard deadline for each native llama.cpp completion request. */
  readonly inferenceTimeoutMs: number;
  /** Sampling cadence of the renderer (in milliseconds); distinct from model frame count. */
  readonly videoCaptureIntervalMs: number;
  /** Maximum video look-back per cycle; truncated intervals are explicitly identified. */
  readonly videoCoverageMs: number;
  readonly videoMinFrames: number;
  readonly videoMaxFrames: number;
  readonly videoSamplingStrategy: VideoSamplingStrategy;
}

export const DEFAULT_PREFERENCES: SessionPreferences = {
  cycleIntervalMs: 3000,
  baselineMs: 0,
  historyMaxCount: 32,
  historyMaxAgeMs: 60000,
  reasoningEnabled: false,
  inferenceTimeoutMs: 600_000,
  videoCaptureIntervalMs: 500,
  videoCoverageMs: 60_000,
  videoMinFrames: 2,
  videoMaxFrames: 24,
  videoSamplingStrategy: 'uniform',
};
export const CYCLE_INTERVAL_OPTIONS = [1500, 3000, 5000] as const;
export const BASELINE_OPTIONS = [0, 1000, 3000] as const;
export const HISTORY_COUNT_OPTIONS = [16, 32, 64] as const;
export const HISTORY_AGE_OPTIONS = [30000, 60000, 300000] as const;
export const INFERENCE_TIMEOUT_OPTIONS = [30000, 120000, 300000, 600000, 1200000] as const;
export const VIDEO_CAPTURE_INTERVAL_OPTIONS = [250, 500, 1000, 2000] as const;
export const VIDEO_COVERAGE_OPTIONS = [10000, 30000, 60000] as const;
export const VIDEO_FRAME_COUNT_OPTIONS = [2, 4, 8, 12, 24, 32] as const;

/** Editable settings use strict bounds to limit timers, memory and prompt size. */
export const NUMERIC_PREFERENCE_LIMITS = {
  cycleIntervalMs: { min: 500, max: 60000, step: 100 },
  baselineMs: { min: 0, max: 60000, step: 100 },
  historyMaxCount: { min: 1, max: 256, step: 1 },
  historyMaxAgeMs: { min: 1000, max: 3600000, step: 1000 },
  inferenceTimeoutMs: { min: 10000, max: 3600000, step: 1000 },
  videoCaptureIntervalMs: { min: 250, max: 5000, step: 50 },
  videoCoverageMs: { min: 3000, max: 60000, step: 1000 },
  videoMinFrames: { min: 1, max: 32, step: 1 },
  videoMaxFrames: { min: 1, max: 32, step: 1 },
} as const;

export type NumericPreference = keyof typeof NUMERIC_PREFERENCE_LIMITS;

export function validNumericPreference(key: NumericPreference, value: unknown): value is number {
  const { min, max, step } = NUMERIC_PREFERENCE_LIMITS[key];
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max &&
    value % step === 0
  );
}

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
    !validNumericPreference('cycleIntervalMs', record.cycleIntervalMs) ||
    (record.baselineMs !== undefined && !validNumericPreference('baselineMs', record.baselineMs)) ||
    (record.historyMaxCount !== undefined &&
      !validNumericPreference('historyMaxCount', record.historyMaxCount)) ||
    (record.historyMaxAgeMs !== undefined &&
      !validNumericPreference('historyMaxAgeMs', record.historyMaxAgeMs)) ||
    (record.inferenceTimeoutMs !== undefined &&
      !validNumericPreference('inferenceTimeoutMs', record.inferenceTimeoutMs)) ||
    (record.reasoningEnabled !== undefined && typeof record.reasoningEnabled !== 'boolean') ||
    (record.videoCaptureIntervalMs !== undefined &&
      !validNumericPreference('videoCaptureIntervalMs', record.videoCaptureIntervalMs)) ||
    (record.videoCoverageMs !== undefined &&
      !validNumericPreference('videoCoverageMs', record.videoCoverageMs)) ||
    (record.videoMinFrames !== undefined &&
      !validNumericPreference('videoMinFrames', record.videoMinFrames)) ||
    (record.videoMaxFrames !== undefined &&
      !validNumericPreference('videoMaxFrames', record.videoMaxFrames)) ||
    (record.videoSamplingStrategy !== undefined &&
      record.videoSamplingStrategy !== 'uniform' &&
      record.videoSamplingStrategy !== 'recent-weighted') ||
    ((record.videoMinFrames ?? DEFAULT_PREFERENCES.videoMinFrames) as number) >
      ((record.videoMaxFrames ?? DEFAULT_PREFERENCES.videoMaxFrames) as number)
  ) {
    throw new Error('Invalid simulation preferences.');
  }
  return { ...DEFAULT_PREFERENCES, ...record } as SessionPreferences;
}
