import type { RecordedRun } from '../shared/recorded-scenario-contract';
import type { InferenceProfile } from '../shared/inference-profile-contract';
import type {
  ProfileExperimentRequest,
  ProfileExperimentResult,
} from '../shared/profile-playground-contract';
import type { RunReplay, ReplayedStage, RunChatComparison } from '../shared/run-replay-contract';
import type { InferenceInput } from './fake-inference';
import type { CompactInferenceRecorder } from './compact-inference-recorder';

const MAX_REPLAY_STAGES = 256;
const REDACTED = /\[(?:content omitted|redacted credential|media omitted|depth limit)\]/i;

function hasOmittedText(value: unknown, depth = 0): boolean {
  if (depth > 32) return true;
  if (typeof value === 'string') return REDACTED.test(value);
  if (Array.isArray(value)) return value.some((part) => hasOmittedText(part, depth + 1));
  if (value && typeof value === 'object')
    return Object.values(value).some((part) => hasOmittedText(part, depth + 1));
  return false;
}

function replayableResult(stage: ReplayedStage): boolean {
  return (
    (stage.stage === 'accepted' || stage.stage === 'scheduled') &&
    stage.accepted !== null &&
    stage.accepted !== undefined &&
    !hasOmittedText(stage.accepted)
  );
}

/** Return an independently verified, historical timeline without changing any Session state. */
export async function replayRun(
  run: RecordedRun,
  recorder: CompactInferenceRecorder,
): Promise<RunReplay> {
  const recordingIds = new Set(run.recordingIds ?? []);
  if (recordingIds.size === 0)
    return {
      runId: run.id,
      status: run.status,
      stages: [],
      missingDependencies: [],
      warning:
        'No opt-in stage recording belongs to this Run. Full reinference requires its original media.',
    };
  const entries = (await recorder.list()).filter(
    (entry) => recordingIds.has(entry.recordingId) && entry.runId === run.sessionRunId,
  );
  if (entries.length > MAX_REPLAY_STAGES)
    throw new Error('This Run contains too many recorded stages to replay at once.');
  const stages: ReplayedStage[] = [];
  for (const entry of entries.sort(
    (a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id),
  )) {
    const recorded = await recorder.reconstruct(entry.id, entry.recordingId);
    if (!recorded) throw new Error('A Run stage disappeared during replay.');
    const details = recorded.outcome;
    const stage = (entry.interrupted ? 'interrupted' : entry.stage) as ReplayedStage['stage'];
    stages.push({
      id: entry.id,
      recordingId: entry.recordingId,
      role: entry.role ?? 'unified',
      cycle: entry.cycle,
      attempt: entry.attempt,
      stage,
      modelId: entry.modelId ?? null,
      profileRevision: entry.profileRevision ?? null,
      profileId: run.effectiveProfile?.id ?? null,
      consumedEvents: (recorded.input as InferenceInput | null)?.recentEvents ?? null,
      seed: entry.seed,
      observedAt: entry.observedAt ?? null,
      availableAt: entry.availableAt ?? null,
      startedAt: entry.startedAt,
      dependsOn: [...(entry.dependsOn ?? [])],
      sourceFrameIds: [...(entry.sourceFrameIds ?? [])],
      requestProvenance: recorded.provenance,
      accepted: details?.accepted ?? null,
      sceneState: details?.sceneState ?? null,
      scheduled: details?.scheduled ?? null,
      presented: details?.presented ?? [],
      presentationClosed: details?.presentationClosed === true,
      usage: details?.usage ?? null,
      error: details?.error ?? null,
      incomplete:
        entry.interrupted === true || details === undefined || hasOmittedText(details.accepted),
    });
  }
  const ids = new Set(stages.map((stage) => stage.id));
  const missingDependencies = [
    ...new Set(stages.flatMap((stage) => stage.dependsOn.filter((id) => !ids.has(id)))),
  ];
  return {
    runId: run.id,
    status: run.status,
    stages,
    missingDependencies,
    warning: missingDependencies.length
      ? 'Some stage dependencies were not retained in the recording. Inference-free replay is partial.'
      : stages.some((stage) => stage.incomplete)
        ? 'This recording contains interrupted or content-omitted attempts. Missing outputs are not replayed.'
        : null,
  };
}

