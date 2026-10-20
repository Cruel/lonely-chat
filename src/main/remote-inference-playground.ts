import { InferenceCoordinator, type UnifiedInferenceAdapter } from './inference-coordinator';
import { SimulationExecutionError } from './simulation-execution';
import {
  buildSimulationExperimentInput,
  validateSimulationExperiment,
} from './simulation-experiment';
import { remoteUnifiedAdapter, type RemoteSelection } from './remote-inference-adapter';
import { buildUnifiedInferenceRequest } from './unified-inference-request';
import { DEFAULT_PREFERENCES, type SessionPreferences } from '../shared/session-contract';
import type { SimulationExperimentResult } from '../shared/playground-contract';

/** The same Coordinator and acceptance path as Session, but never commits Chat or history. */
export class RemoteInferencePlayground {
  private readonly coordinator = new InferenceCoordinator();
  private abort: AbortController | null = null;

  get busy(): boolean {
    return this.abort !== null;
  }

  stop(): void {
    this.abort?.abort();
    this.coordinator.cancelActive();
  }

  async run(
    value: unknown,
    selection: RemoteSelection,
    preferences: Pick<
      SessionPreferences,
      'historyMaxAgeMs' | 'historyMaxCount' | 'inferenceTimeoutMs'
    > = DEFAULT_PREFERENCES,
    adapterFactory?: (
      roster: readonly import('../shared/audience-contract').ChatterIdentity[],
    ) => UnifiedInferenceAdapter,
  ): Promise<SimulationExperimentResult> {
    if (this.abort) throw new Error('Another remote Playground inference is in progress.');
    const request = validateSimulationExperiment(value);
    if (
      request.video ||
      request.videoMode === 'native-video' ||
      request.rawRequestJson !== undefined
    )
      throw new Error(
        'Remote Playground supports ordered frames, not native-video or llama.cpp raw request overrides.',
      );
    const input = buildSimulationExperimentInput(
      request.values,
      Date.now(),
      preferences,
      request.frames,
      request.seed,
    );
    const constructed = buildUnifiedInferenceRequest(input);
    const result: SimulationExperimentResult = {
      modelId: selection.model.id,
      ...(request.frames?.length ? { submittedFrames: request.frames } : {}),
      startedAt: new Date().toISOString(),
      durationMs: 0,
      constructedRequest: {
        ...constructed,
        content: constructed.content.map((part) =>
          part.type === 'image' ? { ...part, dataUrl: '[media redacted]' } : part,
        ),
      },
      submittedRequest: { model: selection.model.model, protocol: selection.connection.protocol },
      rawNativeOutput: null,
      normalizedResult: null,
      parsedResult: null,
      accepted: null,
      errorStage: null,
      error: null,
      usage: null,
    };
    const start = performance.now();
    const abort = new AbortController();
    this.abort = abort;
    try {
      const execution = await this.coordinator.execute(
        input,
        adapterFactory?.(input.roster ?? []) ??
          remoteUnifiedAdapter(selection, {
            timeoutMs: preferences.inferenceTimeoutMs,
            roster: input.roster,
          }),
        {
          signal: abort.signal,
          enforceAudience: true,
          playbackWindowMs: request.values.playbackWindowMs,
        },
      );
      return {
        ...result,
        durationMs: Math.round(performance.now() - start),
        rawNativeOutput: execution.raw,
        normalizedResult: execution.normalized,
        parsedResult: execution.parsed,
        accepted: execution.accepted,
        usage: execution.usage,
      };
    } catch (error) {
      return {
        ...result,
        durationMs: Math.round(performance.now() - start),
        errorStage: error instanceof SimulationExecutionError ? error.stage : 'transport',
        error: error instanceof Error ? error.message : 'Remote inference failed.',
      };
    } finally {
      if (this.abort === abort) this.abort = null;
    }
  }
}
