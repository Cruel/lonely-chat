import type { InferenceInput } from './fake-inference';
import { StageCadence, LatestStageResult } from './stage-cadence';
import type { UnifiedInferenceAdapter } from './inference-coordinator';
import { InferenceCoordinator } from './inference-coordinator';
import {
  buildUnifiedInferenceRequest,
  type UnifiedInferenceRequest,
} from './unified-inference-request';
import { acceptSimulationExecution } from './simulation-execution';
import type { InferredEvent, CapturedObservation } from '../shared/session-contract';
import { SplitNarrative } from './split-narrative';
import { DEFAULT_CHAT_PROMPT, DEFAULT_VISION_PROMPT, resolveStageContext, resolveStageTemplate } from './stage-context';
import type { InferenceProfileValues } from '../shared/inference-profile-contract';

/** Sequential stage execution shares one immutable media snapshot and one abort authority. */
export interface SplitAdapters {
  readonly vision: UnifiedInferenceAdapter;
  readonly chat: UnifiedInferenceAdapter;
}
export interface SplitResult {
  readonly visionEvents: readonly InferredEvent[];
  readonly observations: readonly CapturedObservation[];
  readonly accepted: ReturnType<typeof acceptSimulationExecution>['accepted'];
  readonly parsed: ReturnType<typeof acceptSimulationExecution>['parsed'];
}

/** Explicitly do not send raw images, even if Chat's provider supports them. */
function frozen<T>(value: T): T {
  const copy = structuredClone(value);
  const seal = (entry: unknown): void => {
    if (!entry || typeof entry !== 'object' || Object.isFrozen(entry)) return;
    for (const child of Object.values(entry)) seal(child);
    Object.freeze(entry);
  };
  seal(copy);
  return copy;
}

