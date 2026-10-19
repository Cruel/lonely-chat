import type { TraceAttempt } from '../shared/inference-trace-contract';

export interface TimelineItem {
  readonly key: string;
  readonly timestamp: number | null;
  readonly kind: 'boundary' | 'observation' | 'frame' | 'transcript' | 'event' | 'batch' | 'chat';
  readonly title: string;
  readonly description: string;
  readonly state?: 'shown' | 'pending' | 'not-shown';
}
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function entries(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const object = record(item);
        return object ? [object] : [];
      })
    : [];
}
function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
/** The source and presentation clocks share the main process observation timeline. */
export function attemptTimeline(attempt: TraceAttempt): TimelineItem[] {
  const input = record(attempt.input);
  const boundary = record(input?.boundary);
  const selection = record(input?.captureSelection);
  const scheduled = record(attempt.scheduled);
  const enqueued = number(scheduled?.enqueuedAt);
  const published = new Map((attempt.presented ?? []).map((item) => [item.scheduledIndex, item]));
  const timeline: TimelineItem[] = [];
  const add = (entry: TimelineItem) => timeline.push(entry);
  const fromMs = number(boundary?.fromMs);
  const throughMs = number(boundary?.throughMs);
  if (fromMs !== null)
    add({
      key: 'from',
      kind: 'boundary',
      timestamp: fromMs,
      title: 'Observation window begins',
      description: `Sequence after ${boundary?.fromSequence ?? 'unknown'}`,
    });
  entries(input?.observations).forEach((item, index) =>
    add({
      key: `observation-${index}`,
      kind: 'observation',
      timestamp: number(item.observedAt),
      title: `Observation · ${string(item.source) || 'unknown source'}`,
      description: `${string(item.kind)} · ${string(item.description)}${Array.isArray(selection?.observations) && Number.isInteger(selection.observations[index]) ? ` · record #${selection.observations[index]}` : ''}`,
    }),
  );
  entries(input?.recentTranscripts).forEach((item, index) =>
    add({
      key: `transcript-${index}`,
      kind: 'transcript',
      timestamp: number(item.observedAt),
      title: `Transcript · ${string(item.source) || 'unknown source'}`,
      description: `${string(item.sourceId) ? `[${string(item.sourceId)}] ` : ''}${string(item.text)}`,
    }),
  );
  entries(input?.frames).forEach((item, index) =>
    add({
      key: `frame-${index}`,
      kind: 'frame',
      timestamp: number(item.observedAt),
      title: `Selected frame ${index + 1} · ${string(item.sourceId) || 'unknown source'}`,
      description: `Frame selection ${index + 1}${Array.isArray(selection?.frames) && typeof selection.frames[index] === 'string' ? ` · ID ${selection.frames[index]}` : ''}${number(item.mediaTimeMs) === null ? '' : ` · media ${item.mediaTimeMs} ms`}${item.imageOmitted ? ' · image omitted from trace' : ''}`,
    }),
  );
  entries(input?.recentEvents).forEach((item, index) =>
    add({
      key: `prior-event-${index}`,
      kind: 'event',
      timestamp: number(item.observedAt),
      title: `Prior Event · ${string(item.kind)}`,
      description: string(item.summary),
    }),
  );
  entries(input?.recentChat).forEach((item, index) =>
    add({
      key: `prior-chat-${index}`,
      kind: 'chat',
      timestamp: number(item.presentedAt),
      title: `Previously displayed · ${string(item.author)}`,
      description: string(item.text),
      state: 'shown',
    }),
  );
  if (throughMs !== null)
    add({
      key: 'through',
      kind: 'boundary',
      timestamp: throughMs,
      title: 'Observation window closes',
      description: `Selected through sequence ${boundary?.throughSequence ?? 'unknown'}${Array.isArray(selection?.transcripts) ? ` · transcript record IDs ${selection.transcripts.join(', ') || 'none'}` : ''}`,
    });
  if (scheduled) {
    entries(scheduled.events).forEach((item, index) =>
      add({
        key: `new-event-${index}`,
        kind: 'event',
        timestamp: enqueued,
        title: `Generated Event · ${string(item.kind)}`,
        description: `${string(item.summary)}${number(item.observedAt) === null ? '' : ` · observed ${item.observedAt} ms`}`,
      }),
    );
    add({
      key: 'batch',
      kind: 'batch',
      timestamp: enqueued,
      title: 'Chat batch accepted',
      description: `Playback window ${scheduled.windowMs ?? 'unknown'} ms`,
    });
    entries(scheduled.messages).forEach((item, index) => {
      const visible = published.get(index);
      const due =
        enqueued === null || number(item.offsetMs) === null
          ? null
          : enqueued + (item.offsetMs as number);
      add({
        key: `message-${index}`,
        kind: 'chat',
        timestamp: visible?.presentedAt ?? due,
        title: `${visible ? 'Displayed' : attempt.presentationClosed ? 'Not displayed' : 'Pending'} · ${string(item.author)}`,
        description: `${string(item.text)} · offset ${item.offsetMs ?? '?'} ms${visible ? ` · ${visible.id}` : ''}`,
        state: visible ? 'shown' : attempt.presentationClosed ? 'not-shown' : 'pending',
      });
    });
  }
  return timeline.sort(
    (left, right) =>
      (left.timestamp ?? Number.POSITIVE_INFINITY) - (right.timestamp ?? Number.POSITIVE_INFINITY),
  );
}
