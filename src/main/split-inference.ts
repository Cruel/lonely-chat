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
  return {
    vision: frozen({
      ...base,
      role: 'vision',
      instructions:
        stages.observer?.systemPrompt ??
        'You are a visual observation stage. Analyze the ordered timestamped frames in narrative context. Return JSON matching the schema. Put persistent scene information in sceneState (empty string if nothing is known) and discrete changes in events. Output no chat messages. Do not invent events from timestamps alone.',
      content: stages.observer?.userPrompt
        ? [{ type: 'text' as const, text: stages.observer.userPrompt }, ...base.content]
        : base.content,
      response: {
        ...base.response,
        schema: {
          ...base.response.schema,
          required: ['events', 'messages', 'sceneState'],
          properties: {
            ...base.response.schema.properties,
            messages: { ...base.response.schema.properties.messages, maxItems: 0 },
            sceneState: { type: 'string', maxLength: 2000 },
          },
        },
      },
    } as unknown as UnifiedInferenceRequest),
    chat: (events, observations) => {
      const textOnly = buildUnifiedInferenceRequest({
        ...input,
        frames: [],
        videoWindow: undefined,
        recentEvents: [...(input.recentEvents ?? []), ...events],
        observations: [...(input.observations ?? []), ...observations],
      });
      return frozen({
        ...textOnly,
        role: 'chat' as const,
        content: stages.chat?.userPrompt
          ? [{ type: 'text' as const, text: stages.chat.userPrompt }, ...textOnly.content]
          : textOnly.content,
        instructions:
          stages.chat?.systemPrompt ??
          'You are the audience chat stage. Use the supplied timestamped text observations and events to produce validated chat and optional text-derived events. No raw screenshots are available. ' +
            textOnly.instructions,
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
  private consumedSerial = 0;
  private mediaIdentity = '';

  reset(): void {
    this.cancelActive();
    this.visionCadence = null;
    this.chatCadence = null;
    this.latest.clear();
    this.visionTask = null;
    this.serial = 0;
    this.consumedSerial = 0;
    this.mediaIdentity = '';
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
    const requests = splitRequests(snapshot, stages);
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
                  (key) => !['events', 'messages', 'sceneState'].includes(key),
                )
              )
                throw new Error('Invalid Vision stage schema.');
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
          this.latest.publish(
            {
              events: output.accepted.events,
              observations,
              serial: ++this.serial,
            },
            now(),
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
      const events = selected?.serial !== this.consumedSerial ? (selected?.events ?? []) : [];
      const observations = selected?.observations ?? [];
      const chatRequest = requests.chat(events, observations);
      const adapter: UnifiedInferenceAdapter = {
        ...adapters.chat,
        complete: (_request, activeSignal, observer) =>
          adapters.chat.complete(chatRequest, activeSignal, observer),
      };
      const output = await this.chatCoordinator.execute(
        {
          ...snapshot,
          frames: [],
          videoWindow: undefined,
          recentEvents: [...(snapshot.recentEvents ?? []), ...events],
          observations: [...(snapshot.observations ?? []), ...observations],
        },
        adapter,
        { signal, beforeAccept },
      );
      if (signal.aborted || generation !== this.generation) return null;
      if (selected) this.consumedSerial = selected.serial;
      return {
        visionEvents: events,
        observations,
        parsed: output.parsed,
        accepted: {
          events: [...events, ...output.accepted.events],
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
        if (Object.keys(payload).some((key) => !['sceneState', 'events', 'messages'].includes(key)))
          throw new Error('Vision stage returned unexpected fields.');
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
