import { randomUUID } from 'node:crypto';
import type {
  InferenceProfile,
  ProfileModelReference,
  InferenceRole,
} from '../shared/inference-profile-contract';
import type {
  ProfileExperimentRequest,
  ProfileExperimentPreview,
  ProfileExperimentResult,
  ProfileStageEvidence,
  VisionExperimentReference,
} from '../shared/profile-playground-contract';
import type {
  InferredEvent,
  CapturedObservation,
  SessionPreferences,
} from '../shared/session-contract';
import { DEFAULT_PREFERENCES } from '../shared/session-contract';
import type { InferenceInput } from './fake-inference';
import type { VideoFrame } from '../shared/video-contract';
import type { UnifiedInferenceAdapter } from './inference-coordinator';
import { InferenceCoordinator } from './inference-coordinator';
import { ScheduledSplitInference, splitRequests, type SplitScheduling } from './split-inference';
import { selectStageFrames } from './stage-frame-selection';
import {
  buildSimulationExperimentInput,
  validateSimulationExperiment,
} from './simulation-experiment';
import { buildUnifiedInferenceRequest } from './unified-inference-request';
import { resolveUnifiedStageRequest } from './stage-context';
import { privateStageMetadata } from './stage-trace-evidence';
import type { TraceAttempt } from '../shared/inference-trace-contract';
import type { StageTraceFactory } from './stage-trace-evidence';

export interface PrivateVisionOutput {
  readonly sceneState: string;
  readonly events: readonly InferredEvent[];
  readonly observedAt: number;
  readonly reference: VisionExperimentReference;
}

export type ProfileAdapterFactory = (
  ref: ProfileModelReference,
  role: InferenceRole,
  input: InferenceInput,
  signal: AbortSignal,
) => Promise<{ adapter: UnifiedInferenceAdapter; stop: () => Promise<void> }>;

interface Prepared {
  readonly input: InferenceInput;
  readonly request: ProfileExperimentRequest;
  readonly profile: InferenceProfile;
  readonly saved: PrivateVisionOutput | null;
}

function requireRole(profile: InferenceProfile, role: InferenceRole): ProfileModelReference {
  const ref =
    profile.values.roles[role] ?? (role === 'memory' ? profile.values.roles.chat : undefined);
  if (!ref) throw new Error(`Inference Profile has no ${role} role.`);
  return ref;
}

