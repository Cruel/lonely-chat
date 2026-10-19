// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DesktopPage } from './app';
import type { DesktopAPI } from '../../shared/chat-contract';
import type {
  RecordedScenario,
  RecordedScenarioConfig,
} from '../../shared/recorded-scenario-contract';
import { DEFAULT_PREFERENCES } from '../../shared/session-contract';
import type { SessionSnapshot } from '../../shared/session-contract';

const config: RecordedScenarioConfig = {
  context: 'Audience reacts to a speedrun',
  mode: 'native',
  video: null,
  audio: [],
  segment: { startMs: 0, endMs: null },
  transcriptMode: 'transcribe',
  publishToOverlay: false,
  seed: 44,
  presetId: null,
  presetRevision: null,
  modelId: 'saved-vision-model',
  settingsSnapshot: { ...DEFAULT_PREFERENCES, cycleIntervalMs: 5000 },
  settingsPolicy: 'saved',
};
const scenario: RecordedScenario = {
  id: 'd808de38-d620-4fb8-b071-216c967848cd',
  name: 'Speedrun intro',
  savedAt: '2026-10-18T00:00:00Z',
  config,
};
const initial: SessionSnapshot = {
  revision: 0,
  phase: 'stopped',
  error: null,
  warning: null,
  cycle: 0,
  retryAttempt: 0,
  pendingMessages: 0,
  mode: 'fake',
  latestInferenceMs: null,
  smoothedInferenceMs: null,
  playbackWindowMs: 3000,
  droppedObservations: 0,
  events: [],
};
Element.prototype.scrollIntoView = () => {};
afterEach(() => {
  cleanup();
  delete window.lonelyChat;
});

