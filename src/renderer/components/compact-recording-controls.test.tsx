// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CompactRecordingControls } from './compact-recording-controls';
import type { DesktopAPI } from '../../shared/chat-contract';
import type {
  CompactRecordingStatus,
  CompactReconstruction,
} from '../../shared/compact-recording-contract';

const idle: CompactRecordingStatus = {
  enabled: false,
  mode: 'compact',
  recordingId: null,
  attempts: 0,
  chunks: 0,
  bytes: 0,
  error: null,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('persistent inference recording controls', () => {
  it('requires opt-in, offers Exact before recording, and saves verified requests to Playground cases', async () => {
    const recordingId = 'recording-2026-10-19T01-00-00-000Z-12345678-1234-1234-1234-123456789012';
    let state: CompactRecordingStatus = idle;
    const configure = vi.fn(async (enabled: boolean, mode?: 'compact' | 'exact') => {
      state = {
        ...idle,
        enabled,
        mode: mode ?? 'compact',
        recordingId: enabled ? recordingId : null,
      };
      return state;
    });
    const reconstruct: CompactReconstruction = {
      input: { context: 'live' },
      request: { seed: 77, messages: [{ role: 'system', content: 'historical prompt' }] },
      provenance: 'exact-recorded-request',
      warning: 'Verified original native request',
      currentBuilderVersion: 'new',
      recordedBuilderVersion: 'old',
      attempt: {
        recordingId,
        mode: 'exact',
        id: 'attempt-1',
        runId: 3,
        cycle: 1,
        attempt: 1,
        seed: 77,
        modelId: 'model',
        startedAt: 1,
        durationMs: 10,
        stage: 'failed',
        chunk: '00000001.jsonl.gz',
      },
    };
    const save = vi.fn(async () => ({ id: 'saved-case-1' }));
    Object.defineProperty(window, 'lonelyChat', {
      configurable: true,
      value: {
        getCompactRecording: async () => state,
        configureCompactRecording: configure,
        listCompactAttempts: async () => [reconstruct.attempt],
        reconstructCompactAttempt: async () => reconstruct,
        saveRecordedExactCase: save,
      } as unknown as DesktopAPI,
    });
    render(<CompactRecordingControls />);
    expect(screen.getByLabelText('Capture mode')).toHaveValue('compact');
    fireEvent.change(screen.getByLabelText('Capture mode'), { target: { value: 'exact' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start exact recording' }));
    await waitFor(() => expect(configure).toHaveBeenCalledWith(true, 'exact'));
    expect(screen.getByLabelText('Capture mode')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'List recorded attempts' }));
    fireEvent.click(await screen.findByRole('button', { name: /attempt-1.*exact/ }));
    expect(
      await screen.findByRole('region', { name: 'Verified original native request' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save as rerunnable Playground case' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith('attempt-1', recordingId));
    expect(await screen.findByText(/Saved Exact case saved-case-1/)).toBeInTheDocument();
  });
});
