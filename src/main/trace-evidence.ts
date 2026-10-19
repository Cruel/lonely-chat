import type { TraceAttempt, TraceFilter } from '../shared/inference-trace-contract';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function entries(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const result = record(item);
        return result ? [result] : [];
      })
    : [];
}
function uniqueStrings(items: unknown[]): string[] {
  return [
    ...new Set(items.filter((item): item is string => typeof item === 'string' && !!item)),
  ].sort();
}

export function traceFacets(attempt: TraceAttempt) {
  const input = record(attempt.input);
  const scheduled = record(attempt.scheduled);
  const accepted = record(attempt.accepted);
  const parsed = record(attempt.parsed);
  const boundary = record(input?.boundary);
  return {
    sources: uniqueStrings([
      ...entries(input?.recentTranscripts).flatMap((item) => [item.source, item.sourceId]),
      ...entries(input?.observations).map((item) => item.source),
      ...entries(input?.frames).map((item) => item.sourceId),
    ]),
    chatters: uniqueStrings([
      ...entries(input?.recentChat).map((item) => item.author),
      ...entries(accepted?.messages).map((item) => item.author),
      ...entries(scheduled?.messages).map((item) => item.author),
      ...entries(attempt.presented).map((item) => item.author),
    ]),
    eventKinds: uniqueStrings([
      ...entries(input?.recentEvents).map((item) => item.kind),
      ...entries(parsed?.events).map((item) => item.kind),
      ...entries(scheduled?.events).map((item) => item.kind),
    ]),
    boundary:
      typeof boundary?.fromMs === 'number' && typeof boundary.throughMs === 'number'
        ? { fromMs: boundary.fromMs, throughMs: boundary.throughMs }
        : null,
  };
}

/** Text matching happens only in main. Metadata listings never contain transcript/chat text or JPEG bytes. */
function searchableEvidence(attempt: TraceAttempt): string {
  const input = record(attempt.input);
  const scheduled = record(attempt.scheduled);
  const parsed = record(attempt.parsed);
  return [
    attempt.error,
    ...entries(input?.observations).map((item) => item.description),
    ...entries(input?.recentTranscripts).map((item) => item.text),
    ...entries(input?.recentEvents).map((item) => item.summary),
    ...entries(input?.recentChat).map((item) => item.text),
    ...entries(scheduled?.events).map((item) => item.summary),
    ...entries(scheduled?.messages).map((item) => item.text),
    ...entries(parsed?.events).map((item) => item.summary),
    ...entries(attempt.presented).map((item) => item.text),
  ]
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
    .toLowerCase();
}
export function validateTraceFilter(value: unknown): TraceFilter {
  const filter = record(value);
  if (
    !filter ||
    Object.keys(filter).some(
      (key) => !['text', 'failuresOnly', 'source', 'chatter', 'eventKind'].includes(key),
    ) ||
    typeof filter.text !== 'string' ||
    filter.text.length > 200 ||
    typeof filter.failuresOnly !== 'boolean' ||
    !['source', 'chatter', 'eventKind'].every(
      (key) => typeof filter[key] === 'string' && (filter[key] as string).length <= 100,
    )
  )
    throw new Error('Invalid inference trace filter.');
  return filter as unknown as TraceFilter;
}
export function matchesTraceFilter(attempt: TraceAttempt, filter: TraceFilter): boolean {
  if (filter.failuresOnly && attempt.stage !== 'failed') return false;
  const metadata = traceFacets(attempt);
  if (filter.source && !metadata.sources.includes(filter.source)) return false;
  if (filter.chatter && !metadata.chatters.includes(filter.chatter)) return false;
  if (filter.eventKind && !metadata.eventKinds.includes(filter.eventKind)) return false;
  const query = filter.text.trim().toLowerCase();
  return (
    !query ||
    [
      attempt.id,
      attempt.modelId,
      String(attempt.cycle),
      String(attempt.attempt),
      String(attempt.seed),
      ...metadata.sources,
      ...metadata.chatters,
      ...metadata.eventKinds,
    ].some((value) => value?.toLowerCase().includes(query)) ||
    searchableEvidence(attempt).includes(query)
  );
}
