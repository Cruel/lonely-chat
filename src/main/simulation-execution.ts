import type { InferenceInput } from './fake-inference';
import { clipSimulationWindow, validateSimulationCycle } from './simulation-cycle';
import type { InferenceTraceObserver } from './inference-trace';

export type SimulationExecutionStage = 'transport' | 'normalization' | 'validation';

export interface SimulationExecutionEvidence {
  readonly request: unknown;
  readonly rawNativeOutput: unknown | null;
  readonly normalizedResult: unknown | null;
  readonly parsedResult: ReturnType<typeof validateSimulationCycle>['parsed'] | null;
  readonly accepted: ReturnType<typeof validateSimulationCycle>['accepted'] | null;
}

/** Preserve the original cause and the last completed stage when execution fails. */
export class SimulationExecutionError extends Error {
  constructor(
    readonly stage: SimulationExecutionStage,
    readonly evidence: SimulationExecutionEvidence,
    readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : 'Unknown native inference error.');
    this.name = 'SimulationExecutionError';
  }
}

/**
 * Single transport/normalization seam for production and isolated Playground.
 * The caller supplies its owned provider, exact request, and trace observer.
 * No Session/Chat/history side effects occur here.
 */
export async function executeNativeSimulation(
  input: InferenceInput,
  request: unknown,
  signal: AbortSignal,
  submit: (request: unknown, signal: AbortSignal) => Promise<unknown>,
  normalize: (raw: unknown, input: InferenceInput) => unknown,
  observe?: InferenceTraceObserver,
): Promise<{ rawNativeOutput: unknown; normalizedResult: unknown }> {
  const evidence: SimulationExecutionEvidence = {
    request,
    rawNativeOutput: null,
    normalizedResult: null,
    parsedResult: null,
    accepted: null,
  };
  observe?.('request', request);
  let rawNativeOutput: unknown;
  try {
    rawNativeOutput = await submit(request, signal);
  } catch (error) {
    throw new SimulationExecutionError('transport', evidence, error);
  }
  observe?.('response', rawNativeOutput);
  let normalizedResult: unknown;
  try {
    normalizedResult = normalize(rawNativeOutput, input);
  } catch (error) {
    throw new SimulationExecutionError('normalization', { ...evidence, rawNativeOutput }, error);
  }
  observe?.('normalized', normalizedResult);
  return { rawNativeOutput, normalizedResult };
}

/**
 * Same parse, author-resolution and scheduling validation for Session and
 * Playground. Call only after Session's paused-completion barrier has resumed.
 */
export function acceptSimulationExecution(
  input: InferenceInput,
  normalizedResult: unknown,
  options: {
    enforceAudience?: boolean;
    playbackWindowMs?: number;
    onParsed?: (parsed: ReturnType<typeof validateSimulationCycle>['parsed']) => void;
  } = {},
): ReturnType<typeof validateSimulationCycle> {
  let parsedResult: SimulationExecutionEvidence['parsedResult'] = null;
  try {
    const result = validateSimulationCycle(
      input,
      normalizedResult,
      options.enforceAudience ?? true,
      (parsed) => {
        parsedResult = parsed;
        options.onParsed?.(parsed);
      },
    );
    return options.playbackWindowMs === undefined
      ? result
      : {
          ...result,
          accepted: clipSimulationWindow(result.accepted, options.playbackWindowMs),
        };
  } catch (error) {
    throw new SimulationExecutionError(
      'validation',
      {
        request: null,
        rawNativeOutput: null,
        normalizedResult,
        parsedResult,
        accepted: null,
      },
      error,
    );
  }
}
