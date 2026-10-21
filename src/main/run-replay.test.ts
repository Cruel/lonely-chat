import { describe, expect, it, vi } from 'vitest';
import type { RecordedRun } from '../shared/recorded-scenario-contract';
import type { InferenceProfile } from '../shared/inference-profile-contract';
import type {
  CompactAttemptSummary,
  CompactReconstruction,
} from '../shared/compact-recording-contract';
import { DEFAULT_PREFERENCES } from '../shared/session-contract';
import { executeProfileExperiment, type ProfileAdapterFactory } from './profile-playground';
import {
  replayRun,
  prepareRecordedChatFork,
  requireRecordedTextConsent,
  compareRecordedChat,
} from './run-replay';
import type { CompactInferenceRecorder } from './compact-inference-recorder';

const profile: InferenceProfile = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Replay comparison',
  revision: 4,
  values: {
    topology: 'split',
    roles: {
      observer: { kind: 'local', modelId: 'vision-old' },
      chat: { kind: 'local', modelId: 'chat-new' },
    },
    stageDefaults: {},
  },
};

const run: RecordedRun = {
  id: '22222222-2222-4222-8222-222222222222',
  scenarioId: null,
  name: 'Archived',
  startedAt: new Date(1000).toISOString(),
  endedAt: new Date(8000).toISOString(),
  sessionRunId: 22,
  recordingIds: ['recording-example-1234567890123456'],
  status: 'completed',
  cycles: 2,
  error: null,
  effective: {
    context: 'Original',
    mode: 'native',
    video: null,
    audio: [],
    segment: { startMs: 0, endMs: 5000 },
    transcriptMode: 'transcribe',
    publishToOverlay: false,
    seed: 91,
    presetId: null,
    presetRevision: null,
    modelId: 'chat-old',
    settingsSnapshot: DEFAULT_PREFERENCES,
    settingsPolicy: 'saved',
  },
  effectiveSettings: DEFAULT_PREFERENCES,
  effectiveModelId: 'chat-old',
  effectiveProfile: { ...profile, revision: 3 },
  effectivePreset: null,
  effectivePrompt: { context: 'Original', chatActivity: 'normal' },
  effectiveSeed: 91,
};

const visionId = 'attempt-11111111-1111-4111-8111-111111111111';
const chatId = 'attempt-22222222-2222-4222-8222-222222222222';
const accepted = {
  events: [],
  messages: [{ author: 'viewer', color: '#123456', text: 'Amazing', offsetMs: 0 }],
};
const input = {
  context: 'Original',
  seed: 91,
  cycle: 2,
  playbackWindowMs: 3000,
  chatActivity: 'normal' as const,
  roster: [{ author: 'viewer', color: '#123456' }],
  observations: [
    { source: 'vision', kind: 'visual' as const, description: 'Original scene', observedAt: 1100 },
  ],
  recentEvents: [{ kind: 'reaction' as const, summary: 'Jump scare', observedAt: 1100 }],
  recentTranscripts: [{ sourceId: 'mic', source: 'mic', text: 'Whoa', observedAt: 1090 }],
  recentChat: [],
  narrativeMemory: { version: 2, text: 'Memorable race history', updatedAt: 1090 },
  priorInterpretations: [
    { text: 'Uncertain interpretation', observedAt: 1090, sourceModel: 'vision' as const },
  ],
  frames: [
    {
      sourceId: 'video',
      observedAt: 1100,
      width: 1,
      height: 1,
      dataUrl: 'data:image/jpeg;base64,/9j/',
    },
  ],
  chatFrames: [
    {
      sourceId: 'video',
      observedAt: 1100,
      width: 1,
      height: 1,
      dataUrl: 'data:image/jpeg;base64,/9j/',
    },
  ],
  boundary: { fromSequence: 1, throughSequence: 3, fromMs: 1000, throughMs: 1200 },
};