export function splitRequests(
  input: InferenceInput,
  stages: InferenceProfileValues['stageDefaults'] = {},
): {
  vision: UnifiedInferenceRequest;
  chat: (
    events: readonly InferredEvent[],
    observations: readonly CapturedObservation[],
  ) => UnifiedInferenceRequest;
} {
  const base = buildUnifiedInferenceRequest(input);
  const visionContext = resolveStageContext(input, stages.observer);
  const visionBase = buildUnifiedInferenceRequest({
    ...input, recentEvents: visionContext.data.events as InferenceInput['recentEvents'],
    recentTranscripts: visionContext.data.transcripts as InferenceInput['recentTranscripts'],
    recentChat: visionContext.data.chat as InferenceInput['recentChat'],
    observations: [...(visionContext.data.scene as NonNullable<InferenceInput['observations']>),
      ...(visionContext.data.observations as NonNullable<InferenceInput['observations']>)],
  });
  const visionOutput = stages.observer?.visionOutput ?? 'both';
  return {
    vision: frozen({
      ...visionBase,
      role: 'vision',
      sampling: { ...visionBase.sampling, maxTokens: stages.observer?.maxResponseTokens ?? visionBase.sampling.maxTokens },
      instructions:
        resolveStageTemplate(stages.observer?.systemPrompt ?? `${DEFAULT_VISION_PROMPT} Output selection: ${visionOutput}. Always return events, messages (empty) and sceneState (empty if disabled).`, visionContext.data),
      content: stages.observer?.userPrompt
        ? [{ type: 'text' as const, text: resolveStageTemplate(stages.observer.userPrompt, visionContext.data) }, ...visionBase.content]
        : visionBase.content,
      // Retained summaries and prior interpretations aren't part of the legacy
      // unified JSON context; supply them explicitly as uncertain context.
      ...((visionContext.data.significantEvents as unknown[]).length > 0 || (visionContext.data.interpretations as unknown[]).length > 0
        ? { content: [
            ...(stages.observer?.userPrompt
              ? [{ type: 'text' as const, text: resolveStageTemplate(stages.observer.userPrompt, visionContext.data) }]
              : []),
            { type: 'text' as const, text: JSON.stringify({
              significantHistoricalSummaries: visionContext.data.significantEvents,
              uncertainPriorInterpretations: visionContext.data.interpretations,
            }) },
            ...visionBase.content,
          ] } : {}),
      response: {
        ...base.response,
        schema: {
          ...base.response.schema,
          required: ['events', 'messages', 'sceneState'],
          properties: {
            ...base.response.schema.properties,
            messages: { ...base.response.schema.properties.messages, maxItems: 0 },
            sceneState: { type: 'string', maxLength: 2000 },
            ...(stages.observer?.visionOptionalFields?.includes('confidence')
              ? { confidence: { type: 'number', minimum: 0, maximum: 1 } } : {}),
            ...(stages.observer?.visionOptionalFields?.includes('notes')
              ? { notes: { type: 'string', maxLength: 1000 } } : {}),
          },
        },
      },
    } as unknown as UnifiedInferenceRequest),
    chat: (events, observations) => {
      const selectedContext = resolveStageContext({ ...input, recentEvents: [...(input.recentEvents ?? []), ...events], observations: [...(input.observations ?? []), ...observations] }, stages.chat);
      const textOnly = buildUnifiedInferenceRequest({
        ...input,
        frames: [],
        videoWindow: undefined,
        recentEvents: selectedContext.data.events as InferenceInput['recentEvents'],
        recentTranscripts: selectedContext.data.transcripts as InferenceInput['recentTranscripts'],
        recentChat: selectedContext.data.chat as InferenceInput['recentChat'],
        observations: [...(selectedContext.data.scene as NonNullable<InferenceInput['observations']>), ...(selectedContext.data.observations as NonNullable<InferenceInput['observations']>)],
      });
      return frozen({
        ...textOnly,
        role: 'chat' as const,
        sampling: { ...textOnly.sampling, maxTokens: stages.chat?.maxResponseTokens ?? textOnly.sampling.maxTokens },
        content: stages.chat?.userPrompt
          ? [{ type: 'text' as const, text: resolveStageTemplate(stages.chat.userPrompt, selectedContext.data) }, ...textOnly.content]
          : textOnly.content,
        ...((selectedContext.data.significantEvents as unknown[]).length > 0 || (selectedContext.data.interpretations as unknown[]).length > 0
          ? { content: [
              ...(stages.chat?.userPrompt
                ? [{ type: 'text' as const, text: resolveStageTemplate(stages.chat.userPrompt, selectedContext.data) }]
                : []),
              { type: 'text' as const, text: JSON.stringify({
                significantHistoricalSummaries: selectedContext.data.significantEvents,
                uncertainPriorInterpretations: selectedContext.data.interpretations,
              }) },
              ...textOnly.content,
            ] } : {}),
        instructions:
          resolveStageTemplate(stages.chat?.systemPrompt ?? `${DEFAULT_CHAT_PROMPT} ${textOnly.instructions}`, selectedContext.data),
      } as unknown as UnifiedInferenceRequest);
    },
  };
}

export interface SplitScheduling {
  readonly execution: 'sequential' | 'asynchronous';
  readonly visionIntervalMs: number;
  readonly chatIntervalMs: number;
  readonly maximumWaitMs: number;
  readonly maximumAgeMs: number;
  readonly strictWait: boolean;
}

/** Per-Run stage authority: Vision can outlive the Chat window, but never the Run. */
export class ScheduledSplitInference {
  private visionCadence: StageCadence | null = null;
  private chatCadence: StageCadence | null = null;
  private visionCoordinator = new InferenceCoordinator();
  private chatCoordinator = new InferenceCoordinator();
  private latest = new LatestStageResult<{
    events: readonly InferredEvent[];
    observations: readonly CapturedObservation[];
    serial: number;
  }>();
  private visionTask: Promise<void> | null = null;
  private generation = 0;
  private serial = 0;
  private mediaIdentity = '';
  private readonly narrative = new SplitNarrative();
  private retryPayload: {
    events: readonly ReturnType<SplitNarrative['pending']>[number][];
    observations: readonly CapturedObservation[];
    request: UnifiedInferenceRequest;
    input: InferenceInput;
  } | null = null;

