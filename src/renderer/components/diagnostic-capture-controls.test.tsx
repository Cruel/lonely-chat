// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DiagnosticCaptureControls } from './diagnostic-capture-controls';
import type { DesktopAPI } from '../../shared/chat-contract';

afterEach(() => {
  cleanup();
  delete window.lonelyChat;
});

it('shows expandable multiline worker failures only with explicit private capture', async () => {
  let enabled = false;
  const lines = [
    { worker: 'worker-one', stream: 'stderr' as const, line: 'stack trace first line' },
    { worker: 'worker-one', stream: 'stderr' as const, line: '    at frame (private/path:10)' },
  ];
  const status = () => ({
    enabled,
    samples: 0,
    workerLines: enabled ? 2 : 0,
    bytes: 99,
    dropped: 0,
  });
  const get = vi.fn(async () => (enabled ? lines : []));
  window.lonelyChat = {
    getDiagnosticCapture: async () => status(),
    configureDiagnosticCapture: async (value: boolean) => {
      enabled = value;
      return status();
    },
    getPrivateWorkerLines: get,
  } as unknown as DesktopAPI;
  render(<DiagnosticCaptureControls />);
  expect(screen.queryByLabelText('Private native worker details')).toBeNull();
  fireEvent.click(await screen.findByRole('button', { name: 'Enable private diagnostic capture' }));
  expect(await screen.findByText(/Worker worker-one · 2 lines/)).toBeTruthy();
  fireEvent.click(screen.getByText(/Worker worker-one · 2 lines/));
  expect(screen.getByText(/stack trace first line/)).toBeTruthy();
  expect(screen.getByText(/private\/path:10/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Disable and discard samples' }));
  await waitFor(() => expect(screen.queryByLabelText('Private native worker details')).toBeNull());
  expect(enabled).toBe(false);
  expect(get).toHaveBeenCalled();
});
