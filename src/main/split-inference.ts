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
import type { VideoFrame } from '../shared/video-contract';
import { SplitNarrative } from './split-narrative';
import { NarrativeMemory, type NarrativeMemoryPolicy } from './narrative-memory';
import { selectStageFrames } from './stage-frame-selection';
import { validateVisionStageResult } from './vision-output';
import { DEFAULT_CHAT_PROMPT, DEFAULT_VISION_PROMPT, resolveStageContext, resolveStageTemplate } from './stage-context';
import type { InferenceProfileValues } from '../shared/inference-profile-contract';

const hasRetainedMemory = (value: unknown): boolean =>
  Boolean(value && typeof value === 'object' && 'memory' in value && value.memory);

/** Sequential stage execution shares one immutable media snapshot and one abort authority. */
export interface SplitAdapters {
  readonly vision: UnifiedInferenceAdapter;
  readonly chat: UnifiedInferenceAdapter;
  readonly memory?: UnifiedInferenceAdapter;
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
      ...((visionContext.data.significantEvents as unknown[]).length > 0 || (visionContext.data.interpretations as unknown[]).length > 0 || hasRetainedMemory(visionContext.data.narrative)
        ? { content: [
            ...(stages.observer?.userPrompt
              ? [{ type: 'text' as const, text: resolveStageTemplate(stages.observer.userPrompt, visionContext.data) }]
              : []),
            { type: 'text' as const, text: JSON.stringify({
              retainedNarrative: visionContext.data.narrative,
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
        frames: input.chatFrames ?? [],
        videoWindow: input.chatFrames?.length ? input.videoWindow : undefined,
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
        ...((selectedContext.data.significantEvents as unknown[]).length > 0 || (selectedContext.data.interpretations as unknown[]).length > 0 || hasRetainedMemory(selectedContext.data.narrative)
          ? { content: [
              ...(stages.chat?.userPrompt
                ? [{ type: 'text' as const, text: resolveStageTemplate(stages.chat.userPrompt, selectedContext.data) }]
                : []),
              { type: 'text' as const, text: JSON.stringify({
                retainedNarrative: selectedContext.data.narrative,
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
  private visionRevision = 0;
  private chatVisionRevision = 0;
  private generation = 0;
  private serial = 0;
  private mediaIdentity = '';
  private readonly narrative = new SplitNarrative();
  private readonly memory = new NarrativeMemory();
  private hybridMaxImages = 0;
  private frameResizer: ((frame: VideoFrame, maxWidth: number, maxHeight: number) => VideoFrame) | null = null;
  configureFrameResizer(resizer: (frame: VideoFrame, maxWidth: number, maxHeight: number) => VideoFrame): void {
    this.frameResizer = resizer;
  }
  private resizeFrames(frames: VideoFrame[], policy: InferenceProfileValues['stageDefaults']['observer']): VideoFrame[] {
    const size = policy?.frameSampling;
    return this.frameResizer && size ? frames.map((frame) => this.frameResizer!(frame, size.maxWidth, size.maxHeight)) : frames;
  }
  configureHybrid(maxImages: number): void { this.hybridMaxImages = maxImages; }
  private memoryPolicy: NarrativeMemoryPolicy = { enabled: false, intervalMs: 30000, maxCharacters: 2000, expireAfterMs: 0 };

  configureMemory(policy: NarrativeMemoryPolicy): void {
    this.memoryPolicy = policy;
  }
  private retryPayload: {
    events: readonly ReturnType<SplitNarrative['pending']>[number][];
    observations: readonly CapturedObservation[];
    request: UnifiedInferenceRequest;
    input: InferenceInput;
    /** Vision revision represented by this immutable Chat request, not later Vision arrivals. */
    visionRevision: number;
  } | null = null;

  reset(): void {
    this.cancelActive();
    this.visionCadence = null;
    this.chatCadence = null;
    this.latest.clear();
    this.visionTask = null;
    this.visionRevision = 0;
    this.chatVisionRevision = 0;
    this.serial = 0;
    this.mediaIdentity = '';
    this.narrative.reset();
    this.memory.reset();
    this.retryPayload = null;
  }

  suspendMemory(): void { this.memory.suspend(); }
  resumeMemory(): void { this.memory.resume(); }

  get visionInFlight(): boolean { return this.visionTask !== null; }

  canAdmitVision(now: number): boolean {
    return (this.visionCadence?.nextDelay(now) ?? 0) === 0;
  }

  waitForVision(): Promise<void> { return this.visionTask ?? Promise.resolve(); }

  hasUnconsumedVision(): boolean { return this.visionRevision > this.chatVisionRevision; }

  nextChatDelay(now: number): number {
    return this.chatCadence?.nextDelay(now) ?? 0;
  }

  cancelActive(): void {
    this.generation++;
    this.visionCoordinator.cancelActive();
    this.chatCoordinator.cancelActive();
    this.memory.reset();
  }

  async execute(
    input: InferenceInput,
    adapters: SplitAdapters,
    signal: AbortSignal,
    beforeAccept: (() => Promise<void>) | undefined,
    stages: InferenceProfileValues['stageDefaults'],
    policy: SplitScheduling,
    now: () => number = () => performance.now(),
    work: 'both' | 'vision' | 'chat' = 'both',
  ): Promise<SplitResult | null> {
    this.visionCadence ??= new StageCadence(policy.visionIntervalMs);
    this.chatCadence ??= new StageCadence(policy.chatIntervalMs);
    this.visionCadence.configure(policy.visionIntervalMs);
    this.chatCadence.configure(policy.chatIntervalMs);
    const generation = this.generation;
    const sourceFrames = input.frames ?? [];
    const chatSourceFrames = input.chatFrames ?? sourceFrames;
    const boundaryNow = Math.max(input.boundary?.throughMs ?? 0, sourceFrames.at(-1)?.observedAt ?? 0);
    const visionFrames = this.resizeFrames(selectStageFrames(sourceFrames, boundaryNow, stages.observer?.frameSampling, 32), stages.observer);
    const chatFrames = this.resizeFrames(selectStageFrames(chatSourceFrames, boundaryNow, stages.chat?.frameSampling, this.hybridMaxImages), stages.chat);
    if (chatFrames.length && !adapters.chat.capabilities.images)
      throw new Error('Selected Chat model does not accept Hybrid image frames.');
    const snapshot = frozen({
      ...input,
      chatFrames,
      frames: visionFrames
        ?.slice()
        .sort((a, b) => a.observedAt - b.observedAt || a.sourceId.localeCompare(b.sourceId)),
    });
    const mediaIdentity = [...new Set(snapshot.frames?.map((frame) => frame.sourceId) ?? [])]
      .sort()
      .join(',');
    if (mediaIdentity) this.mediaIdentity = mediaIdentity;
    const identity = `${generation}:${this.mediaIdentity}`;
    const priorScene = this.narrative.sceneObservation(now(), policy.maximumAgeMs);
    const memory = this.memory.snapshot(now(), this.memoryPolicy);
    const visionInput = frozen({
      ...snapshot,
      narrativeMemory: memory ?? undefined,
      observations: [...(snapshot.observations ?? []), ...priorScene],
      priorInterpretations: this.narrative.priorInterpretations(now(), policy.maximumAgeMs),
    });
    const requests = splitRequests(visionInput, stages);
    let visionFailure: unknown = null;
    const observedAt = snapshot.frames?.at(-1)?.observedAt ?? snapshot.boundary?.throughMs ?? 0;
    if (work !== 'chat' && this.visionCadence.start(now())) {
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
              const output = validateVisionStageResult(result.normalized, stages.observer);
              sceneState = output.sceneState;
              return { ...result, normalized: { events: output.events, messages: [] } };
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
          if (sceneState.trim()) this.memory.observe(sceneState, observedAt);
          for (const event of output.accepted.events) this.memory.observe(event.summary, event.observedAt);
          this.narrative.observeVision(
            sceneState,
            output.accepted.events,
            observedAt,
            availableAt,
            snapshot.frames?.map((frame) => `${frame.sourceId}:${frame.observedAt}`) ?? [],
          );
          if (observations.length || output.accepted.events.length) this.visionRevision++;
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

    if (work === 'vision' || !this.chatCadence.start(now())) return null;
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
      const admittedVisionRevision = this.retryPayload?.visionRevision ?? this.visionRevision;
      if (policy.strictWait && !selected) {
        if (visionFailure) throw visionFailure;
        return null;
      }
      // An unsuccessful Chat attempt pins its exact Vision context until a successful
      // acknowledgement; newer Vision completions remain queued for the next Chat cycle.
      const pending = this.retryPayload?.events ?? this.narrative.pending(now(), policy.maximumAgeMs);
      const observations = this.retryPayload?.observations ?? this.narrative.sceneObservation(now(), policy.maximumAgeMs);
      const events = pending.map((entry) => entry.event);
      const chatRequest = this.retryPayload?.request ?? splitRequests({ ...visionInput, chatFrames }, stages).chat(events, observations);
      const chatInput = this.retryPayload?.input ?? frozen({
        ...snapshot,
        narrativeMemory: memory ?? undefined,
        frames: chatFrames,
        videoWindow: chatFrames.length ? snapshot.videoWindow : undefined,
        recentEvents: [...(snapshot.recentEvents ?? []), ...events],
        observations: [...(snapshot.observations ?? []), ...observations],
      });
      this.retryPayload ??= { events: pending, observations, request: chatRequest, input: chatInput, visionRevision: admittedVisionRevision };
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
      this.chatVisionRevision = Math.max(this.chatVisionRevision, admittedVisionRevision);
      this.retryPayload = null;
      for (const event of freshChat) this.memory.observe(event.event.summary, event.observedAt);
      if (!signal.aborted && generation === this.generation) {
        // Memory updates happen after time-critical Chat publication, never on its critical path.
        void this.memory.update(now(), this.memoryPolicy, adapters.memory ?? adapters.chat, signal);
      }
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
        const output = validateVisionStageResult(result.normalized, stages.observer);
        sceneState = output.sceneState;
        return { ...result, normalized: { events: output.events, messages: [] } };
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