it('loads a saved Scenario, preserves its policy and explicitly isolates recorded chat until enabled', async () => {
  let status = initial;
  const startSession = vi.fn(async (_context: string, _mode: string, _options: unknown) => {
    status = {
      ...status,
      revision: status.revision + 1,
      phase: 'running',
      recordedPlayback: 'playing',
      runId: (status.runId ?? 0) + 1,
      inputMode: 'recorded',
    };
    return status;
  });
  const stopSession = vi.fn(async () => {
    status = { ...status, revision: status.revision + 1, phase: 'stopped', recordedPlayback: null };
    return status;
  });
  const save = vi.fn(
    async (_name: string, _config: RecordedScenarioConfig, _id?: string) => scenario,
  );
  const api = {
    getChatSnapshot: async () => ({ type: 'snapshot' as const, sequence: 0, messages: [] }),
    onOperationalLog: () => () => {},
    onModelsChange: () => () => {},
    getAudioConfiguration: async () => [],
    setAudioConfiguration: async (items: unknown) => items,
    getAudioStatus: async () => ({ revision: 0, sources: [], transcripts: [] }),
    onAudioChange: () => () => {},
    getAudioCapabilities: async () => ({ windowsLoopback: false }),
    getPlaygroundStatus: async () => ({ busy: false }),
    onPlaygroundStatus: () => () => {},
    getNativeStatus: async () => ({ revision: 0, phase: 'stopped' as const, error: null }),
    onNativeChange: () => () => {},
    getCompactRecording: async () => ({
      mode: 'compact' as const,
      enabled: false,
      recordingId: null,
      attempts: 0,
      chunks: 0,
      bytes: 0,
      error: null,
    }),
    getSpeechTestStatus: async () => ({
      revision: 0,
      phase: 'idle' as const,
      mode: null,
      sourceId: null,
      label: null,
      pending: 0,
      segments: [],
      error: null,
    }),
    onSpeechTestChange: () => () => {},
    listInferenceTraces: async () => ({ attempts: [], dropped: 0, bytes: 0 }),
    onInferenceTraces: () => () => {},
    getOverlayStatus: async () => ({ port: 18080, url: null, error: null }),
    onOverlayChange: () => () => {},
    getWindowStatus: async () => ({ closeToTray: true, trayAvailable: false }),
    getFloatingChat: async () => ({
      open: false,
      settings: {
        width: 420,
        height: 600,
        decorated: true,
        transparent: false,
        alwaysOnTop: false,
      },
      warning: null,
    }),
    onFloatingChatChange: () => () => {},
    onChatEvent: () => () => {},
    getSessionSnapshot: async () => status,
    onSessionChange: () => () => {},
    getPreferences: async () => DEFAULT_PREFERENCES,
    setPreferences: async () => DEFAULT_PREFERENCES,
    startSession,
    stopSession,
    getAudience: async () => ({
      revision: 0,
      phase: 'ready' as const,
      members: [],
      targetCount: 3,
      error: null,
    }),
    onAudienceChange: () => () => {},
    listPromptPresets: async () => [],
    listPromptPresetRevisions: async () => [],
    listRecordedScenarios: async () => [scenario],
    listRecordedRuns: async () => [],
    saveRecordedScenario: save,
    getVideoClock: async () => performance.timeOrigin + performance.now(),
    getModelsSnapshot: async () => ({
      storageDirectory: '/models',
      installations: [],
      active: { 'vision-language': 'different-current-model', 'speech-to-text': null },
      progress: { phase: 'idle' as const, file: null, receivedBytes: 0, totalBytes: null },
    }),
  } as unknown as DesktopAPI;
  window.lonelyChat = api;
  render(<DesktopPage />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('combobox', { name: /Media input mode/ }));
  await user.click(await screen.findByRole('option', { name: 'Recorded video (1×)' }));
  fireEvent.change(await screen.findByLabelText('Choose recorded Scenario'), {
    target: { value: scenario.id },
  });
  await waitFor(() =>
    expect((screen.getByLabelText('Recorded Scenario name') as HTMLInputElement).value).toBe(
      'Speedrun intro',
    ),
  );
  expect((screen.getByLabelText('Scenario settings policy') as HTMLSelectElement).value).toBe(
    'saved',
  );
  expect((screen.getByLabelText('Session seed (optional)') as HTMLInputElement).value).toBe('44');
  expect(
    (
      screen.getByLabelText(
        'Publish recorded chat to overlay and floating window',
      ) as HTMLInputElement
    ).checked,
  ).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Save Scenario' }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      'Speedrun intro',
      expect.objectContaining({
        context: 'Audience reacts to a speedrun',
        seed: 44,
        modelId: 'saved-vision-model',
        publishToOverlay: false,
        settingsSnapshot: expect.objectContaining({ cycleIntervalMs: 5000 }),
      }),
      scenario.id,
    ),
  );

  const start = screen.getByRole('button', { name: 'Start simulation' });
  await waitFor(() => expect(start.hasAttribute('disabled')).toBe(false));
  fireEvent.click(start);
  await waitFor(() =>
    expect(startSession).toHaveBeenCalledWith(
      'Audience reacts to a speedrun',
      'native',
      expect.objectContaining({
        inputMode: 'recorded',
        publishToOverlay: false,
        recordedScenarioId: scenario.id,
        recordedConfig: expect.objectContaining({
          publishToOverlay: false,
          modelId: 'saved-vision-model',
          settingsPolicy: 'saved',
        }),
      }),
    ),
  );
  fireEvent.click(await screen.findByRole('button', { name: /Stop simulation/ }));
  await waitFor(() => expect(stopSession).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByLabelText('Publish recorded chat to overlay and floating window'));
  await waitFor(() =>
    expect(
      screen.getByLabelText('Publish recorded chat to overlay and floating window'),
    ).toHaveProperty('checked', true),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Start simulation' }));
  await waitFor(() => expect(startSession).toHaveBeenCalledTimes(2));
  expect(startSession.mock.calls[1][2]).toMatchObject({
    publishToOverlay: true,
    recordedConfig: { publishToOverlay: true },
  });
});