  reset(): void {
    this.cancelActive();
    this.visionCadence = null;
    this.chatCadence = null;
    this.latest.clear();
    this.visionTask = null;
    this.serial = 0;
    this.mediaIdentity = '';
    this.narrative.reset();
    this.retryPayload = null;
  }

  nextChatDelay(now: number): number {
    return this.chatCadence?.nextDelay(now) ?? 0;
  }

  cancelActive(): void {
    this.generation++;
    this.visionCoordinator.cancelActive();
    this.chatCoordinator.cancelActive();
  }

  async execute(
    input: InferenceInput,
    adapters: SplitAdapters,
    signal: AbortSignal,
    beforeAccept: (() => Promise<void>) | undefined,
    stages: InferenceProfileValues['stageDefaults'],
    policy: SplitScheduling,
    now: () => number = () => performance.now(),
    visionOnly = false,
  ): Promise<SplitResult | null> {
    this.visionCadence ??= new StageCadence(policy.visionIntervalMs);
    this.chatCadence ??= new StageCadence(policy.chatIntervalMs);
    const generation = this.generation;
    const snapshot = frozen({
      ...input,
      frames: input.frames
        ?.slice()
        .sort((a, b) => a.observedAt - b.observedAt || a.sourceId.localeCompare(b.sourceId)),
    });
    const mediaIdentity = [...new Set(snapshot.frames?.map((frame) => frame.sourceId) ?? [])]
      .sort()
      .join(',');
    if (mediaIdentity) this.mediaIdentity = mediaIdentity;
    const identity = `${generation}:${this.mediaIdentity}`;
    const priorScene = this.narrative.sceneObservation(now(), policy.maximumAgeMs);
    const visionInput = frozen({
      ...snapshot,
      observations: [...(snapshot.observations ?? []), ...priorScene],
      priorInterpretations: this.narrative.priorInterpretations(now(), policy.maximumAgeMs),
    });
    const requests = splitRequests(visionInput, stages);
    let visionFailure: unknown = null;
    const observedAt = snapshot.frames?.at(-1)?.observedAt ?? snapshot.boundary?.throughMs ?? 0;
    if (this.visionCadence.start(now())) {
      const cadence = this.visionCadence;
      const task = (async () => {
        try {
          if (snapshot.frames?.length && !adapters.vision.capabilities.images)
            throw new Error('Selected Vision model cannot accept image frames.');
          let sceneState = '';
          const adapter: UnifiedInferenceAdapter = {
            ...adapters.vision,
            complete: async (_request, activeSignal, observer) => {
              const result = await adapters.vision.complete(
                requests.vision,
                activeSignal,
                observer,
              );
              const payload = result.normalized;
              if (!payload || typeof payload !== 'object' || Array.isArray(payload))
                throw new Error('Invalid Vision stage output.');
              const fields = payload as Record<string, unknown>;
              if (
                typeof fields.sceneState !== 'string' ||
                fields.sceneState.length > 2000 ||
                !Array.isArray(fields.messages) ||
                fields.messages.length !== 0 ||
                Object.keys(fields).some(
                  (key) => !['events', 'messages', 'sceneState', ...(stages.observer?.visionOptionalFields ?? [])].includes(key),
                )
              )
                throw new Error('Invalid Vision stage schema.');
              const choice = stages.observer?.visionOutput ?? 'both';
              if (choice === 'events' && fields.sceneState !== '')
                throw new Error('Vision output must omit scene state in Events-only mode.');
              if (choice === 'scene' && Array.isArray(fields.events) && fields.events.length)
                throw new Error('Vision output must omit Events in Scene-only mode.');
              if ((fields.confidence !== undefined && (typeof fields.confidence !== 'number' ||
                  fields.confidence < 0 || fields.confidence > 1)) ||
                  (fields.notes !== undefined && (typeof fields.notes !== 'string' ||
                  fields.notes.length > 1000)))
                throw new Error('Invalid optional Vision field.');
              sceneState = fields.sceneState;
              return { ...result, normalized: { events: fields.events, messages: [] } };
            },
          };
          const output = await this.visionCoordinator.execute(snapshot, adapter, {
            signal,
            enforceAudience: false,
            beforeAccept,
          });
          if (signal.aborted || generation !== this.generation) return;
          const observations: CapturedObservation[] = sceneState.trim()
            ? [{ source: 'vision', kind: 'visual', description: sceneState.trim(), observedAt }]
            : [];
          const availableAt = now();
          this.narrative.observeVision(
            sceneState,
            output.accepted.events,
            observedAt,
            availableAt,
            snapshot.frames?.map((frame) => `${frame.sourceId}:${frame.observedAt}`) ?? [],
          );
          this.latest.publish(
            { events: output.accepted.events, observations, serial: ++this.serial },
            availableAt,
            observedAt,
            identity,
          );
        } catch (error) {
          visionFailure = error;
          // A failed Vision attempt is not an accepted observation. Chat may
          // consume a still-eligible earlier result, according to policy.
        } finally {
          cadence.finish();
        }
      })();
      this.visionTask = task;
      void task.finally(() => {
        if (this.visionTask === task) this.visionTask = null;
      });
    }

    if (visionOnly || !this.chatCadence.start(now())) return null;
    try {
      if (policy.execution === 'sequential' && this.visionTask) {
        if (policy.strictWait) {
          await this.visionTask;
        } else if (policy.maximumWaitMs > 0) {
          await Promise.race([
            this.visionTask,
            new Promise<void>((resolve) => setTimeout(resolve, policy.maximumWaitMs)),
          ]);
        }
      }
      if (signal.aborted || generation !== this.generation) return null;
      const selected = this.latest.eligible(now(), policy.maximumAgeMs, identity);
      if (policy.strictWait && !selected) {
        if (visionFailure) throw visionFailure;
        return null;
      }
      // An unsuccessful Chat attempt pins its exact Vision context until a successful
      // acknowledgement; newer Vision completions remain queued for the next Chat cycle.
      const pending = this.retryPayload?.events ?? this.narrative.pending(now(), policy.maximumAgeMs);
      const observations = this.retryPayload?.observations ?? this.narrative.sceneObservation(now(), policy.maximumAgeMs);
      const events = pending.map((entry) => entry.event);
      const chatRequest = this.retryPayload?.request ?? requests.chat(events, observations);
      const chatInput = this.retryPayload?.input ?? frozen({
        ...snapshot,
        frames: [],
        videoWindow: undefined,
        recentEvents: [...(snapshot.recentEvents ?? []), ...events],
        observations: [...(snapshot.observations ?? []), ...observations],
      });
      this.retryPayload ??= { events: pending, observations, request: chatRequest, input: chatInput };
      const adapter: UnifiedInferenceAdapter = {
        ...adapters.chat,
        complete: (_request, activeSignal, observer) =>
          adapters.chat.complete(chatRequest, activeSignal, observer),
      };
      const output = await this.chatCoordinator.execute(
        chatInput,
        adapter,
        { signal, beforeAccept },
      );
      if (signal.aborted || generation !== this.generation) return null;
      const freshChat = this.narrative.merge(output.accepted.events, 'chat', now());
      this.narrative.acknowledge(pending);
      this.retryPayload = null;
      return {
        visionEvents: events,
        observations,
        parsed: output.parsed,
        accepted: {
          events: [...events, ...freshChat.map((entry) => entry.event)],
          messages: output.accepted.messages,
        },
      };
    } finally {
      this.chatCadence.finish();
    }
  }
}

