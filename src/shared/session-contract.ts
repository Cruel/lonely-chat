export type SessionPhase = 'stopped' | 'starting' | 'running' | 'switching' | 'error';
export type InferenceMode = 'fake' | 'native';
import type { RecordedTranscriptMode } from './recorded-transcript-cache';
import type { RecordedScenarioConfig } from './recorded-scenario-contract';
export interface SimulationInputOptions {
  readonly inputMode: 'live' | 'recorded';
  /** Recorded chat stays in desktop preview unless explicitly published. */
  readonly publishToOverlay: boolean;
  readonly hasVideoFile?: boolean;
  readonly hasAudioFiles?: boolean;
  readonly transcriptMode?: RecordedTranscriptMode;
  /** Optional user-selected seed; otherwise generate a new effective seed at Start. */
  readonly seed?: number;
  /** Revision resolved atomically by main at Start; never follow subsequent edits. */
  readonly presetId?: string;
  readonly presetRevision?: number;
  /** Desktop-only frozen source selections; absent for legacy/manual invocations. */
  readonly recordedConfig?: RecordedScenarioConfig;
  readonly recordedScenarioId?: string;
}
export type VideoSamplingStrategy = 'uniform' | 'recent-weighted';
export type ComputeBackend = 'auto' | 'cpu' | 'cuda' | 'vulkan' | 'metal';
import type { ChatActivity } from './audience-contract';

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
  /** Stable identity of the configured input, even when its label changes. */
  readonly sourceId?: string;
  /** Correlates an opt-in raw PCM evidence clip to this exact Whisper result. Never contains PCM. */
  readonly speechSegmentId?: string;
  readonly source: string;
  readonly text: string;
  readonly observedAt: number;
}

/** Private desktop-only lifecycle information. Never served through /overlay. */
export interface SessionSnapshot {
  readonly revision: number;
  /** Distinct session execution number (not the persistent Run UUID). */
  readonly runId?: number;
  readonly phase: SessionPhase;
  readonly error: string | null;
  /** Stable machine-readable failure identity, independent of the displayed message. */
  readonly failureKind?: 'recorded-video' | 'recorded-media' | 'inference' | null;
  readonly warning: string | null;
  /** Recorded-media lifecycle; null for live sessions. */
  readonly recordedPlayback?: 'playing' | 'paused' | 'draining' | 'completed' | null;
  /** Main-process authority: paused Recorded Run with no in-flight inference. */
  readonly playgroundAvailable?: boolean;
  readonly cycle: number;
  readonly retryAttempt: number;
  /** Base seed for this session (whether user-supplied or generated). */
  readonly sessionSeed?: number | null;
  readonly promptPreset?: {
    readonly id: string;
    readonly name: string;
    readonly revision: number;
  } | null;
  /** Most recent actually submitted inference attempt seed. */
  readonly effectiveSeed?: number | null;
  /** Bounded, chronological record of submitted inference seeds. */
  readonly recentAttemptSeeds?: readonly { cycle: number; attempt: number; seed: number }[];
  readonly pendingMessages: number;
  readonly mode: InferenceMode;
  readonly inputMode?: 'live' | 'recorded';
  readonly transcriptMode?: RecordedTranscriptMode;
  /** Selected VLM installation ID, or null for fixtures/unconfigured models. */
  readonly modelId?: string | null;
  readonly events: readonly InferredEvent[];
  readonly latestInferenceMs: number | null;
  readonly smoothedInferenceMs: number | null;
  readonly playbackWindowMs: number;
  /** Capture cadence frozen for this Run, including recoverable errors. */
  readonly effectiveVideoCaptureIntervalMs?: number;
  readonly droppedObservations: number;
  readonly estimatedNextInferenceMs?: number | null;
  readonly adaptiveFrameLimit?: number | null;
  readonly effectiveCycleMs?: number | null;
  readonly adaptationReason?: string | null;
  readonly workerRamMiB?: number | null;
  readonly recentErrors?: readonly string[];
}

export function isRecordedMediaFailure(state: SessionSnapshot): boolean {
  return (
    state.phase === 'error' &&
    (state.failureKind === 'recorded-video' || state.failureKind === 'recorded-media')
  );
}

/** Kept for callers that only distinguish fatal media errors from retriable inference errors. */
export const isRecordedVideoFailure = isRecordedMediaFailure;

/** Decoder failures are fatal; recoverable inference errors retain recorded media. */
export function allowsRecordedSessionMedia(state: SessionSnapshot): boolean {
  return (
    ['starting', 'running', 'switching'].includes(state.phase) ||
    (state.phase === 'error' && state.inputMode === 'recorded' && !isRecordedVideoFailure(state))
  );
}

