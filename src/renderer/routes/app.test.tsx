// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DesktopPage } from './app';
import type { DesktopAPI } from '../../shared/chat-contract';
import type { SessionSnapshot } from '../../shared/session-contract';

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
  fireEvent.change(screen.getByLabelText('Inference cycle'), { target: { value: '1500' } });
  await waitFor(() => expect(setPreferences).toHaveBeenCalledWith({ cycleIntervalMs: 1500 }));
  expect(JSON.stringify(setPreferences.mock.calls)).not.toContain('spooky game');
});

it('shows a rejected start error and remains ready to retry', async () => {
  window.lonelyChat = {
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
  };
  render(<DesktopPage />);
  const start = await screen.findByRole('button', { name: /Start simulation/i });
  await waitFor(() => expect(start.hasAttribute('disabled')).toBe(false));
  fireEvent.click(start);
  expect((await screen.findByRole('alert')).textContent).toMatch(/Enter some context/);
  expect(start.hasAttribute('disabled')).toBe(false);
});
