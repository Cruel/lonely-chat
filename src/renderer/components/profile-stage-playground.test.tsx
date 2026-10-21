// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DesktopAPI } from '../../shared/chat-contract';
import type { InferenceProfile } from '../../shared/inference-profile-contract';
import type { ProfileExperimentRequest, ProfileExperimentResult } from '../../shared/profile-playground-contract';
import { ProfileStagePlayground } from './profile-stage-playground';

afterEach(() => {
  cleanup();
  delete window.lonelyChat;
});

const profile: InferenceProfile = {
  id: '11111111-1111-4111-8111-111111111111', name: 'Hybrid profile', revision: 3,
  values: {
    topology: 'hybrid',
    roles: {
      observer: { kind: 'remote', modelId: 'vision-v1' },
      chat: { kind: 'local', modelId: 'chat-v2' },
    },
    stageDefaults: {},
    architecture: { execution: 'sequential', hybridMaxImages: 1 },
  },
};

function setup() {
  const previewProfileExperiment = vi.fn(async (request: ProfileExperimentRequest) => ({
    profileId: request.profileId, profileRevision: 3, mode: request.mode,
    stages: [{ role: 'observer' as const, model: profile.values.roles.observer!,
      request: { instructions: 'Test', role: 'vision', content: [] } }],
    sourceVisionReference: null,
  }));
  const runProfileExperiment = vi.fn(async (request: ProfileExperimentRequest): Promise<ProfileExperimentResult> => ({
    id: crypto.randomUUID(), profileId: profile.id, profileRevision: 3,
    mode: request.mode, startedAt: new Date().toISOString(), durationMs: 10,
    stages: [{ role: request.mode === 'chat' ? 'chat' : 'observer',
      model: profile.values.roles.observer!, constructedRequest: { role: 'vision' }, submittedRequest: { role: 'vision' },
      rawResponse: {}, normalized: {}, parsed: {}, accepted: {},
      status: 'accepted', error: null, usage: null }],
    accepted: { events: [], messages: [] }, observations: [],
    error: null,
    visionReference: request.mode === 'vision' ? {
      id: '22222222-2222-4222-8222-222222222222',
      label: 'Saved Vision A', profileId: profile.id, profileRevision: 3,
    } : null,
    sourceVisionReference: request.visionReferenceId ?? null,
  }));
  window.lonelyChat = {
    listInferenceProfiles: async () => [profile],
    getPlaygroundStatus: async () => ({ busy: false }),
    onPlaygroundStatus: () => () => {},
    previewProfileExperiment, runProfileExperiment,
  } as unknown as DesktopAPI;
  return { previewProfileExperiment, runProfileExperiment };
}

it('previews selected production stages and forks a Vision result into Chat without selecting Vision again', async () => {
  const api = setup();
  render(<ProfileStagePlayground simulationActive={false} />);
  await screen.findByRole('option', { name: /Hybrid profile/ });
  fireEvent.change(screen.getByLabelText('Experiment mode'), { target: { value: 'vision' } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview effective stages' }));
  await waitFor(() => expect(api.previewProfileExperiment).toHaveBeenCalledOnce());
  expect(api.previewProfileExperiment.mock.calls[0][0]).toMatchObject({
    profileId: profile.id, mode: 'vision', experiment: {
      values: { context: 'Playing a game on stream.' },
    },
  });
  expect(screen.getByLabelText('Effective profile requests')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Run profile experiment' }));
  await waitFor(() => expect(api.runProfileExperiment).toHaveBeenCalledOnce());
  expect(screen.getByRole('button', { name: 'Fork Vision into Chat-only test' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Fork Vision into Chat-only test' }));
  expect((screen.getByLabelText('Experiment mode') as HTMLSelectElement).value).toBe('chat');
  expect((screen.getByLabelText('Reuse captured Vision result') as HTMLSelectElement).value)
    .toBe('22222222-2222-4222-8222-222222222222');
  fireEvent.click(screen.getByRole('button', { name: 'Run profile experiment' }));
  await waitFor(() => expect(api.runProfileExperiment).toHaveBeenCalledTimes(2));
  expect(api.runProfileExperiment.mock.calls[1][0]).toMatchObject({
    mode: 'chat', visionReferenceId: '22222222-2222-4222-8222-222222222222',
  });
});

it('disables stage execution while Simulation owns the worker', async () => {
  setup();
  render(<ProfileStagePlayground simulationActive={true} />);
  await screen.findByRole('option', { name: /Hybrid profile/ });
  expect(screen.getByRole('button', { name: 'Run profile experiment' }).hasAttribute('disabled'))
    .toBe(true);
  expect(screen.getByRole('button', { name: 'Preview effective stages' }).hasAttribute('disabled'))
    .toBe(false);
});
