// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DesktopPage } from './app';
import type { DesktopAPI } from '../../shared/chat-contract';
import type { SessionSnapshot } from '../../shared/session-contract';
import type { ModelManagerSnapshot } from '../../shared/model-install-contract';

const emptyModels: ModelManagerSnapshot = {
  storageDirectory: '/models',
  installations: [],
  active: { 'vision-language': null, 'speech-to-text': null },
  progress: { phase: 'idle', file: null, receivedBytes: 0, totalBytes: null },
};
const modelsAPI = {
  getModelsSnapshot: async () => emptyModels,
  onModelsChange: () => () => {},
  installModel: async () => emptyModels,
  cancelModelDownload: async () => {},
  activateModel: async () => emptyModels,
  removeModel: async () => emptyModels,
  chooseModelDirectory: async () => emptyModels,
};

Element.prototype.scrollIntoView = () => {};

afterEach(() => {
  cleanup();
  delete window.lonelyChat;
});

it('starts and stops manual-context simulation, shows status and only saves preferences', async () => {
  let status: SessionSnapshot = {
    phase: 'stopped',
    revision: 0,
    error: null,
    cycle: 0,
    pendingMessages: 0,
  };
  const startSession = vi.fn(async (manualContext: string) => {
    expect(manualContext).toBe('I am playing a spooky game');
    status = { ...status, phase: 'running', cycle: 1, revision: 1, pendingMessages: 2 };
    return status;
  });
  const stopSession = vi.fn(async () => {
    status = { ...status, phase: 'stopped', revision: 2, pendingMessages: 0 };
    return status;
  });
  const setPreferences = vi.fn(async (preferences: { cycleIntervalMs: number }) => preferences);
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
    getPreferences: async () => ({ cycleIntervalMs: 3000 }),
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
  const pace = screen.getByRole('combobox', { name: 'Inference cycle' });
  await waitFor(() => expect(pace.hasAttribute('disabled')).toBe(false));
  const user = userEvent.setup();
  await user.click(pace);
  await user.click(await screen.findByRole('option', { name: '1.5 seconds' }));
  await waitFor(() => expect(setPreferences).toHaveBeenCalledWith({ cycleIntervalMs: 1500 }));
  expect(JSON.stringify(setPreferences.mock.calls)).not.toContain('spooky game');
});

it('shows a rejected start error and remains ready to retry', async () => {
  window.lonelyChat = {
    ...modelsAPI,
    getChatSnapshot: async () => ({ type: 'snapshot', sequence: 0, messages: [] }),
    onChatEvent: () => () => {},
    publishSample: async () => {},
    getOverlayUrl: async () => 'http://127.0.0.1:45939/overlay',
    getSessionSnapshot: async () => ({
      phase: 'stopped',
      revision: 0,
      error: null,
      cycle: 0,
      pendingMessages: 0,
    }),
    onSessionChange: () => () => {},
    startSession: async () => {
      throw new Error('Enter some context to start the test simulation.');
    },
    stopSession: async () => ({
      phase: 'stopped',
      revision: 0,
      error: null,
      cycle: 0,
      pendingMessages: 0,
    }),
    getPreferences: async () => ({ cycleIntervalMs: 3000 }),
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
