// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DesktopAPI } from '../../shared/chat-contract';
import type { RecordedRun } from '../../shared/recorded-scenario-contract';
import type { InferenceProfile } from '../../shared/inference-profile-contract';
import type { RunReplay } from '../../shared/run-replay-contract';
import { RecordedRunReplay } from './recorded-run-replay';

const profile: InferenceProfile = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Remote Chat comparison',
  revision: 2,
  values: {
    topology: 'split',
    roles: {
      observer: { kind: 'local', modelId: 'vision-local' },
      chat: { kind: 'remote', modelId: 'cloud-chat' },
    },
    stageDefaults: {},
  },
};
const run = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Archive',
  status: 'completed',
  startedAt: new Date().toISOString(),
} as RecordedRun;
const replay: RunReplay = {
  runId: run.id,
  status: run.status,
  warning: null,
  missingDependencies: [],
  stages: [
    {
      id: 'attempt-vision',
      recordingId: 'recording-archive',
      role: 'vision',
      cycle: 1,
      attempt: 1,
      stage: 'accepted',
      modelId: 'vision-local',
      profileId: profile.id,
      profileRevision: 2,
      seed: 12,
      observedAt: 100,
      availableAt: 200,
      startedAt: 120,
      dependsOn: [],
      sourceFrameIds: [],
      requestProvenance: 'exact-recorded-request',
      accepted: { events: [], messages: [] },
      consumedEvents: [],
      sceneState: 'Scene',
      scheduled: null,
      presented: [],
      presentationClosed: true,
      usage: null,
      error: null,
      incomplete: false,
    },
    {
      id: 'attempt-chat',
      recordingId: 'recording-archive',
      role: 'chat',
      cycle: 2,
      attempt: 1,
      stage: 'scheduled',
      modelId: 'cloud-chat',
      profileId: profile.id,
      profileRevision: 2,
      seed: 12,
      observedAt: 120,
      availableAt: 230,
      startedAt: 210,
      dependsOn: ['attempt-vision'],
      sourceFrameIds: [],
      requestProvenance: 'metadata-only',
      accepted: { events: [], messages: [] },
      consumedEvents: [],
      sceneState: null,
      scheduled: [],
      presented: [],
      presentationClosed: true,
      usage: null,
      error: null,
      incomplete: false,
    },
  ],
};
afterEach(() => {
  cleanup();
  delete window.lonelyChat;
});

it('loads recorded stage evidence without making inference requests or publishing', async () => {
  const replayRecordedRun = vi.fn(async () => replay);
  const reinferRecordedChat = vi.fn();
  const onFullReinfer = vi.fn();
  window.lonelyChat = {
    replayRecordedRun,
    reinferRecordedChat,
    listInferenceProfiles: vi.fn(async () => [profile]),
  } as unknown as DesktopAPI;
  render(<RecordedRunReplay run={run} active={false} onFullReinfer={onFullReinfer} />);
  fireEvent.click(screen.getByRole('button', { name: /Inspect saved stages/ }));
  await screen.findByText(/Archived stages: 2/);
  expect(replayRecordedRun).toHaveBeenCalledWith(run.id);
  expect(reinferRecordedChat).not.toHaveBeenCalled();
  expect(onFullReinfer).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: /Load frozen settings/ }));
  expect(onFullReinfer).toHaveBeenCalledOnce();
});

it('requires remote Chat consent before comparison and keeps archived output inspectable', async () => {
  const reinferRecordedChat = vi.fn(async () => ({
    original: replay.stages[1],
    experiment: {
      id: 'comparison',
      profileId: profile.id,
      profileRevision: 2,
      mode: 'chat',
      startedAt: new Date().toISOString(),
      durationMs: 1,
      stages: [],
      accepted: null,
      observations: [],
      visionReference: null,
      sourceVisionReference: null,
      error: null,
    },
    changes: {
      model: false,
      profileRevision: false,
      seed: false,
      output: true,
      possibleSamplingVariation: true,
    },
  }));
  window.lonelyChat = {
    replayRecordedRun: vi.fn(async () => replay),
    reinferRecordedChat,
    listInferenceProfiles: vi.fn(async () => [profile]),
  } as unknown as DesktopAPI;
  render(<RecordedRunReplay run={run} active={false} onFullReinfer={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: /Inspect saved stages/ }));
  await screen.findByText(/Archived stages: 2/);
  const compareButton = screen.getByRole('button', { name: /Rerun Chat only/ });
  expect(compareButton.hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('checkbox'));
  expect(compareButton.hasAttribute('disabled')).toBe(false);
  fireEvent.click(compareButton);
  await waitFor(() =>
    expect(reinferRecordedChat).toHaveBeenCalledWith(run.id, 'attempt-chat', profile.id, true),
  );
  expect(screen.getByText(/Archived Chat vs new Chat/)).toBeTruthy();
});
