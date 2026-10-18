// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DesktopPage } from './app';
import type { DesktopAPI } from '../../shared/chat-contract';
import {
  DEFAULT_PREFERENCES,
  type SessionPreferences,
  type SessionSnapshot,
} from '../../shared/session-contract';
import type { ModelManagerSnapshot } from '../../shared/model-install-contract';

const emptyModels: ModelManagerSnapshot = {
  storageDirectory: '/models',
  installations: [],
  active: { 'vision-language': null, 'speech-to-text': null },
  progress: { phase: 'idle', file: null, receivedBytes: 0, totalBytes: null },
};
const modelsAPI = {
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
  startSpeechTest: async () => {
    throw new Error('Not used in this test.');
  },
  submitSpeechTestPcm: async () => {
    throw new Error('Not used in this test.');
  },
  finishSpeechTest: async () => {
    throw new Error('Not used in this test.');
  },
  stopSpeechTest: async () => ({
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
  getPlaygroundStatus: async () => ({ busy: false }),
  onPlaygroundStatus: () => () => {},
  runFreeform: async () => {
    throw new Error('Not used in this test.');
  },
  getOperationalLogs: async () => ({ entries: [], retention: { ageDays: 14, maxMiB: 5 } }),
  configureOperationalLogs: async (retention: import('../../shared/log-contract').LogRetention) =>
    retention,
  onOperationalLog: () => () => {},
  onMediaStop: () => () => {},
  getDiagnosticCapture: async () => ({ enabled: false, samples: 0, bytes: 0, dropped: 0 }),
  configureDiagnosticCapture: async (enabled: boolean) => ({
    enabled,
    samples: 0,
    bytes: 0,
    dropped: 0,
  }),
  exportDiagnosticCapture: async () => true,
  getOverlayStatus: async () => ({
    port: 18080,
    url: 'http://127.0.0.1:18080/overlay',
    error: null,
  }),
  configureOverlayPort: async (port: number) => ({
    port,
    url: `http://127.0.0.1:${port}/overlay`,
    error: null,
  }),
  onOverlayChange: () => () => {},
  getWindowStatus: async () => ({ closeToTray: true, trayAvailable: true }),
  setCloseToTray: async (enabled: boolean) => ({ closeToTray: enabled, trayAvailable: enabled }),
  getFloatingChat: async () => ({
    open: false,
    settings: { width: 420, height: 600, decorated: true, transparent: false, alwaysOnTop: false },
    warning: null,
  }),
  openFloatingChat: async () => ({
    open: true,
    settings: { width: 420, height: 600, decorated: true, transparent: false, alwaysOnTop: false },
    warning: null,
  }),
  closeFloatingChat: async () => ({
    open: false,
    settings: { width: 420, height: 600, decorated: true, transparent: false, alwaysOnTop: false },
    warning: null,
  }),
  configureFloatingChat: async (
    settings: import('../../shared/floating-chat-contract').FloatingChatSettings,
  ) => ({ open: false, settings, warning: null }),
  onFloatingChatChange: () => () => {},
  retrySession: async () => ({ ...emptyStatus }),
  getNativeStatus: async () => ({ revision: 0, phase: 'stopped' as const, error: null }),
  onNativeChange: () => () => {},
  retryAudio: async () => ({ revision: 0, sources: [], transcripts: [] }),
  getAudience: async () => ({
    revision: 0,
    phase: 'ready' as const,
    members: [],
    targetCount: 3,
    error: null,
  }),
  regenerateAudience: async () => ({
    revision: 1,
    phase: 'ready' as const,
    members: [{ author: 'viewer_one', color: '#bba5ff' }],
    targetCount: 3,
    error: null,
  }),
  onAudienceChange: () => () => {},
  getModelsSnapshot: async () => emptyModels,
  onModelsChange: () => () => {},
  installModel: async () => emptyModels,
  cancelModelDownload: async () => {},
  activateModel: async () => emptyModels,
  removeModel: async () => emptyModels,
  chooseModelDirectory: async () => emptyModels,
  getVideoClock: async () => performance.timeOrigin + performance.now(),
  reportRecordedVideoError: async () => emptyStatus,
  listDisplaySources: async () => [],
  selectVideoSource: async () => performance.timeOrigin + performance.now(),
  submitVideoFrame: async () => {},
  getAudioConfiguration: async () => [],
  setAudioConfiguration: async (
    inputs: import('../../shared/audio-contract').AudioInputConfiguration[],
  ) => inputs,
  getAudioStatus: async () => ({ revision: 0, sources: [], transcripts: [] }),
  getAudioCapabilities: async () => ({ windowsLoopback: false }),
  onAudioChange: () => () => {},
  setAudioLabel: async () => ({ revision: 0, sources: [], transcripts: [] }),
  audioDisconnected: async () => ({ revision: 0, sources: [], transcripts: [] }),
  removeAudioInput: async () => ({ revision: 0, sources: [], transcripts: [] }),
  startAudio: async () => ({ revision: 1, sources: [], transcripts: [] }),
  stopAudio: async () => ({ revision: 2, sources: [], transcripts: [] }),
  submitAudioSegment: async () => {},
};

const emptyStatus: SessionSnapshot = {
  phase: 'stopped',
  revision: 0,
  error: null,
  warning: null,
  cycle: 0,
  retryAttempt: 0,
  pendingMessages: 0,
  mode: 'fake',
  events: [],
  latestInferenceMs: null,
  smoothedInferenceMs: null,
  playbackWindowMs: 3000,
  droppedObservations: 0,
};

Element.prototype.scrollIntoView = () => {};

afterEach(() => {
  cleanup();
  delete window.lonelyChat;
});

it('starts and stops manual-context simulation, shows status and only saves preferences', async () => {
  let status: SessionSnapshot = { ...emptyStatus };
  const startSession = vi.fn(async (manualContext: string) => {
    expect(manualContext).toBe('I am playing a spooky game');
    status = { ...status, phase: 'running', cycle: 1, revision: 1, pendingMessages: 2 };
    return status;
  });
  const stopSession = vi.fn(async () => {
    status = { ...status, phase: 'stopped', revision: 2, pendingMessages: 0 };
    return status;
  });
  const setPreferences = vi.fn(async (preferences: SessionPreferences) => preferences);
  window.lonelyChat = {
    ...modelsAPI,
    getChatSnapshot: async () => ({ type: 'snapshot', sequence: 0, messages: [] }),
    onChatEvent: () => () => {},
    publishSample: async () => {},
    getOverlayUrl: async () => 'http://127.0.0.1:45939/overlay',
    getSessionSnapshot: async () => status,
    onSessionChange: () => () => {},
    startSession,
    stopSession,
    getPreferences: async () => DEFAULT_PREFERENCES,
    setPreferences,
    discoverModels: async () => {
      throw new Error('Not used in this test');
    },
  } satisfies DesktopAPI;
  render(<DesktopPage />);
  const start = await screen.findByRole('button', { name: /Start simulation/i });
  await waitFor(() => expect(start.hasAttribute('disabled')).toBe(false));
  fireEvent.change(screen.getByLabelText('Stream context'), {
    target: { value: 'I am playing a spooky game' },
  });
  fireEvent.click(start);
  await screen.findByRole('button', { name: /Stop simulation/i });
  expect(screen.getByRole('status').textContent).toContain('Running');
  expect(startSession).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: /Stop simulation/i }));
  await screen.findByRole('button', { name: /Start simulation/i });
  expect(stopSession).toHaveBeenCalledOnce();
  expect(screen.getByRole('status').textContent).toContain('Stopped');
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  expect(screen.getByRole('button', { name: 'Settings' }).getAttribute('aria-current')).toBe(
    'page',
  );
  const pace = screen.getByRole('combobox', { name: 'Inference cycle' });
  await waitFor(() => expect(pace.hasAttribute('disabled')).toBe(false));
  const user = userEvent.setup();
  await user.click(pace);
  await user.click(await screen.findByRole('option', { name: '1.5 seconds' }));
  await waitFor(() =>
    expect(setPreferences).toHaveBeenCalledWith({ ...DEFAULT_PREFERENCES, cycleIntervalMs: 1500 }),
  );
  expect(JSON.stringify(setPreferences.mock.calls)).not.toContain('spooky game');
  const reasoning = screen.getByRole('combobox', { name: 'Local model reasoning' });
  expect(reasoning.textContent).toContain('Disabled (recommended)');
  await user.click(reasoning);
  await user.click(await screen.findByRole('option', { name: 'Enabled' }));
  await waitFor(() =>
    expect(setPreferences).toHaveBeenCalledWith({
      ...DEFAULT_PREFERENCES,
      cycleIntervalMs: 1500,
      reasoningEnabled: true,
    }),
  );
  const captureInterval = screen.getByRole('combobox', { name: 'Capture interval' });
  await user.click(captureInterval);
  await user.click(await screen.findByRole('option', { name: '0.25 seconds' }));
  await waitFor(() =>
    expect(setPreferences).toHaveBeenCalledWith({
      ...DEFAULT_PREFERENCES,
      cycleIntervalMs: 1500,
      reasoningEnabled: true,
      videoCaptureIntervalMs: 250,
    }),
  );
  const strategy = screen.getByRole('combobox', { name: 'Temporal selection strategy' });
  await user.click(strategy);
  await user.click(
    await screen.findByRole('option', { name: 'Recent-weighted (keeps endpoints)' }),
  );
  await waitFor(() =>
    expect(setPreferences).toHaveBeenCalledWith({
      ...DEFAULT_PREFERENCES,
      cycleIntervalMs: 1500,
      reasoningEnabled: true,
      videoCaptureIntervalMs: 250,
      videoSamplingStrategy: 'recent-weighted',
    }),
  );
  const backend = screen.getByRole('combobox', { name: 'Preferred backend (fallback to CPU)' });
  await user.click(backend);
  await user.click(await screen.findByRole('option', { name: 'Vulkan (requires Vulkan build)' }));
  await waitFor(() =>
    expect(setPreferences).toHaveBeenCalledWith(
      expect.objectContaining({ computeBackend: 'vulkan' }),
    ),
  );
  const ram = screen.getByRole('combobox', { name: 'System RAM target (advisory)' });
  await user.click(ram);
  await user.click(await screen.findByRole('option', { name: '8192 MiB' }));
  await waitFor(() =>
    expect(setPreferences).toHaveBeenCalledWith(
      expect.objectContaining({ computeBackend: 'vulkan', ramBudgetMiB: 8192 }),
    ),
  );
  const compute = screen.getByRole('combobox', {
    name: 'GPU-compute target (best effort; 0 = off)',
  });
  await user.click(compute);
  await user.click(await screen.findByRole('option', { name: '40 percent' }));
  await waitFor(() =>
    expect(setPreferences).toHaveBeenCalledWith(
      expect.objectContaining({ ramBudgetMiB: 8192, gpuComputeTargetPercent: 40 }),
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Simulation' }));
  expect(screen.getByLabelText('Stream context')).toHaveProperty(
    'value',
    'I am playing a spooky game',
  );
  expect(screen.getByRole('button', { name: 'Simulation' }).getAttribute('aria-current')).toBe(
    'page',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Audience' }));
  const activity = screen.getByRole('combobox', { name: 'Chat activity' });
  await user.click(activity);
  await user.click(await screen.findByRole('option', { name: 'Busy (up to 8 per cycle)' }));
  await waitFor(() =>
    expect(setPreferences).toHaveBeenCalledWith(expect.objectContaining({ chatActivity: 'busy' })),
  );
  await user.click(screen.getByRole('button', { name: /Regenerate roster/ }));
  expect(await screen.findByText('viewer_one')).toBeTruthy();
}, 20_000);

it('navigates across all categories without losing the session or private draft context', async () => {
  let status: SessionSnapshot = { ...emptyStatus };
  let subscriber: ((value: SessionSnapshot) => void) | null = null;
  const startSession = vi.fn(async () => {
    status = {
      ...status,
      revision: 1,
      phase: 'running',
      cycle: 1,
      pendingMessages: 3,
    };
    subscriber?.(status);
    return status;
  });
  window.lonelyChat = {
    ...modelsAPI,
    getChatSnapshot: async () => ({ type: 'snapshot', sequence: 0, messages: [] }),
    onChatEvent: () => () => {},
    publishSample: async () => {},
    getOverlayUrl: async () => 'http://127.0.0.1:45939/overlay',
    getSessionSnapshot: async () => status,
    onSessionChange: (listener) => {
      subscriber = listener;
      return () => {
        subscriber = null;
      };
    },
    startSession,
    stopSession: async () => ({ ...emptyStatus }),
    getPreferences: async () => DEFAULT_PREFERENCES,
    setPreferences: async (value) => value,
    discoverModels: async () => {
      throw new Error('Not used');
    },
  } satisfies DesktopAPI;

  render(<DesktopPage />);
  expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeTruthy();
  const categories = [
    'Simulation',
    'Playground',
    'Audience',
    'Inputs',
    'Models',
    'Chat & Overlay',
    'Logs',
    'Settings',
  ];
  for (const category of categories) {
    const button = screen.getByRole('button', { name: category });
    fireEvent.click(button);
    expect(button.getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('region', { name: category })).toBeTruthy();
  }

  fireEvent.click(screen.getByRole('button', { name: 'Models' }));
  expect(await screen.findByRole('region', { name: 'Hugging Face model discovery' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Chat & Overlay' }));
  expect(screen.getByText('Live chat preview')).toBeTruthy();
  expect(await screen.findByText('http://127.0.0.1:18080/overlay')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Simulation' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Start simulation' }).hasAttribute('disabled')).toBe(
      false,
    ),
  );
  fireEvent.change(screen.getByLabelText('Stream context'), { target: { value: 'Playing Sonic' } });
  fireEvent.click(screen.getByRole('button', { name: 'Start simulation' }));
  await screen.findByRole('button', { name: 'Stop simulation' });
  fireEvent.click(screen.getByRole('button', { name: 'Logs' }));
  expect(
    screen
      .getByRole('button', { name: 'Simulation' })
      .querySelector('[aria-label="Simulation running"]'),
  ).toBeTruthy();
  expect(screen.getByText('Session diagnostics')).toBeTruthy();
  expect(screen.getByRole('region', { name: 'Logs' }).textContent).toContain('running');
  fireEvent.click(screen.getByRole('button', { name: 'Simulation' }));
  expect(screen.getByRole('button', { name: 'Stop simulation' })).toBeTruthy();
  expect(screen.getByLabelText('Stream context')).toHaveProperty('value', 'Playing Sonic');
  expect(startSession).toHaveBeenCalledTimes(1);
});

it('shows an unavailable overlay and lets Settings recover with a custom port', async () => {
  const initial = {
    port: 18080,
    url: null,
    error: 'Port 18080 is already in use or reserved. Choose another port in Settings.',
  };
  const configure = vi.fn(async (port: number) => ({
    port,
    url: `http://127.0.0.1:${port}/overlay`,
    error: null,
  }));
  window.lonelyChat = {
    ...modelsAPI,
    getOverlayStatus: async () => initial,
    configureOverlayPort: configure,
    getChatSnapshot: async () => ({ type: 'snapshot', sequence: 0, messages: [] }),
    onChatEvent: () => () => {},
    publishSample: async () => {},
    getOverlayUrl: async () => null,
    getSessionSnapshot: async () => ({ ...emptyStatus }),
    onSessionChange: () => () => {},
    startSession: async () => ({ ...emptyStatus }),
    stopSession: async () => ({ ...emptyStatus }),
    getPreferences: async () => DEFAULT_PREFERENCES,
    setPreferences: async (value) => value,
    discoverModels: async () => {
      throw new Error('Not used');
    },
  } satisfies DesktopAPI;

  render(<DesktopPage />);
  expect(await screen.findByRole('button', { name: 'Overlay port issue · Settings' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Chat & Overlay' }));
  expect(await screen.findByText(/Port 18080 is already in use or reserved/)).toBeTruthy();
  expect(screen.getByText('Overlay server unavailable')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Configure overlay port' }));
  const port = screen.getByRole('spinbutton', { name: 'Overlay port' });
  expect(port).toHaveProperty('value', '18080');
  fireEvent.change(port, { target: { value: '19000' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply port' }));
  await waitFor(() => expect(configure).toHaveBeenCalledWith(19000));
  expect(await screen.findByText('http://127.0.0.1:19000/overlay')).toBeTruthy();
  expect(screen.queryByText(/Port 18080 is already in use or reserved/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Chat & Overlay' }));
  expect(screen.getByText('http://127.0.0.1:19000/overlay')).toBeTruthy();
});

it('shows a rejected start error and remains ready to retry', async () => {
  window.lonelyChat = {
    ...modelsAPI,
    getChatSnapshot: async () => ({ type: 'snapshot', sequence: 0, messages: [] }),
    onChatEvent: () => () => {},
    publishSample: async () => {},
    getOverlayUrl: async () => 'http://127.0.0.1:45939/overlay',
    getSessionSnapshot: async () => ({ ...emptyStatus }),
    onSessionChange: () => () => {},
    startSession: async () => {
      throw new Error('Enter some context to start the test simulation.');
    },
    stopSession: async () => ({ ...emptyStatus }),
    getPreferences: async () => DEFAULT_PREFERENCES,
    setPreferences: async (value) => value,
    discoverModels: async () => {
      throw new Error('Not used in this test');
    },
  };
  render(<DesktopPage />);
  const start = await screen.findByRole('button', { name: /Start simulation/i });
  await waitFor(() => expect(start.hasAttribute('disabled')).toBe(false));
  fireEvent.click(start);
  expect((await screen.findByRole('alert')).textContent).toMatch(/Enter some context/);
  expect(start.hasAttribute('disabled')).toBe(false);
});
