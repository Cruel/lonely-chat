import type {
  FreeformRequest,
  FreeformResult,
  PlaygroundStatus,
  SimulationExperimentRequest,
  SimulationExperimentResult,
} from '../shared/playground-contract';
import { validateFreeformRequest } from '../shared/playground-contract';
import { extractNativeChat, withNativeVideoPlaceholder } from './native-inference';
import { executeNativeSimulation, SimulationExecutionError } from './simulation-execution';
import { InferenceCoordinator } from './inference-coordinator';
import { llamaCppAdapter } from './unified-inference-adapters';
import {
  buildSimulationExperimentInput,
  constructedSimulationRequest,
  validateRawSimulationRequest,
  validateSimulationExperiment,
} from './simulation-experiment';
import type { InferenceInput } from './fake-inference';
import type { SavedCaseFork, SavedCaseForkResult } from '../shared/saved-case-contract';
import type { SavedInferenceCases } from './saved-inference-cases';
import type { PlaygroundFrame } from '../shared/playground-media-contract';
import { DEFAULT_PREFERENCES, type SessionPreferences } from '../shared/session-contract';
import { PrivateInferenceError } from './private-inference-error';
import { traceUsage } from './inference-trace';
import {
  DEFAULT_NATIVE_VIDEO_PREFERENCES,
  type NativeVideoPreferences,
} from '../shared/video-tools-contract';

export interface PlaygroundProvider {
  completeFreeform(
    request: FreeformRequest,
    signal: AbortSignal,
  ): Promise<Omit<FreeformResult, 'modelId' | 'request'>>;
  completeSimulationRequest?(
    input: InferenceInput,
    request: unknown,
    signal: AbortSignal,
    videoToken?: string,
    videoOptions?: NativeVideoPreferences,
  ): Promise<unknown>;
  stop(): Promise<void>;
}

