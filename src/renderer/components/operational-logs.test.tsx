// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DesktopAPI } from '../../shared/chat-contract';
import type { LogEntry } from '../../shared/log-contract';
import { OperationalLogs } from './operational-logs';

afterEach(() => {
  cleanup();
  delete window.lonelyChat;
});

it('shows persisted one-line events, subscribes to live logs, expands errors and configures retention', async () => {
  const entry: LogEntry = {
    id: 'first',
    timestamp: '2026-10-18T01:00:00.000Z',
    level: 'error',
    source: 'application',
    text: 'Startup failure',
    error: { message: 'Bad config', stack: 'Error: Bad config\n    at start' },
    context: { code: 42 },
  };
  let emit: ((entry: LogEntry) => void) | null = null;
  const configure = vi.fn(async (retention) => retention);
  window.lonelyChat = {
    onOperationalLog: (listener: (entry: LogEntry) => void) => {
      emit = listener;
      return () => {
        emit = null;
      };
    },
    getOperationalLogs: async () => ({ entries: [entry], retention: { ageDays: 14, maxMiB: 5 } }),
    configureOperationalLogs: configure,
  } as unknown as DesktopAPI;

  render(<OperationalLogs />);
  expect((await screen.findAllByText('Startup failure')).length).toBe(2);
  expect(screen.getByLabelText('Event history').querySelectorAll('li')).toHaveLength(1);
  const detail = screen.getAllByText('Startup failure')[0].closest('details')!;
  expect(detail.open).toBe(false);
  fireEvent.click(screen.getAllByText('Startup failure')[0]);
  expect(detail.open).toBe(true);
  expect(screen.getByText(/at start/)).toBeTruthy();

  emit!({
    ...entry,
    id: 'second',
    level: 'info',
    source: 'shell',
    text: 'Window created',
    error: undefined,
  });
  expect((await screen.findAllByText('Window created')).length).toBe(2);
  fireEvent.change(screen.getByLabelText('Search logs'), { target: { value: 'startup' } });
  expect(screen.queryAllByText('Window created')).toHaveLength(0);
  fireEvent.change(screen.getByLabelText('Search logs'), { target: { value: '' } });
  fireEvent.change(screen.getByLabelText('Retain days'), { target: { value: '7' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save retention' }));
  await waitFor(() => expect(configure).toHaveBeenCalledWith({ ageDays: 7, maxMiB: 5 }));
});

it('filters by source, stops auto-follow without stopping live updates, copies and exports main-owned IDs', async () => {
  const copy = vi.fn(async (_text: string) => {});
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: copy }, configurable: true });
  const exportLogs = vi.fn(async (_ids: readonly string[]) => true);
  const entries: LogEntry[] = [
    {
      id: 'one',
      timestamp: '2026-10-18T00:00:00Z',
      level: 'error',
      source: 'overlay',
      text: 'Overlay failed',
    },
    {
      id: 'two',
      timestamp: '2026-10-18T00:00:01Z',
      level: 'warn',
      source: 'models',
      text: 'Model stalled',
    },
  ];
  let emit: (entry: LogEntry) => void = () => {};
  window.lonelyChat = {
    onOperationalLog: (listener: (entry: LogEntry) => void) => {
      emit = listener;
      return () => {};
    },
    getOperationalLogs: async () => ({ entries, retention: { ageDays: 14, maxMiB: 5 } }),
    exportOperationalLogs: exportLogs,
  } as unknown as DesktopAPI;
  const { rerender } = render(<OperationalLogs focus={{ source: 'overlay', nonce: 1 }} />);
  expect((await screen.findAllByText('Overlay failed')).length).toBe(2);
  expect(screen.queryByText('Model stalled')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Copy filtered' }));
  await waitFor(() => expect(copy).toHaveBeenCalledWith(expect.stringContaining('Overlay failed')));
  expect(copy.mock.calls[0][0]).not.toContain('Model stalled');
  fireEvent.click(screen.getByRole('button', { name: 'Export filtered…' }));
  await waitFor(() => expect(exportLogs).toHaveBeenCalledWith(['one']));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Follow newest logs' }));
  expect(screen.getByRole('checkbox', { name: 'Follow newest logs' })).not.toHaveProperty(
    'checked',
    true,
  );
  emit({
    id: 'three',
    timestamp: '2026-10-18T00:00:02Z',
    level: 'error',
    source: 'overlay',
    text: 'Again',
  });
  expect((await screen.findAllByText('Again')).length).toBe(2);
  rerender(<OperationalLogs focus={null} />);
  expect((await screen.findAllByText('Model stalled')).length).toBe(2);
  expect(screen.getByLabelText('Event history').querySelectorAll('li')).toHaveLength(3);
});