function prepare(
  value: unknown,
  profile: InferenceProfile,
  saved: PrivateVisionOutput | null,
  preferences: Pick<SessionPreferences, 'historyMaxAgeMs' | 'historyMaxCount'>,
  archivedInput?: InferenceInput,
): Prepared {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid stage experiment.');
  const raw = value as Record<string, unknown>;
  if (
    Object.keys(raw).some(
      (key) =>
        !['profileId', 'profileRevision', 'mode', 'experiment', 'visionReferenceId'].includes(key),
    ) ||
    raw.profileId !== profile.id ||
    (raw.profileRevision !== undefined && raw.profileRevision !== profile.revision) ||
    !['vision', 'chat', 'pipeline'].includes(raw.mode as string)
  )
    throw new Error('Invalid stage experiment profile, revision or mode.');
  if (
    raw.visionReferenceId !== undefined &&
    (typeof raw.visionReferenceId !== 'string' || !/^[0-9a-f-]{36}$/i.test(raw.visionReferenceId))
  )
    throw new Error('Invalid saved Vision reference.');
  const request = validateSimulationExperiment(raw.experiment);
  if (request.video || request.videoMode === 'native-video' || request.rawRequestJson !== undefined)
    throw new Error('Profile experiments require sampled frames and production stage requests.');
  if (profile.values.topology === 'unified' && raw.mode !== 'pipeline')
    throw new Error('Unified profiles support full-pipeline experiments only.');
  if (raw.mode === 'vision' && raw.visionReferenceId)
    throw new Error('Vision-only experiments cannot consume saved Vision output.');
  if (
    raw.mode === 'chat' &&
    !raw.visionReferenceId &&
    !request.values.observations.some((item) => item.kind === 'visual')
  )
    throw new Error(
      'Provide a visual observation or select a saved Vision result for Chat-only experiments.',
    );
  if (raw.visionReferenceId && !saved)
    throw new Error('Saved Vision output is missing or no longer available.');
  if (raw.mode !== 'chat' && raw.visionReferenceId)
    throw new Error('Saved Vision output is supported for Chat-only experiments.');
  const now = Date.now();
  // Only the main process can supply a verified archived input. Its original
  // observation and Event clocks must not be rebased to today's wall clock.
  const input =
    archivedInput ??
    buildSimulationExperimentInput(request.values, now, preferences, request.frames, request.seed);
  const hybridMax =
    profile.values.topology === 'hybrid' ? (profile.values.architecture?.hybridMaxImages ?? 0) : 0;
  if (
    hybridMax > 0 &&
    profile.values.roles.chat?.kind === 'remote' &&
    (!archivedInput || raw.mode !== 'chat' || (input.frames?.length ?? 0) > 0) &&
    profile.values.architecture?.remoteChatImagesConsent !== true
  )
    throw new Error('Remote Chat image transmission requires explicit Hybrid consent.');
  return {
    request: {
      profileId: profile.id,
      profileRevision: profile.revision,
      mode: raw.mode as ProfileExperimentRequest['mode'],
      experiment: request,
      ...(raw.visionReferenceId ? { visionReferenceId: raw.visionReferenceId as string } : {}),
    },
    profile,
    saved,
    input: {
      ...input,
      chatFrames:
        hybridMax > 0
          ? selectStageFrames(
              input.frames ?? [],
              input.boundary?.throughMs ?? now,
              profile.values.stageDefaults.chat?.frameSampling,
              hybridMax,
            )
          : [],
    },
  };
}

function seededContext(prepared: Prepared): {
  events: readonly InferredEvent[];
  observations: readonly CapturedObservation[];
} {
  const { input, saved } = prepared;
  if (!saved) return { events: [], observations: [] };
  const observedAt = input.frames?.at(-1)?.observedAt ?? input.boundary?.throughMs ?? Date.now();
  return {
    events: saved.events.map((event) => ({
      ...event,
      observedAt: observedAt - Math.max(0, saved.observedAt - event.observedAt),
    })),
    observations: saved.sceneState.trim()
      ? [{ source: 'vision', kind: 'visual', description: saved.sceneState, observedAt }]
      : [],
  };
}

function safe(value: unknown): unknown {
  return privateStageMetadata(value);
}