export interface SessionPreferences {
  /** Minimum interval between inference starts, independent of playback. */
  readonly cycleIntervalMs: number;
  readonly audienceCount: number;
  readonly chatActivity: ChatActivity;
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
  /** Best-effort process/model targets, never enforceable memory or compute quotas. */
  readonly ramBudgetMiB: number;
  readonly vramBudgetMiB: number;
  readonly gpuComputeTargetPercent: number;
  readonly computeBackend: ComputeBackend;
  readonly cpuThreads: number;
  readonly contextTokens: number;
  readonly gpuOffloadLayers: number;
}

export const DEFAULT_PREFERENCES: SessionPreferences = {
  cycleIntervalMs: 3000,
  audienceCount: 3,
  chatActivity: 'normal',
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
  ramBudgetMiB: 4096,
  vramBudgetMiB: 0,
  gpuComputeTargetPercent: 0,
  computeBackend: 'auto',
  cpuThreads: 4,
  contextTokens: 4096,
  gpuOffloadLayers: 0,
};
export const AUDIENCE_COUNT_OPTIONS = [3, 5, 10, 25, 50] as const;
export const CYCLE_INTERVAL_OPTIONS = [1500, 3000, 5000] as const;
export const BASELINE_OPTIONS = [0, 1000, 3000] as const;
export const HISTORY_COUNT_OPTIONS = [16, 32, 64] as const;
export const HISTORY_AGE_OPTIONS = [30000, 60000, 300000] as const;
export const INFERENCE_TIMEOUT_OPTIONS = [30000, 120000, 300000, 600000, 1200000] as const;
export const VIDEO_CAPTURE_INTERVAL_OPTIONS = [250, 500, 1000, 2000] as const;
export const VIDEO_COVERAGE_OPTIONS = [10000, 30000, 60000] as const;
export const VIDEO_FRAME_COUNT_OPTIONS = [2, 4, 8, 12, 24, 32] as const;
export const RAM_BUDGET_OPTIONS = [1024, 2048, 4096, 8192, 16384] as const;
export const VRAM_BUDGET_OPTIONS = [0, 2048, 4096, 8192, 12288, 16384] as const;
export const GPU_COMPUTE_OPTIONS = [0, 25, 40, 60, 80, 100] as const;
export const CPU_THREAD_OPTIONS = [1, 2, 4, 8, 12, 16] as const;
export const CONTEXT_TOKEN_OPTIONS = [2048, 4096, 8192, 16384] as const;
export const GPU_LAYER_OPTIONS = [0, 8, 16, 32, 64] as const;

/** Editable settings use strict bounds to limit timers, memory and prompt size. */
export const NUMERIC_PREFERENCE_LIMITS = {
  cycleIntervalMs: { min: 500, max: 60000, step: 100 },
  audienceCount: { min: 1, max: 100, step: 1 },
  baselineMs: { min: 0, max: 60000, step: 100 },
  historyMaxCount: { min: 1, max: 256, step: 1 },
  historyMaxAgeMs: { min: 1000, max: 3600000, step: 1000 },
  inferenceTimeoutMs: { min: 10000, max: 3600000, step: 1000 },
  videoCaptureIntervalMs: { min: 250, max: 5000, step: 50 },
  videoCoverageMs: { min: 3000, max: 60000, step: 1000 },
  videoMinFrames: { min: 1, max: 32, step: 1 },
  videoMaxFrames: { min: 1, max: 32, step: 1 },
  ramBudgetMiB: { min: 256, max: 262144, step: 1 },
  vramBudgetMiB: { min: 0, max: 262144, step: 1 },
  gpuComputeTargetPercent: { min: 0, max: 100, step: 1 },
  cpuThreads: { min: 1, max: 128, step: 1 },
  contextTokens: { min: 512, max: 32768, step: 256 },
  gpuOffloadLayers: { min: 0, max: 999, step: 1 },
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
    (record.audienceCount !== undefined &&
      !validNumericPreference('audienceCount', record.audienceCount)) ||
    (record.chatActivity !== undefined &&
      !['quiet', 'normal', 'busy'].includes(record.chatActivity as string)) ||
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
    (record.ramBudgetMiB !== undefined &&
      !validNumericPreference('ramBudgetMiB', record.ramBudgetMiB)) ||
    (record.vramBudgetMiB !== undefined &&
      !validNumericPreference('vramBudgetMiB', record.vramBudgetMiB)) ||
    (record.gpuComputeTargetPercent !== undefined &&
      !validNumericPreference('gpuComputeTargetPercent', record.gpuComputeTargetPercent)) ||
    (record.cpuThreads !== undefined && !validNumericPreference('cpuThreads', record.cpuThreads)) ||
    (record.contextTokens !== undefined &&
      !validNumericPreference('contextTokens', record.contextTokens)) ||
    (record.gpuOffloadLayers !== undefined &&
      !validNumericPreference('gpuOffloadLayers', record.gpuOffloadLayers)) ||
    (record.computeBackend !== undefined &&
      !['auto', 'cpu', 'cuda', 'vulkan', 'metal'].includes(record.computeBackend as string)) ||
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