function entry(
  id: string,
  role: 'vision' | 'chat',
  extra: Partial<CompactAttemptSummary> = {},
): CompactAttemptSummary {
  return {
    id,
    recordingId: run.recordingIds![0],
    mode: 'exact',
    role,
    runId: run.sessionRunId,
    cycle: role === 'vision' ? 1 : 2,
    attempt: 1,
    seed: 91,
    modelId: role === 'vision' ? 'vision-old' : 'chat-old',
    startedAt: role === 'vision' ? 2000 : 4000,
    durationMs: 250,
    observedAt: role === 'vision' ? 1000 : 1200,
    availableAt: role === 'vision' ? 2250 : 4250,
    profileRevision: 3,
    dependsOn: role === 'chat' ? [visionId] : [],
    sourceFrameIds: ['video:1100:1000'],
    stage: 'accepted',
    chunk: '00000001.jsonl.gz',
    ...extra,
  };
}

function fixture(
  options: {
    stopped?: boolean;
    omitVision?: boolean;
    interrupted?: boolean;
    omitText?: boolean;
  } = {},
) {
  const vision = entry(visionId, 'vision', {
    stage: options.interrupted ? 'interrupted' : 'accepted',
    ...(options.interrupted ? { interrupted: true } : {}),
  });
  const chat = entry(chatId, 'chat', { stage: options.stopped ? 'scheduled' : 'accepted' });
  const reconstruct = vi.fn(async (id: string): Promise<CompactReconstruction | null> => {
    const selected = id === visionId ? vision : chat;
    const v = id === visionId;
    return {
      input: v ? { ...input, frames: [] } : { ...input },
      request: null,
      provenance: 'metadata-only',
      recordedBuilderVersion: 'v1',
      currentBuilderVersion: 'v1',
      warning: '',
      attempt: selected,
      ...(options.interrupted && v
        ? {}
        : {
            outcome: {
              stage: selected.stage === 'scheduled' ? 'scheduled' : 'accepted',
              accepted: v
                ? { events: [{ ...input.recentEvents[0] }], messages: [] }
                : options.omitText
                  ? '[content omitted]'
                  : accepted,
              sceneState: v ? 'Original scene' : null,
              scheduled: v ? null : accepted.messages,
              presented: v
                ? []
                : [
                    {
                      id: 'published',
                      author: 'viewer',
                      text: 'Amazing',
                      presentedAt: 4800,
                      scheduledIndex: 0,
                    },
                  ],
              presentationClosed: options.stopped ?? false,
              error: null,
              usage: null,
            },
          }),
    };
  });
  const list = vi.fn(async () => (options.omitVision ? [chat] : [vision, chat]));
  const recorder = { list, reconstruct } as unknown as CompactInferenceRecorder;
  return { recorder, list, reconstruct };
}