export function previewProfileExperiment(
  value: unknown,
  profile: InferenceProfile,
  saved: PrivateVisionOutput | null,
  preferences: Pick<
    SessionPreferences,
    'historyMaxAgeMs' | 'historyMaxCount'
  > = DEFAULT_PREFERENCES,
  frameResizer?: (frame: VideoFrame, maxWidth: number, maxHeight: number) => VideoFrame,
): ProfileExperimentPreview {
  const prepared = prepare(value, profile, saved, preferences);
  const { input, request } = prepared;
  if (profile.values.topology === 'unified') {
    return {
      profileId: profile.id,
      profileRevision: profile.revision,
      mode: request.mode,
      sourceVisionReference: null,
      stages: [
        {
          role: 'unified',
          model: requireRole(profile, 'unified'),
          modelSettings: profile.values.stageDefaults.unified?.settings ?? {},
          request: safe(
            resolveUnifiedStageRequest(
              buildUnifiedInferenceRequest(input),
              input,
              profile.values.stageDefaults.unified,
            ),
          ),
        },
      ],
    };
  }
  const stageDefaults = profile.values.stageDefaults;
  const observerFrames = selectStageFrames(
    input.frames ?? [],
    input.boundary?.throughMs ?? Date.now(),
    stageDefaults.observer?.frameSampling,
    32,
  );
  const resize = (frames: readonly VideoFrame[], stage: typeof stageDefaults.observer) =>
    frameResizer && stage?.frameSampling
      ? frames.map((frame) =>
          frameResizer(frame, stage.frameSampling!.maxWidth, stage.frameSampling!.maxHeight),
        )
      : frames;
  const built = splitRequests(
    {
      ...input,
      frames: resize(observerFrames, stageDefaults.observer),
      chatFrames: resize(input.chatFrames ?? [], stageDefaults.chat),
    },
    stageDefaults,
  );
  const injected = seededContext(prepared);
  return {
    profileId: profile.id,
    profileRevision: profile.revision,
    mode: request.mode,
    sourceVisionReference: request.visionReferenceId ?? null,
    stages: [
      ...(request.mode === 'vision' || request.mode === 'pipeline'
        ? [
            {
              role: 'observer' as const,
              model: requireRole(profile, 'observer'),
              modelSettings: profile.values.stageDefaults.observer?.settings ?? {},
              request: safe(built.vision),
            },
          ]
        : []),
      ...(request.mode === 'chat' || request.mode === 'pipeline'
        ? [
            {
              role: 'chat' as const,
              model: requireRole(profile, 'chat'),
              modelSettings: profile.values.stageDefaults.chat?.settings ?? {},
              request: safe(built.chat(injected.events, injected.observations)),
            },
          ]
        : []),
    ],
  };
}

