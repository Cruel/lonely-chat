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
  it('shows partial/finalizing state, quota usage, and saves disk and memory limits', async () => {
    const status: CompactRecordingStatus = {
      ...idle,
      recordingId: 'recording-2026-10-19T01-00-00-000Z-12345678-1234-1234-1234-123456789012',
      partial: true,
      finalizing: 1,
      warning: 'Recording memory limit reached; later attempts are excluded.',
      limits: { diskBytes: 100 * 1024 ** 2, memoryBytes: 16 * 1024 ** 2 },
      bytes: 1024 ** 2,
      totalBytes: 10 * 1024 ** 2,
      memoryBytes: 256 * 1024,
    };
    const setLimits = vi.fn(async () => status);
    Object.defineProperty(window, 'lonelyChat', {
      configurable: true,
      value: {
        getCompactRecording: async () => status,
        setCompactRecordingLimits: setLimits,
        listCompactAttempts: async () => [],
      } as unknown as DesktopAPI,
    });
    render(<CompactRecordingControls />);
    expect(await screen.findByText(/Finishing 1 captured attempts/)).toBeInTheDocument();
    expect(screen.getByText(/10.00 MiB all recordings/)).toBeInTheDocument();
    expect(screen.getByText(/Recording memory limit reached/)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByLabelText('Recording disk limit (MiB)')).toHaveValue(100),
    );
    fireEvent.change(screen.getByLabelText('Recording disk limit (MiB)'), {
      target: { value: '200' },
    });
    fireEvent.change(screen.getByLabelText('Pending memory limit (MiB)'), {
      target: { value: '32' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save limits' }));
    await waitFor(() =>
      expect(setLimits).toHaveBeenCalledWith({
        diskBytes: 200 * 1024 ** 2,
        memoryBytes: 32 * 1024 ** 2,
        maxAgeDays: 30,
      }),
    );
  });

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
    await waitFor(() =>
      expect(configure).toHaveBeenCalledWith(true, 'exact', {
        retainMedia: false,
        retainContent: false,
      }),
    );
    expect(screen.getByLabelText('Capture mode')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'List recorded attempts' }));
    fireEvent.click(await screen.findByRole('button', { name: /attempt-1.*exact/ }));
    expect(
      await screen.findByRole('region', { name: 'Verified original submitted request' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save as rerunnable Playground case' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith('attempt-1', recordingId));
    expect(await screen.findByText(/Saved case saved-case-1/)).toBeInTheDocument();
  });
});
