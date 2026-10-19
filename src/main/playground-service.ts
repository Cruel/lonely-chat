import type {
  FreeformRequest,
  FreeformResult,
  PlaygroundStatus,
  SimulationExperimentRequest,
  SimulationExperimentResult,
  FreeformUsage,
} from '../shared/playground-contract';
import { validateFreeformRequest } from '../shared/playground-contract';
import { extractNativeChat } from './native-inference';
import { validateSimulationCycle } from './simulation-cycle';
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

export interface PlaygroundProvider {
  completeFreeform(
    request: FreeformRequest,
    signal: AbortSignal,
  ): Promise<Omit<FreeformResult, 'modelId' | 'request'>>;
  completeSimulationRequest?(
    input: InferenceInput,
    request: unknown,
    signal: AbortSignal,
  ): Promise<unknown>;
  stop(): Promise<void>;
}

function nativeUsage(response: unknown): FreeformUsage | null {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return null;
  const usage = (response as { usage?: unknown }).usage;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const values = usage as Record<string, unknown>;
  const token = (key: string) => {
    const value = values[key];
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  };
  return {
    promptTokens: token('prompt_tokens'),
    completionTokens: token('completion_tokens'),
    totalTokens: token('total_tokens'),
  };
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

/**
 * One exclusive, ephemeral native worker at a time. Read-only with respect to
 * SessionController, ChatService, AudienceService and diagnostic capture.
 */
export class PlaygroundService {
  private active: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private listeners = new Set<(status: PlaygroundStatus) => void>();

  constructor(
    private readonly canRun: () => boolean,
    private readonly makeProvider: (modelId: string, needsVision: boolean) => PlaygroundProvider,
    private readonly beforeRun: () => Promise<void> = async () => {},
    private readonly historyLimits: () => Pick<
      SessionPreferences,
      'historyMaxAgeMs' | 'historyMaxCount'
    > = () => DEFAULT_PREFERENCES,
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

  private execute<T>(
    modelId: string,
    needsVision: boolean,
    operation: (provider: PlaygroundProvider, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.busy) throw new Error('Another Playground inference is in progress.');
    if (!this.canRun())
      throw new Error(
        'Stop Simulation and other native model operations before running Playground.',
      );
    const abort = new AbortController();
    this.abort = abort;
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
        if (!this.canRun() || abort.signal.aborted)
          throw new Error('Playground inference cancelled or Simulation became active.');
        provider = this.makeProvider(modelId, needsVision);
        return await operation(provider, abort.signal);
      } finally {
        try {
          await provider?.stop();
        } finally {
          this.abort = null;
          this.active = null;
          resolveDone();
          this.notify();
        }
      }
    })();
  }

  run(input: unknown): Promise<FreeformResult> {
    const request = validateFreeformRequest(input);
    return this.execute(
      request.modelId,
      Boolean(request.frames?.length),
      async (provider, signal) => ({
        ...(await provider.completeFreeform(request, signal)),
        modelId: request.modelId,
        request,
      }),
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
    );
    const constructedRequest = constructedSimulationRequest(cycleInput);
    const submittedRequest =
      request.rawRequestJson === undefined
        ? constructedRequest
        : validateRawSimulationRequest(request.rawRequestJson, request.frames);
    return { constructedRequest, submittedRequest };
  }

  runSimulation(input: unknown): Promise<SimulationExperimentResult> {
    const request: SimulationExperimentRequest = validateSimulationExperiment(input);
    const cycleInput = buildSimulationExperimentInput(
      request.values,
      Date.now(),
      this.historyLimits(),
      request.frames,
    );
    const constructedRequest = constructedSimulationRequest(cycleInput);
    const submittedRequest =
      request.rawRequestJson === undefined
        ? constructedRequest
        : validateRawSimulationRequest(request.rawRequestJson, request.frames);
    return this.executeSimulation(
      request.modelId,
      cycleInput,
      constructedRequest,
      submittedRequest,
      request.frames ?? [],
      request.values.playbackWindowMs,
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
    );
    return { result, child: await cases.saveChild(input.caseId, result) };
  }

  private executeSimulation(
    modelId: string,
    cycleInput: InferenceInput,
    constructedRequest: unknown,
    submittedRequest: unknown,
    frames: readonly PlaygroundFrame[],
    playbackWindowMs: number,
  ): Promise<SimulationExperimentResult> {
    return this.execute(modelId, frames.length > 0, async (provider, signal) => {
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
      let rawNativeOutput: unknown;
      try {
        if (!provider.completeSimulationRequest)
          throw new Error('Selected provider does not support structured Simulation requests.');
        rawNativeOutput = await provider.completeSimulationRequest(
          cycleInput,
          submittedRequest,
          signal,
        );
      } catch (error) {
        return finish({
          errorStage: 'transport',
          error: errorMessage(error),
          rawNativeOutput: boundedTransportDetails(error),
        });
      }
      const usage = nativeUsage(rawNativeOutput);
      let normalizedResult: unknown;
      try {
        normalizedResult = extractNativeChat(rawNativeOutput, cycleInput.roster);
      } catch (error) {
        return finish({
          rawNativeOutput,
          usage,
          errorStage: 'normalization',
          error: errorMessage(error),
        });
      }
      try {
        const { accepted } = validateSimulationCycle(cycleInput, normalizedResult);
        // Production native chat clips accepted offsets to the playback window.
        const scheduled = {
          ...accepted,
          messages: accepted.messages.map((message) => ({
            ...message,
            offsetMs: Math.min(message.offsetMs, playbackWindowMs),
          })),
        };
        return finish({ rawNativeOutput, normalizedResult, accepted: scheduled, usage });
      } catch (error) {
        return finish({
          rawNativeOutput,
          normalizedResult,
          usage,
          errorStage: 'validation',
          error: errorMessage(error),
        });
      }
    });
  }

  async stop(): Promise<void> {
    this.abort?.abort();
    await this.active;
  }
}
