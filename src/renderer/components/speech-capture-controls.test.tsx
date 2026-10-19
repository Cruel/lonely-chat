// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SpeechCaptureControls } from './speech-capture-controls';
import type { SpeechCaptureStatus } from '../../shared/speech-capture-contract';

const empty: SpeechCaptureStatus = {
  enabled: false,
  bytes: 0,
  maxBytes: 64 * 1024 * 1024,
  pending: 0,
  records: [],
  warning: null,
};

afterEach(() => {
  cleanup();
  delete window.lonelyChat;
  vi.restoreAllMocks();
});

it('requires separate opt-in to capture raw PCM and shows no recorded clips by default', async () => {
  let change: (state: SpeechCaptureStatus) => void = () => {};
  const configure = vi.fn(async (enabled: boolean) => {
    const next = { ...empty, enabled };
    change(next);
    return next;
  });
  window.lonelyChat = {
    getSpeechCapture: async () => empty,
    configureSpeechCapture: configure,
    onSpeechCaptureChange: (listener: typeof change) => {
      change = listener;
      return () => {};
    },
  } as unknown as typeof window.lonelyChat;
  render(<SpeechCaptureControls />);
  expect(await screen.findByRole('button', { name: 'Enable raw audio capture' })).toBeTruthy();
  expect(screen.queryByLabelText('Saved raw speech clips')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Enable raw audio capture' }));
  await waitFor(() => expect(configure).toHaveBeenCalledExactlyOnceWith(true));
  expect(await screen.findByRole('button', { name: 'Stop raw audio capture' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Stop raw audio capture' }));
  await waitFor(() => expect(configure).toHaveBeenCalledWith(false));
});

it('shows source-labeled failed evidence and makes rerun, export and deletion explicit', async () => {
  const record: SpeechCaptureStatus['records'][number] = {
    id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
    sourceId: 'guest',
    captureId: 'capture-guest',
    sequence: 2,
    label: 'Guest',
    timeBase: 'input',
    startMs: 100,
    endMs: 900,
    observedAt: 1000,
    capturedAt: 1000,
    sampleRate: 16000,
    sampleCount: 12800,
    result: 'failed',
    text: null,
    error: 'Whisper unavailable',
    durationMs: 40,
    bytes: 50000,
  };
  const rerun = vi.fn(async () => {});
  const exporter = vi.fn(async () => true);
  const deleteClip = vi.fn(async () => ({ ...empty, records: [] }));
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  window.lonelyChat = {
    getSpeechCapture: async () => ({ ...empty, records: [record] }),
    configureSpeechCapture: async () => empty,
    deleteCapturedSpeech: deleteClip,
    clearCapturedSpeech: async () => empty,
    exportCapturedSpeech: exporter,
    onSpeechCaptureChange: () => () => {},
  } as unknown as typeof window.lonelyChat;
  render(<SpeechCaptureControls onRerun={rerun} />);
  expect(await screen.findByText('Whisper unavailable')).toBeTruthy();
  expect(screen.getByText('Guest (guest)')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Rerun in Speech Playground' }));
  await waitFor(() => expect(rerun).toHaveBeenCalledWith(record.id));
  fireEvent.click(screen.getByRole('button', { name: 'Export clip' }));
  await waitFor(() => expect(exporter).toHaveBeenCalledWith(record.id));
  fireEvent.click(screen.getByRole('button', { name: 'Delete clip' }));
  await waitFor(() => expect(deleteClip).toHaveBeenCalledWith(record.id));
});
