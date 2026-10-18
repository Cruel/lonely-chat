// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { DesktopAPI } from '../shared/chat-contract';
import type { LogEntry } from '../shared/log-contract';
import { useUnreadLogErrors } from './use-unread-log-errors';

let dispatch: ((entry: LogEntry) => void) | null = null;
function Harness() {
  const [onLogs, setOnLogs] = importReactState(false);
  const unread = useUnreadLogErrors(onLogs);
  return (
    <>
      <button onClick={() => setOnLogs(!onLogs)}>{onLogs ? 'Leave Logs' : 'Open Logs'}</button>
      <output aria-label="Unread error count">{unread}</output>
    </>
  );
}
import { useState as importReactState } from 'react';

afterEach(() => {
  cleanup();
  delete window.lonelyChat;
  dispatch = null;
});

it('counts new errors while away, not old persisted history, and clears only on a visit', () => {
  window.lonelyChat = {
    onOperationalLog: (listener: (entry: LogEntry) => void) => {
      dispatch = listener;
      return () => {
        dispatch = null;
      };
    },
  } as unknown as DesktopAPI;
  const entry: LogEntry = {
    id: 'error-1',
    timestamp: '2026-10-18T00:00:00Z',
    source: 'renderer',
    level: 'error',
    text: 'Crash',
  };
  render(<Harness />);
  expect(screen.getByLabelText('Unread error count').textContent).toBe('0');
  fireEvent.click(screen.getByRole('button', { name: 'Open Logs' }));
  act(() => dispatch?.(entry));
  expect(screen.getByLabelText('Unread error count').textContent).toBe('0');
  fireEvent.click(screen.getByRole('button', { name: 'Leave Logs' }));
  act(() => {
    dispatch?.({ ...entry, level: 'warn' });
    dispatch?.(entry);
  });
  expect(screen.getByLabelText('Unread error count').textContent).toBe('1');
  fireEvent.click(screen.getByRole('button', { name: 'Open Logs' }));
  expect(screen.getByLabelText('Unread error count').textContent).toBe('0');
  fireEvent.click(screen.getByRole('button', { name: 'Leave Logs' }));
  act(() => dispatch?.({ ...entry, id: 'error-2' }));
  expect(screen.getByLabelText('Unread error count').textContent).toBe('1');
});