export async function executeProfileExperiment(
  value: unknown,
  profile: InferenceProfile,
  saved: PrivateVisionOutput | null,
  factory: ProfileAdapterFactory,
  signal: AbortSignal,
  preferences: Pick<
    SessionPreferences,
    'historyMaxAgeMs' | 'historyMaxCount'
  > = DEFAULT_PREFERENCES,
  frameResizer?: (frame: VideoFrame, maxWidth: number, maxHeight: number) => VideoFrame,
  archivedInput?: InferenceInput,
): Promise<{ result: ProfileExperimentResult; vision: PrivateVisionOutput | null }> {
  const prepared = prepare(value, profile, saved, preferences, archivedInput);
  const { input, request } = prepared;
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const stages: ProfileStageEvidence[] = [];
  const resources: { stop: () => Promise<void> }[] = [];
  let result: ProfileExperimentResult['accepted'] = null;
  let observations: ProfileExperimentResult['observations'] = [];
  let vision: PrivateVisionOutput | null = null;
  let error: string | null = null;
  let scheduled: ScheduledSplitInference | null = null;
  const entries = new Map<InferenceRole, ProfileStageEvidence>();
  const record = (role: InferenceRole, ref: ProfileModelReference, submittedRequest: unknown) => {
    const entry: ProfileStageEvidence = {
      role,
      model: ref,
      constructedRequest: safe(submittedRequest),
      submittedRequest: safe(submittedRequest),
      rawResponse: null,
      normalized: null,
      parsed: null,
      accepted: null,
      usage: null,
      error: null,
      status: 'running',
    };
    stages.push(entry);
    entries.set(role, entry);
    return entry;
  };
  const update = (role: InferenceRole, patch: Partial<ProfileStageEvidence>) => {
    const entry = entries.get(role);
    if (!entry) return;
    const next = { ...entry, ...patch };
    entries.set(role, next);
    stages[stages.indexOf(entry)] = next;
  };
  const capture: StageTraceFactory = (role, _source, submitted, _observed, _dependsOn) => {
    const stageRole = role === 'vision' ? 'observer' : role;
    const ref = requireRole(profile, stageRole);
    record(stageRole, ref, submitted);
    return {
      id: randomUUID(),
      observe: (stage, value) => {
        if (stage === 'request') update(stageRole, { submittedRequest: safe(value) });
        if (stage === 'response') update(stageRole, { rawResponse: safe(value) });
        if (stage === 'normalized') update(stageRole, { normalized: safe(value) });
      },
      update: (patch: Partial<TraceAttempt>) => {
        update(stageRole, {
          ...(patch.rawResponse === undefined ? {} : { rawResponse: safe(patch.rawResponse) }),
          ...(patch.normalized === undefined ? {} : { normalized: safe(patch.normalized) }),
          ...(patch.parsed === undefined ? {} : { parsed: safe(patch.parsed) }),
          ...(patch.accepted === undefined ? {} : { accepted: safe(patch.accepted) }),
          ...(patch.usage === undefined ? {} : { usage: patch.usage ?? null }),
          ...(patch.error === undefined ? {} : { error: String(patch.error) }),
          ...(patch.stage === 'accepted' ? { status: 'accepted' } : {}),
          ...(patch.stage === 'failed' ? { status: 'failed' } : {}),
          ...(patch.stage === 'cancelled' ? { status: 'cancelled' } : {}),
        });
        if (role === 'vision' && patch.stage === 'accepted') {
          const accepted = patch.accepted as { events?: readonly InferredEvent[] } | undefined;
          const sceneState = typeof patch.sceneState === 'string' ? patch.sceneState : '';
          const ref: VisionExperimentReference = {
            id: randomUUID(),
            label: `${profile.name} r${profile.revision} · ${new Date().toLocaleTimeString()}`,
            profileId: profile.id,
            profileRevision: profile.revision,
          };
          vision = {
            sceneState,
            events: structuredClone(accepted?.events ?? []),
            observedAt: input.frames?.at(-1)?.observedAt ?? input.boundary?.throughMs ?? Date.now(),
            reference: ref,
          };
        }
      },
    };
  };
  try {
    if (signal.aborted) throw new DOMException('Experiment cancelled.', 'AbortError');
    const make = async (role: InferenceRole) => {
      const ref = requireRole(profile, role);
      const owned = await factory(ref, role, input, signal);
      resources.push(owned);
      return owned.adapter;
    };
    if (profile.values.topology === 'unified') {
      const adapter = await make('unified');
      const coordinator = new InferenceCoordinator();
      const constructed = resolveUnifiedStageRequest(
        buildUnifiedInferenceRequest(input),
        input,
        profile.values.stageDefaults.unified,
      );
      record('unified', requireRole(profile, 'unified'), constructed);
      const effectiveAdapter: UnifiedInferenceAdapter = {
        ...adapter,
        complete: (original, activeSignal, observer) =>
          adapter.complete(
            resolveUnifiedStageRequest(original, input, profile.values.stageDefaults.unified),
            activeSignal,
            observer,
          ),
      };
      const output = await coordinator.execute(input, effectiveAdapter, {
        signal,
        playbackWindowMs: request.experiment.values.playbackWindowMs,
        onTransport: (raw, normalized) =>
          update('unified', { rawResponse: safe(raw), normalized: safe(normalized) }),
        observe: (stage, value) => {
          if (stage === 'request') update('unified', { submittedRequest: safe(value) });
          if (stage === 'response') update('unified', { rawResponse: safe(value) });
          if (stage === 'normalized') update('unified', { normalized: safe(value) });
        },
        onParsed: (parsed) => update('unified', { parsed: safe(parsed) }),
      });
      update('unified', {
        accepted: safe(output.accepted),
        usage: output.usage,
        status: 'accepted',
      });
      result = output.accepted;
    } else {
      const stage = new ScheduledSplitInference();
      if (frameResizer) stage.configureFrameResizer(frameResizer);
      scheduled = stage;
      const policy: SplitScheduling = {
        execution: profile.values.architecture?.execution ?? 'sequential',
        visionIntervalMs: profile.values.architecture?.visionIntervalMs ?? 0,
        chatIntervalMs: profile.values.architecture?.chatIntervalMs ?? 0,
        maximumWaitMs: profile.values.architecture?.maximumWaitMs ?? 10000,
        maximumAgeMs: profile.values.architecture?.maximumAgeMs ?? 30000,
        strictWait: profile.values.architecture?.strictWait ?? true,
      };
      stage.configureHybrid(
        profile.values.topology === 'hybrid'
          ? (profile.values.architecture?.hybridMaxImages ?? 0)
          : 0,
      );
      // Memory is an optional independent stage; it must be allowed to finish
      // before disposing the experiment's owned adapters.
      stage.configureMemory(
        request.mode === 'chat'
          ? { enabled: false, intervalMs: 30000, maxCharacters: 2000, expireAfterMs: 0 }
          : (profile.values.memory ?? {
              enabled: false,
              intervalMs: 30000,
              maxCharacters: 2000,
              expireAfterMs: 0,
            }),
      );
      const roleAdapters = {
        vision:
          request.mode === 'chat'
            ? {
                capabilities: { images: false },
                complete: async () => {
                  throw new Error('Vision is not admitted for Chat-only experiments.');
                },
              }
            : await make('observer'),
        chat:
          request.mode === 'vision'
            ? {
                capabilities: { images: false },
                complete: async () => {
                  throw new Error('Chat is not admitted for Vision-only experiments.');
                },
              }
            : await make('chat'),
        ...(request.mode !== 'chat' && profile.values.memory?.enabled
          ? { memory: await make('memory') }
          : {}),
      };
      const injected = seededContext(prepared);
      if (request.mode === 'chat' && saved)
        stage.seedVisionForExperiment(input, saved.sceneState, injected.events, Date.now());
      const execute = (work: 'both' | 'vision' | 'chat') =>
        stage.execute(
          input,
          roleAdapters,
          signal,
          undefined,
          profile.values.stageDefaults,
          request.mode === 'chat' ? { ...policy, strictWait: false } : policy,
          () => Date.now(),
          work,
          capture,
        );
      // Continuous Runs can admit Chat before Vision completes according to
      // cadence/age policy. A one-shot comparison exercises each stage exactly
      // once and hands the completed Vision output to Chat.
      const splitFirst = request.mode === 'pipeline';
      let output = await execute(
        request.mode === 'vision' || splitFirst
          ? 'vision'
          : request.mode === 'chat'
            ? 'chat'
            : 'both',
      );
      await stage.waitForVision();
      if (signal.aborted) throw new DOMException('Experiment cancelled.', 'AbortError');
      if (splitFirst) output = await execute('chat');
      await stage.waitForMemory();
      result = output?.accepted ?? null;
      observations = output?.observations ?? [];
    }
  } catch (reason) {
    error = reason instanceof Error ? reason.message : 'Experiment failed.';
    scheduled?.cancelActive();
    for (const entry of stages.filter((item) => item.status === 'running'))
      update(entry.role, { status: signal.aborted ? 'cancelled' : 'failed', error });
  } finally {
    for (const resource of resources.reverse()) {
      try {
        await resource.stop();
      } catch {
        /* Preserve inference error. */
      }
    }
  }
  if (!error) {
    const failed = stages.find((item) => item.status === 'failed' || item.status === 'cancelled');
    if (failed) error = failed.error ?? `${failed.role} inference ${failed.status}.`;
  }
  if (signal.aborted) {
    error = 'Experiment cancelled.';
    vision = null;
    result = null;
  }
  return {
    result: {
      id: randomUUID(),
      profileId: profile.id,
      profileRevision: profile.revision,
      mode: request.mode,
      startedAt,
      durationMs: Math.round(performance.now() - started),
      stages,
      accepted: result,
      observations,
      visionReference: (vision as PrivateVisionOutput | null)?.reference ?? null,
      sourceVisionReference: request.visionReferenceId ?? null,
      error,
    },
    vision,
  };
}