describe('recorded stage replay and comparisons', () => {
  it('replays original accepted results, timestamps, Event consumption and publication without model calls', async () => {
    const { recorder, reconstruct } = fixture();
    const timeline = await replayRun(run, recorder);
    expect(timeline.warning).toBeNull();
    expect(timeline.stages).toHaveLength(2);
    expect(timeline.stages[1]).toMatchObject({
      role: 'chat',
      profileId: profile.id,
      profileRevision: 3,
      observedAt: 1200,
      availableAt: 4250,
      dependsOn: [visionId],
      consumedEvents: input.recentEvents,
      accepted,
      presentationClosed: false,
    });
    expect(timeline.stages[1].presented?.[0].presentedAt).toBe(4800);
    expect(reconstruct).toHaveBeenCalledTimes(2);
  });

  it('retains accepted evidence from stopped or crashed recordings; marks incomplete attempts unavailable', async () => {
    const { recorder } = fixture({ stopped: true, interrupted: true });
    const timeline = await replayRun({ ...run, status: 'interrupted' }, recorder);
    expect(timeline.stages[0].incomplete).toBe(true);
    expect(timeline.stages[1]).toMatchObject({
      stage: 'scheduled',
      incomplete: false,
      presentationClosed: true,
      accepted,
    });
    expect(timeline.warning).toMatch(/interrupted/);
    const { recorder: missing } = fixture({ omitVision: true });
    expect((await replayRun(run, missing)).missingDependencies).toEqual([visionId]);
  });

  it('reruns only Chat with the archived temporal evidence, no image transfer and no Vision or memory request', async () => {
    const { recorder } = fixture();
    const fork = await prepareRecordedChatFork(run, recorder, chatId, profile);
    expect(fork.input).toMatchObject({
      seed: 91,
      cycle: 2,
      recentEvents: input.recentEvents,
      observations: input.observations,
      recentTranscripts: input.recentTranscripts,
      narrativeMemory: input.narrativeMemory,
      priorInterpretations: input.priorInterpretations,
      frames: [],
      chatFrames: [],
    });
    expect(input.frames).toHaveLength(1);
    const roles: string[] = [];
    const requests: unknown[] = [];
    const factory: ProfileAdapterFactory = async (_ref, role) => {
      roles.push(role);
      return {
        adapter: {
          capabilities: { images: true },
          complete: async (request) => {
            requests.push(request);
            return { raw: accepted, normalized: accepted };
          },
        },
        stop: async () => {},
      };
    };
    const experiment = await executeProfileExperiment(
      fork.request,
      profile,
      null,
      factory,
      new AbortController().signal,
      DEFAULT_PREFERENCES,
      undefined,
      fork.input,
    );
    expect(experiment.result.error).toBeNull();
    expect(roles).toEqual(['chat']);
    expect(experiment.result.accepted?.messages[0].text).toBe('Amazing');
    expect(JSON.stringify(requests)).toContain('Jump scare');
    expect(JSON.stringify(requests)).toContain('Memorable race history');
    expect(JSON.stringify(requests)).toContain('Uncertain interpretation');
    expect(JSON.stringify(requests)).not.toContain('data:image');
    const comparison = compareRecordedChat(fork.original, experiment.result);
    expect(comparison.changes).toMatchObject({
      model: true,
      profileRevision: true,
      seed: false,
      output: true,
      possibleSamplingVariation: false,
    });
  });

  it('rejects missing Vision dependencies, incomplete private context and unauthorized remote Chat', async () => {
    const missing = fixture({ omitVision: true });
    await expect(prepareRecordedChatFork(run, missing.recorder, chatId, profile)).rejects.toThrow(
      /Vision dependency/,
    );
    const omitted = fixture({ omitText: true });
    await expect(prepareRecordedChatFork(run, omitted.recorder, chatId, profile)).rejects.toThrow(
      /accepted Chat/,
    );
    const remote: InferenceProfile = {
      ...profile,
      values: {
        ...profile.values,
        roles: { ...profile.values.roles, chat: { kind: 'remote', modelId: 'cloud-chat' } },
      },
    };
    expect(() => requireRecordedTextConsent(remote, false)).toThrow(/Explicit consent/);
    expect(() => requireRecordedTextConsent(remote, true)).not.toThrow();
    expect(() => requireRecordedTextConsent(profile, false)).not.toThrow();
  });

  it('distinguishes possible nondeterminism from changed models and profile revisions', async () => {
    const original = (await replayRun(run, fixture().recorder)).stages[1];
    const old = {
      id: 'result',
      profileId: profile.id,
      profileRevision: 3,
      mode: 'chat' as const,
      startedAt: new Date().toISOString(),
      durationMs: 1,
      stages: [
        {
          role: 'chat' as const,
          model: { kind: 'local' as const, modelId: 'chat-old' },
          constructedRequest: null,
          submittedRequest: null,
          rawResponse: null,
          normalized: null,
          parsed: null,
          accepted: { events: [], messages: [] },
          usage: null,
          error: null,
          status: 'accepted' as const,
        },
      ],
      accepted: null,
      observations: [],
      visionReference: null,
      sourceVisionReference: null,
      error: null,
    };
    expect(compareRecordedChat(original, old).changes).toMatchObject({
      model: false,
      profileRevision: false,
      output: true,
      possibleSamplingVariation: true,
    });
    expect(
      compareRecordedChat(original, { ...old, profileId: 'other' }).changes
        .possibleSamplingVariation,
    ).toBe(false);
  });
});
