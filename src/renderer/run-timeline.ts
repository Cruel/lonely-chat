import type { TraceAttempt } from '../shared/inference-trace-contract';

export interface TimelineItem {
  readonly key: string;
  readonly attemptId?: string;
  readonly timestamp: number | null;
  /** Original physical time when the primary Inspector timestamp is pause-adjusted. */
  readonly physicalTimestamp?: number | null;
  readonly kind:
    | 'boundary'
    | 'observation'
    | 'frame'
    | 'transcript'
    | 'event'
    | 'batch'
    | 'chat'
    | 'stage'
    | 'scene';
  readonly title: string;
  readonly description: string;
  readonly state?: 'shown' | 'pending' | 'not-shown';
  readonly clockDomain?: 'observation' | 'physical' | 'pause-adjusted';
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
        physicalTimestamp: number(scheduled.enqueuedPhysicalAt),
        title: `Generated Event · ${string(item.kind)}`,
        description: `${string(item.summary)}${number(item.observedAt) === null ? '' : ` · observed ${item.observedAt} ms`}`,
      }),
    );
    add({
      key: 'batch',
      kind: 'batch',
      timestamp: enqueued,
      physicalTimestamp: number(scheduled.enqueuedPhysicalAt),
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
        timestamp: (visible ? (number(visible.timelineAt) ?? visible.presentedAt) : null) ?? due,
        physicalTimestamp: visible?.presentedAt,
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

/** Joined per-Run causal events. Physical availability is projected onto the Run axis
 * rather than confused with the source/media observation timestamp. */
export function runTimeline(attempts: readonly TraceAttempt[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const attempt of attempts) {
    const role = attempt.role ?? 'unified';
    const prefix = attempt.id;
    const frameRefs = attempt.sourceFrameIds?.join(', ') || 'none';
    const dependencies = attempt.dependsOn?.join(', ') || 'none';
    const domain =
      attempt.startedTimelineAt === undefined
        ? 'physical'
        : attempt.startedTimelineAt === attempt.startedAt
          ? 'physical'
          : 'pause-adjusted';
    items.push({
      key: `${prefix}-request`,
      attemptId: prefix,
      kind: 'stage',
      timestamp: attempt.startedTimelineAt ?? attempt.startedAt,
      physicalTimestamp: attempt.startedAt,
      clockDomain: domain,
      title: `${role === 'chat' ? 'Chat' : role === 'vision' ? 'Vision' : role === 'memory' ? 'Memory' : 'Unified'} request`,
      description: `Attempt ${prefix} · model ${attempt.modelId ?? 'fixture'} · profile r${attempt.profileRevision ?? '?'} · source frames ${frameRefs} · observation refs ${attempt.observationRefs?.join(', ') || 'none'} · dependencies ${dependencies}`,
    });
    if (role === 'vision') {
      const scene = typeof attempt.sceneState === 'string' ? attempt.sceneState.trim() : '';
      if (scene)
        items.push({
          key: `${prefix}-scene`,
          attemptId: prefix,
          kind: 'scene',
          timestamp: attempt.availableTimelineAt ?? attempt.availableAt ?? null,
          physicalTimestamp: attempt.availableAt,
          clockDomain: domain,
          title: 'Scene state updated',
          description: `${scene} · observed ${attempt.observedAt ?? '?'} · from ${prefix}`,
        });
      entries(record(attempt.accepted)?.events).forEach((event, index) =>
        items.push({
          key: `${prefix}-event-${index}`,
          attemptId: prefix,
          kind: 'event',
          timestamp: attempt.availableTimelineAt ?? attempt.availableAt ?? null,
          physicalTimestamp: attempt.availableAt,
          clockDomain: domain,
          title: `Vision Event · ${string(event.kind)}`,
          description: `${string(event.summary)} · observed ${event.observedAt ?? attempt.observedAt ?? '?'} · from ${prefix}`,
        }),
      );
    }
    if (attempt.availableAt != null || attempt.stage === 'cancelled' || attempt.stage === 'failed')
      items.push({
        key: `${prefix}-result`,
        attemptId: prefix,
        kind: 'stage',
        timestamp:
          attempt.availableTimelineAt ??
          attempt.availableAt ??
          attempt.startedTimelineAt ??
          attempt.startedAt,
        physicalTimestamp: attempt.availableAt,
        clockDomain: domain,
        title: `${role} ${attempt.stage === 'scheduled' ? 'accepted' : attempt.stage}`,
        description: `Attempt ${prefix}${attempt.errorStage ? ` · failed at ${attempt.errorStage}` : ''}${attempt.error ? ` · ${attempt.error}` : ''}${attempt.usage ? ` · ${attempt.usage.totalTokens ?? '?'} tokens` : ''}`,
      });
    if (role === 'chat' || role === 'unified') {
      const selected = attemptTimeline(attempt).filter(
        (entry) =>
          entry.kind === 'batch' ||
          (entry.kind === 'chat' && entry.key.startsWith('message-')) ||
          (entry.kind === 'event' && entry.key.startsWith('new-event-')),
      );
      for (const entry of selected)
        items.push({
          ...entry,
          key: `${prefix}-${entry.key}`,
          attemptId: prefix,
          clockDomain:
            record(attempt.scheduled)?.clockDomain === 'pause-adjusted'
              ? 'pause-adjusted'
              : 'physical',
        });
    }
  }
  // Stable sort retains the capture order for events sharing one availability timestamp.
  return items.sort(
    (a, b) => (a.timestamp ?? Number.POSITIVE_INFINITY) - (b.timestamp ?? Number.POSITIVE_INFINITY),
  );
}
