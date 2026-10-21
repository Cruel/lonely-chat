import type { InferenceInput } from './fake-inference';
import type { UnifiedInferenceRequest } from './unified-inference-request';
import type { InferenceTraceObserver } from './inference-trace';
import type { TraceAttempt, TraceRole } from '../shared/inference-trace-contract';

/** The stage coordinator emits evidence, not Inspector-specific state mutations. */
export interface StageTraceCapture {
  readonly id: string;
  readonly observe: InferenceTraceObserver;
  update(patch: Partial<TraceAttempt>): void;
}

export type StageTraceFactory = (
  role: Exclude<TraceRole, 'unified'>,
  input: InferenceInput,
  request: UnifiedInferenceRequest,
  observedAt: number | null,
  dependsOn: readonly string[],
) => StageTraceCapture;

/** Capture metadata and text, but never retain binary media or credential fields. */
export function privateStageMetadata(value: unknown): unknown {
  const seen = new WeakSet<object>();
  const visit = (item: unknown, depth: number): unknown => {
    if (depth > 24) return { omitted: true, reason: 'Capture depth limit' };
    if (typeof item === 'string') {
      if (/^data:(?:image|audio|video)\//i.test(item))
        return { mediaOmitted: true, encodedBytes: item.length };
      return item.length > 100_000
        ? { omitted: true, reason: 'Oversized string', characters: item.length }
        : item;
    }
    if (!item || typeof item !== 'object') return item;
    if (seen.has(item)) return { omitted: true, reason: 'Circular reference' };
    seen.add(item);
    const result = Array.isArray(item)
      ? item.map((child) => visit(child, depth + 1))
      : Object.fromEntries(
          Object.entries(item).map(([key, child]) => [
            key,
            /^(?:authorization|proxy-authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|cookie|set-cookie|password|client[-_]?secret)$/i.test(
              key,
            )
              ? '[redacted]'
              : visit(child, depth + 1),
          ]),
        );
    seen.delete(item);
    return result;
  };
  return visit(value, 0);
}

/** Stable source refs are generated at admission, not inferred from wall-clock ordering. */
export function stageFrameIds(input: InferenceInput): string[] {
  const refs = (frames: InferenceInput['frames'], selected?: readonly string[]) =>
    (frames ?? [])
      .slice(0, 32)
      .map((frame, index) =>
        selected && selected.length === frames?.length && selected[index]
          ? selected[index]
          : `${frame.sourceId}:${frame.observedAt}:${frame.mediaTimeMs ?? 'wall'}`,
      );
  return [
    ...refs(input.frames, input.captureSelection?.frames),
    ...refs(input.chatFrames, input.captureSelection?.chatFrames),
  ].slice(0, 64);
}

export function stageObservationRefs(input: InferenceInput): string[] {
  return [
    ...(input.observations ?? [])
      .slice(0, 64)
      .map((item, index) =>
        input.captureSelection?.observations[index] !== undefined
          ? `observation:${input.captureSelection.observations[index]}`
          : `observation:${item.source}:${item.observedAt}`,
      ),
    ...(input.recentTranscripts ?? [])
      .slice(0, 64)
      .map((item) => `transcript:${item.sourceId}:${item.observedAt}`),
  ];
}
