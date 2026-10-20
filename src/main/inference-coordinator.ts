import type { InferenceInput } from './fake-inference';
import type { InferenceTraceObserver } from './inference-trace';
import { traceUsage } from './inference-trace';
import { acceptSimulationExecution } from './simulation-execution';
import {
  buildUnifiedInferenceRequest,
  type InferenceRequest,
  type UnifiedInferenceRequest,
} from './unified-inference-request';

export interface InferenceCapabilities {
  readonly images: boolean;
  readonly nativeVideo?: boolean;
}

/** Adapters own transport and protocol normalization, not validation or publication. */
export interface InferenceAdapter<Request extends InferenceRequest = InferenceRequest> {
  readonly capabilities: InferenceCapabilities;
  complete(
    request: Request,
    signal: AbortSignal,
    observe?: InferenceTraceObserver,
  ): Promise<{
    readonly raw: unknown;
    readonly normalized: unknown;
    readonly usage?: NormalizedInferenceUsage | null;
  }>;
}

export type UnifiedInferenceAdapter = InferenceAdapter<UnifiedInferenceRequest>;

/** Providers normalize their own usage fields into these optional counts. */
export interface NormalizedInferenceUsage {
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly totalTokens: number | null;
}

export interface UnifiedExecutionOptions {
  readonly signal: AbortSignal;
  readonly nativeVideoRef?: string;
  readonly enforceAudience?: boolean;
  readonly playbackWindowMs?: number;
  readonly maxAttempts?: number;
  readonly beforeAccept?: () => Promise<void>;
  readonly onParsed?: (parsed: ReturnType<typeof acceptSimulationExecution>['parsed']) => void;
  readonly observe?: InferenceTraceObserver;
  readonly onAttempt?: (attempt: number, error: unknown) => void;
  readonly onTransport?: (raw: unknown, normalized: unknown) => void;
}

export interface UnifiedExecutionResult {
  readonly request: UnifiedInferenceRequest;
  readonly raw: unknown;
  readonly normalized: unknown;
  readonly parsed: ReturnType<typeof acceptSimulationExecution>['parsed'];
  readonly accepted: ReturnType<typeof acceptSimulationExecution>['accepted'];
  readonly usage: NormalizedInferenceUsage | null;
  readonly attempts: number;
}

function immutable<T>(value: T): T {
  const clone = structuredClone(value);
  const freeze = (entry: unknown): void => {
    if (!entry || typeof entry !== 'object' || Object.isFrozen(entry)) return;
    for (const child of Object.values(entry)) freeze(child);
    Object.freeze(entry);
  };
  freeze(clone);
  return clone;
}

function cancelled(): Error {
  return new DOMException('Inference cancelled.', 'AbortError');
}

/**
 * Run-independent authority for one Unified execution. The Session owns Event
 * history and publication; this seam returns only validated, accepted batches.
 */
export class InferenceCoordinator {
  private readonly active = new Set<AbortController>();

  /** Stop immediately revokes the publication authority of every pending call. */
  cancelActive(): void {
    for (const controller of this.active) controller.abort();
  }

  async execute(
    input: InferenceInput,
    adapter: UnifiedInferenceAdapter,
    options: UnifiedExecutionOptions,
  ): Promise<UnifiedExecutionResult> {
    const count = options.maxAttempts ?? 1;
    if (!Number.isInteger(count) || count < 1 || count > 3)
      throw new Error('Unified inference attempts must be between 1 and 3.');
    const snapshot = immutable(input);
    if (options.nativeVideoRef !== undefined && !options.nativeVideoRef.trim())
      throw new Error('Native-video reference must not be empty.');
    const request = immutable(buildUnifiedInferenceRequest(snapshot, options.nativeVideoRef));
    if (request.nativeVideo && !adapter.capabilities.nativeVideo)
      throw new Error('The selected inference model does not support native video.');
    if (request.content.some((part) => part.type === 'image') && !adapter.capabilities.images)
      throw new Error('The selected inference model does not accept image frames.');
    const controller = new AbortController();
    this.active.add(controller);
    const signal = AbortSignal.any([controller.signal, options.signal]);
    try {
      for (let attempt = 1; attempt <= count; attempt++) {
        if (signal.aborted) throw cancelled();
        try {
          const result = await adapter.complete(request, signal, options.observe);
          if (signal.aborted) throw cancelled();
          options.onTransport?.(result.raw, result.normalized);
          await options.beforeAccept?.();
          if (signal.aborted) throw cancelled();
          const { parsed, accepted } = acceptSimulationExecution(snapshot, result.normalized, {
            enforceAudience: options.enforceAudience,
            playbackWindowMs: options.playbackWindowMs,
            onParsed: options.onParsed,
          });
          if (signal.aborted) throw cancelled();
          return {
            request,
            raw: result.raw,
            normalized: result.normalized,
            parsed,
            accepted,
            usage: result.usage === undefined ? traceUsage(result.raw) : result.usage,
            attempts: attempt,
          };
        } catch (error) {
          // Preserve a transport's original cancellation reason; a late successful
          // completion is still rejected by the post-transport abort check.
          if (signal.aborted) throw error;
          options.onAttempt?.(attempt, error);
          if (attempt === count) throw error;
        }
      }
      throw new Error('Unified inference attempts exhausted.');
    } finally {
      this.active.delete(controller);
    }
  }
}