export class SequentialSplitInference {
  private readonly coordinator = new InferenceCoordinator();
  cancelActive() {
    this.coordinator.cancelActive();
  }

  async execute(
    input: InferenceInput,
    adapters: SplitAdapters,
    signal: AbortSignal,
    beforeAccept?: () => Promise<void>,
    stages: InferenceProfileValues['stageDefaults'] = {},
  ): Promise<SplitResult> {
    const copied = structuredClone(input);
    const snapshot = frozen({
      ...copied,
      frames: copied.frames
        ?.slice()
        .sort((a, b) => a.observedAt - b.observedAt || a.sourceId.localeCompare(b.sourceId)),
    });
    const requests = splitRequests(snapshot, stages);
    const guard = () => {
      if (signal.aborted) throw new DOMException('Split inference cancelled.', 'AbortError');
    };
    guard();
    if (snapshot.frames?.length && !adapters.vision.capabilities.images)
      throw new Error('Selected Vision model cannot accept image frames.');
    // Use the production provider and normalization protocol for both stages.
    let sceneState = '';
    const visionAdapter: UnifiedInferenceAdapter = {
      ...adapters.vision,
      async complete(_request, activeSignal, observer) {
        const result = await adapters.vision.complete(requests.vision, activeSignal, observer);
        if (
          !result.normalized ||
          typeof result.normalized !== 'object' ||
          Array.isArray(result.normalized)
        )
          throw new Error('Vision stage returned an invalid structured result.');
        const payload = result.normalized as Record<string, unknown>;
        if (typeof payload.sceneState !== 'string' || payload.sceneState.length > 2000)
          throw new Error('Vision stage returned an invalid scene state.');
        if (!Array.isArray(payload.messages) || payload.messages.length !== 0)
          throw new Error('Vision stage must not generate chat messages.');
        if (Object.keys(payload).some((key) => !['sceneState', 'events', 'messages', ...(stages.observer?.visionOptionalFields ?? [])].includes(key)))
          throw new Error('Vision stage returned unexpected fields.');
        const choice = stages.observer?.visionOutput ?? 'both';
        if (choice === 'events' && payload.sceneState !== '')
          throw new Error('Vision output must omit scene state in Events-only mode.');
        if (choice === 'scene' && Array.isArray(payload.events) && payload.events.length)
          throw new Error('Vision output must omit Events in Scene-only mode.');
        if ((payload.confidence !== undefined && (typeof payload.confidence !== 'number' ||
            payload.confidence < 0 || payload.confidence > 1)) ||
            (payload.notes !== undefined && (typeof payload.notes !== 'string' ||
            payload.notes.length > 1000)))
          throw new Error('Invalid optional Vision field.');
        sceneState = payload.sceneState;
        return { ...result, normalized: { events: payload.events, messages: [] } };
      },
    };
    const vision = await this.coordinator.execute(snapshot, visionAdapter, {
      signal,
      enforceAudience: false,
      beforeAccept,
    });
    guard();
    if (vision.parsed.messages.length)
      throw new Error('Vision stage must not generate chat messages.');
    const events = vision.accepted.events;
    const observations: CapturedObservation[] = sceneState.trim()
      ? [
          {
            source: 'vision',
            kind: 'visual',
            description: sceneState.trim(),
            observedAt:
              snapshot.frames?.at(-1)?.observedAt ?? snapshot.boundary?.throughMs ?? Date.now(),
          },
        ]
      : [];
    const chatRequest = requests.chat(events, observations);
    if (chatRequest.content.some((part) => part.type === 'image'))
      throw new Error('Strict Split Chat cannot receive image frames.');
    const chatAdapter: UnifiedInferenceAdapter = {
      ...adapters.chat,
      complete: (_request, activeSignal, observer) =>
        adapters.chat.complete(chatRequest, activeSignal, observer),
    };
    const chat = await this.coordinator.execute(
      {
        ...snapshot,
        frames: [],
        videoWindow: undefined,
        recentEvents: [...(snapshot.recentEvents ?? []), ...events],
        observations: [...(snapshot.observations ?? []), ...observations],
      },
      chatAdapter,
      { signal, beforeAccept },
    );
    guard();
    return {
      visionEvents: events,
      observations,
      parsed: chat.parsed,
      accepted: { events: [...events, ...chat.accepted.events], messages: chat.accepted.messages },
    };
  }
}