/** Private, desktop-only inspector content; never enter the persistent operational log. */
function boundedTransportDetails(error: unknown): unknown | null {
  if (!(error instanceof PrivateInferenceError)) return null;
  try {
    const json = JSON.stringify(error.diagnosticDetails);
    if (!json) return null;
    if (json.length > 64 * 1024)
      return {
        truncated: true,
        preview: json.slice(0, 64 * 1024),
        totalCharacters: json.length,
      };
    return JSON.parse(json) as unknown;
  } catch {
    return { truncated: true, reason: 'Native diagnostic details could not be serialized.' };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown native inference error.';
}

const IDLE_WORKER_MS = 5 * 60_000;

/**
 * One exclusive native worker at a time. Successful Playground requests retain
 * an idle worker for prompt/KV cache reuse; Simulation and shutdown evict it.
 * No Playground work mutates Session, Chat, Audience, or diagnostic capture.
 */
export class PlaygroundService {
  private readonly coordinator = new InferenceCoordinator();
  private active: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private cached: { key: string; provider: PlaygroundProvider } | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private retiring: Promise<void> = Promise.resolve();
  private shutdown: Promise<void> | null = null;
  private listeners = new Set<(status: PlaygroundStatus) => void>();

  constructor(
    private readonly canRun: () => boolean,
    private readonly makeProvider: (
      modelId: string,
      needsVision: boolean,
      videoOptions?: NativeVideoPreferences,
      imageMaxTokens?: number,
    ) => PlaygroundProvider,
    private readonly beforeRun: () => Promise<void> = async () => {},
    private readonly historyLimits: () => Pick<
      SessionPreferences,
      'historyMaxAgeMs' | 'historyMaxCount'
    > = () => DEFAULT_PREFERENCES,
    private readonly workerFingerprint: (modelId: string, needsVision: boolean) => string = () =>
      '',
    private readonly idleWorkerMs = IDLE_WORKER_MS,
    private readonly videoDefaults: () => NativeVideoPreferences = () =>
      DEFAULT_NATIVE_VIDEO_PREFERENCES,
  ) {}

  get busy(): boolean {
    return this.active !== null;
  }
  snapshot(): PlaygroundStatus {
    return { busy: this.busy };
  }
  subscribe(listener: (status: PlaygroundStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private notify(): void {
    for (const listener of this.listeners) listener(this.snapshot());
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    if (!this.cached || this.active || this.shutdown) return;
    this.idleTimer = setTimeout(() => {
      // Eviction is serialized with any new request's worker acquisition.
      void this.evictIdle().catch(() => {});
    }, this.idleWorkerMs);
    this.idleTimer.unref?.();
  }

  private async retire(provider: PlaygroundProvider): Promise<void> {
    const task = this.retiring.then(() => provider.stop());
    this.retiring = task.catch(() => {});
    await task;
  }

  /** Release an idle worker (and await in-progress retirement) before other model ownership. */
  async evictIdle(): Promise<void> {
    this.clearIdleTimer();
    const cached = this.cached;
    this.cached = null;
    if (cached) await this.retire(cached.provider);
    else await this.retiring;
  }

  private execute<T>(
    modelId: string,
    needsVision: boolean,
    operation: (provider: PlaygroundProvider, signal: AbortSignal) => Promise<T>,
    reusable: (result: T) => boolean = () => true,
    videoOptions?: NativeVideoPreferences,
    imageMaxTokens?: number,
  ): Promise<T> {
    if (this.busy || this.shutdown) throw new Error('Another Playground inference is in progress.');
    if (!this.canRun())
      throw new Error(
        'Stop Simulation and other native model operations before running Playground.',
      );
    const abort = new AbortController();
    this.abort = abort;
    this.clearIdleTimer();
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    this.active = done;
    this.notify();
    return (async () => {
      let provider: PlaygroundProvider | null = null;
      try {
        await this.beforeRun();
        await this.retiring;
        if (!this.canRun() || abort.signal.aborted || this.shutdown)
          throw new Error('Playground inference cancelled or Simulation became active.');
        const key = JSON.stringify([
          modelId,
          needsVision,
          videoOptions ?? null,
          imageMaxTokens ?? null,
          this.workerFingerprint(modelId, needsVision),
        ]);
        if (this.cached && this.cached.key !== key) await this.evictIdle();
        if (!this.canRun() || abort.signal.aborted || this.shutdown)
          throw new Error('Playground inference cancelled or Simulation became active.');
        if (this.cached) {
          provider = this.cached.provider;
          this.cached = null;
        } else {
          provider =
            imageMaxTokens !== undefined
              ? this.makeProvider(modelId, needsVision, videoOptions, imageMaxTokens)
              : videoOptions
                ? this.makeProvider(modelId, needsVision, videoOptions)
                : this.makeProvider(modelId, needsVision);
        }
        const result = await operation(provider, abort.signal);
        // Structured experiments report transport/cancellation errors in their result.
        // Preserve that result, but never retain a cancelled or unhealthy worker.
        if (!abort.signal.aborted && !this.shutdown && reusable(result)) {
          this.cached = { key, provider };
          provider = null;
        }
        return result;
      } finally {
        try {
          if (provider) await this.retire(provider);
        } finally {
          this.abort = null;
          this.active = null;
          resolveDone();
          this.armIdleTimer();
          this.notify();
        }
      }
    })();
  }

  run(input: unknown): Promise<FreeformResult> {
    const request = validateFreeformRequest(input);
    const videoOptions = request.video ? (request.videoOptions ?? this.videoDefaults()) : undefined;
    const prepared = videoOptions ? { ...request, videoOptions } : request;
    return this.execute(
      request.modelId,
      Boolean(request.frames?.length || request.video),
      async (provider, signal) => ({
        ...(await provider.completeFreeform(prepared, signal)),
        modelId: request.modelId,
        request: prepared,
      }),
      () => true,
      videoOptions,
      request.imageMaxTokens,
    );
  }

  /** Read-only preview, available even while Simulation owns the native worker. */
  previewSimulation(input: unknown): { constructedRequest: unknown; submittedRequest: unknown } {
    const request = validateSimulationExperiment(input);
    const cycleInput = buildSimulationExperimentInput(
      request.values,
      Date.now(),
      this.historyLimits(),
      request.frames,
      request.seed,
    );
    const constructedRequest = request.video
      ? withNativeVideoPlaceholder(constructedSimulationRequest(cycleInput))
      : constructedSimulationRequest(cycleInput);
    const raw =
      request.rawRequestJson === undefined
        ? null
        : validateRawSimulationRequest(request.rawRequestJson, request.frames);
    const submittedRequest = raw
      ? { ...raw, seed: raw.seed ?? cycleInput.seed }
      : constructedRequest;
    return { constructedRequest, submittedRequest };
  }

  runSimulation(input: unknown): Promise<SimulationExperimentResult> {
    const request: SimulationExperimentRequest = validateSimulationExperiment(input);
    const cycleInput = buildSimulationExperimentInput(
      request.values,
      Date.now(),
      this.historyLimits(),
      request.frames,
      request.seed,
    );
    const constructedRequest = request.video
      ? withNativeVideoPlaceholder(constructedSimulationRequest(cycleInput))
      : constructedSimulationRequest(cycleInput);
    const raw =
      request.rawRequestJson === undefined
        ? null
        : validateRawSimulationRequest(request.rawRequestJson, request.frames);
    const submittedRequest = raw
      ? { ...raw, seed: raw.seed ?? cycleInput.seed }
      : constructedRequest;
    return this.executeSimulation(
      request.modelId,
      cycleInput,
      constructedRequest,
      submittedRequest,
      request.frames ?? [],
      request.values.playbackWindowMs,
      request.video?.token,
      request.video ? (request.videoOptions ?? this.videoDefaults()) : undefined,
      request.imageMaxTokens,
    );
  }

  /** Fork runs use the original captured input and request, never today's prompt builder. */
  async runSavedCase(
    input: SavedCaseFork,
    cases: SavedInferenceCases,
  ): Promise<SavedCaseForkResult> {
    const prepared = await cases.prepareFork(input);
    const result = await this.executeSimulation(
      prepared.modelId,
      prepared.input,
      prepared.submitted,
      prepared.submitted,
      prepared.frames,
      prepared.input.playbackWindowMs ?? 3000,
      undefined,
      undefined,
      undefined,
      true,
    );
    return { result, child: await cases.saveChild(input.caseId, result, input.frameIndices) };
  }

  private executeSimulation(
    modelId: string,
    cycleInput: InferenceInput,
    constructedRequest: unknown,
    submittedRequest: unknown,
    frames: readonly PlaygroundFrame[],
    playbackWindowMs: number,
    videoToken?: string,
    videoOptions?: NativeVideoPreferences,
    imageMaxTokens?: number,
    useCapturedRequest = false,
  ): Promise<SimulationExperimentResult> {
    return this.execute(
      modelId,
      frames.length > 0 || Boolean(videoToken),
      async (provider, signal) => {
        const startedAt = new Date().toISOString();
        const start = performance.now();
        const result: SimulationExperimentResult = {
          modelId,
          ...(frames.length ? { submittedFrames: frames } : {}),
          startedAt,
          durationMs: 0,
          constructedRequest,
          submittedRequest,
          rawNativeOutput: null,
          normalizedResult: null,
          parsedResult: null,
          accepted: null,
          errorStage: null,
          error: null,
          usage: null,
        };
        const finish = (updates: Partial<SimulationExperimentResult>) => ({
          ...result,
          ...updates,
          durationMs: Math.round(performance.now() - start),
        });
        let rawNativeOutput: unknown = null;
        let normalizedResult: unknown = null;
        let parsedResult: SimulationExperimentResult['parsedResult'] = null;
        try {
          if (!provider.completeSimulationRequest)
            throw new Error('Selected provider does not support structured Simulation requests.');
          const adapter = llamaCppAdapter(
            {
              completeSimulationRequest: (input, request, activeSignal, token, options) =>
                provider.completeSimulationRequest!(input, request, activeSignal, token, options),
            },
            cycleInput,
            videoToken ? { token: videoToken, options: videoOptions } : undefined,
          );
          // Exact saved cases and explicit raw overrides must send the captured
          // native bytes, not silently rebuild a changed request.
          const effectiveAdapter =
            useCapturedRequest || submittedRequest !== constructedRequest
              ? {
                  ...adapter,
                  complete: async (
                    _request: Parameters<typeof adapter.complete>[0],
                    activeSignal: AbortSignal,
                    observe?: Parameters<typeof adapter.complete>[2],
                  ) => {
                    const transported = await executeNativeSimulation(
                      cycleInput,
                      submittedRequest,
                      activeSignal,
                      (nativeRequest, transportSignal) =>
                        videoToken
                          ? provider.completeSimulationRequest!(
                              cycleInput,
                              nativeRequest,
                              transportSignal,
                              videoToken,
                              videoOptions,
                            )
                          : provider.completeSimulationRequest!(
                              cycleInput,
                              nativeRequest,
                              transportSignal,
                            ),
                      (raw, input) => extractNativeChat(raw, input.roster),
                      observe,
                    );
                    return {
                      raw: transported.rawNativeOutput,
                      normalized: transported.normalizedResult,
                    };
                  },
                }
              : adapter;
          const execution = await this.coordinator.execute(cycleInput, effectiveAdapter, {
            signal,
            ...(videoToken ? { nativeVideoRef: videoToken } : {}),
            playbackWindowMs,
            onParsed: (parsed) => {
              parsedResult = parsed;
            },
            onTransport: (raw, normalized) => {
              rawNativeOutput = raw;
              normalizedResult = normalized;
            },
          });
          return finish({
            rawNativeOutput: execution.raw,
            normalizedResult: execution.normalized,
            parsedResult: execution.parsed,
            accepted: execution.accepted,
            usage: execution.usage,
          });
        } catch (error) {
          const failed = error instanceof SimulationExecutionError ? error : null;
          const actualRaw = rawNativeOutput ?? failed?.evidence.rawNativeOutput ?? null;
          return finish({
            rawNativeOutput: actualRaw ?? boundedTransportDetails(failed?.cause ?? error),
            normalizedResult: normalizedResult ?? failed?.evidence.normalizedResult ?? null,
            parsedResult: parsedResult ?? failed?.evidence.parsedResult ?? null,
            usage: traceUsage(actualRaw),
            errorStage: failed?.stage ?? 'transport',
            error: errorMessage(failed?.cause ?? error),
          });
        }
      },
      (result) => result.errorStage !== 'transport',
      videoOptions,
      imageMaxTokens,
    );
  }

  /** Shutdown or another owner: cancel active work, then release even an idle cached worker. */
  stop(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.abort?.abort();
    this.coordinator.cancelActive();
    const task = (async () => {
      await this.active;
      await this.evictIdle();
    })();
    this.shutdown = task;
    void task
      .finally(() => {
        if (this.shutdown === task) this.shutdown = null;
      })
      .catch(() => {});
    return task;
  }
}