/** A private Chat-only fork uses the exact captured context and historical clock,
 * never inferred current media. Images are deliberately removed even from Hybrid profiles. */
export async function prepareRecordedChatFork(
  run: RecordedRun,
  recorder: CompactInferenceRecorder,
  attemptId: string,
  profile: InferenceProfile,
): Promise<{ request: ProfileExperimentRequest; input: InferenceInput; original: ReplayedStage }> {
  if (profile.values.topology === 'unified' || !profile.values.roles.chat)
    throw new Error('Chat-only replay requires a Split or Hybrid profile with a Chat model.');
  const timeline = await replayRun(run, recorder);
  const stage = timeline.stages.find((item) => item.id === attemptId);
  if (!stage || stage.role !== 'chat' || stage.incomplete || !replayableResult(stage))
    throw new Error('Select a recorded, accepted Chat stage to compare.');
  if (
    !stage.dependsOn.some((id) => {
      const dependency = timeline.stages.find((item) => item.id === id);
      return (
        dependency?.role === 'vision' && !dependency.incomplete && replayableResult(dependency)
      );
    })
  )
    throw new Error(
      'Chat-only reinference requires the accepted Vision dependency to be retained.',
    );
  const recorded = await recorder.reconstruct(stage.id, stage.recordingId);
  if (!recorded || recorded.provenance === 'exact-not-constructed' || !recorded.input)
    throw new Error('Original Chat stage input is missing.');
  const original = recorded.input as InferenceInput;
  // Do not confuse media omitted by privacy settings with a usable text-only replay.
  const text = {
    context: original.context,
    roster: original.roster,
    recentEvents: original.recentEvents,
    observations: original.observations,
    recentTranscripts: original.recentTranscripts,
    recentChat: original.recentChat,
    narrativeMemory: original.narrativeMemory,
    priorInterpretations: original.priorInterpretations,
    significantEvents: original.significantEvents,
  };
  if (
    hasOmittedText(text) ||
    !original.context?.trim() ||
    !original.roster?.length ||
    !Number.isSafeInteger(original.cycle) ||
    !Number.isSafeInteger(original.seed)
  )
    throw new Error(
      'Recorded Chat context was not retained with text consent; cannot safely reinfer.',
    );
  const input: InferenceInput = structuredClone({
    ...original,
    frames: [],
    chatFrames: [],
    videoWindow: undefined,
  });
  const selectedModel = profile.values.roles.chat.modelId;
  // The ordinary validated Playground envelope is a control plane only. The archived
  // input above, not these synthetic ages, is handed to the production stage builder.
  const request: ProfileExperimentRequest = {
    profileId: profile.id,
    profileRevision: profile.revision,
    mode: 'chat',
    experiment: {
      modelId: selectedModel,
      seed: original.seed!,
      values: {
        context: original.context,
        cycle: original.cycle,
        playbackWindowMs: Math.min(60000, Math.max(500, original.playbackWindowMs ?? 3000)),
        chatActivity: original.chatActivity ?? 'normal',
        roster: original.roster!,
        events: [],
        transcripts: [],
        recentChat: [],
        observations: [
          {
            source: 'recorded-vision',
            kind: 'visual',
            description: 'Captured Vision dependency is in the frozen stage input.',
            ageMs: 0,
          },
        ],
      },
    },
  };
  return { request, input, original: stage };
}

export function requireRecordedTextConsent(profile: InferenceProfile, allowed: boolean): void {
  if (profile.values.roles.chat?.kind === 'remote' && allowed !== true)
    throw new Error(
      'Explicit consent is required to transmit recorded text context to a remote Chat provider.',
    );
}

export function compareRecordedChat(
  original: ReplayedStage,
  experiment: ProfileExperimentResult,
): RunChatComparison {
  const chat = experiment.stages.find((stage) => stage.role === 'chat');
  const model = chat?.model.modelId !== original.modelId;
  const profileRevision =
    experiment.profileRevision !== original.profileRevision ||
    experiment.profileId !== original.profileId;
  const output = JSON.stringify(chat?.accepted ?? null) !== JSON.stringify(original.accepted);
  const seed = false; // The Chat fork explicitly reuses the archived attempt seed.
  return {
    original,
    experiment,
    changes: {
      model,
      profileRevision,
      seed,
      output,
      possibleSamplingVariation: output && !model && !profileRevision && !seed,
    },
  };
}
