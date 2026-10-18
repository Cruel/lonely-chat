// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RecordedAudioInput } from './recorded-audio-input';

const create = vi.fn((file: File | Blob) => {
  if (file instanceof File) return `blob:${file.name}`;
  return 'blob:worklet';
});
const revoke = vi.fn();

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  create.mockClear();
  revoke.mockClear();
});

it('configures multiple independent file tracks, labels, offsets, enabled state and decoder readiness', async () => {
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
  const selection = vi.fn();
  render(<RecordedAudioInput running={false} onSelectionChange={selection} />);
  const fileInput = screen.getByLabelText('Add audio files');
  fireEvent.change(fileInput, {
    target: {
      files: [
        new File(['a'], 'mic.wav', { type: 'audio/wav' }),
        new File(['b'], 'discord.flac', { type: 'audio/flac' }),
      ],
    },
  });
  const sources = screen.getAllByLabelText('Source label') as HTMLInputElement[];
  expect(sources.map((item) => item.value)).toEqual(['mic', 'discord']);
  expect(screen.getAllByLabelText('Offset (ms, signed)')).toHaveLength(2);
  const media = document.querySelectorAll('audio');
  expect(media).toHaveLength(2);
  Object.defineProperty(media[0], 'duration', { configurable: true, value: 4 });
  Object.defineProperty(media[1], 'duration', { configurable: true, value: 3 });
  fireEvent.loadedMetadata(media[0]);
  fireEvent.loadedMetadata(media[1]);
  await waitFor(() => expect(selection).toHaveBeenLastCalledWith({ ready: true, count: 2 }));
  fireEvent.change(sources[1], { target: { value: '' } });
  await waitFor(() => expect(selection).toHaveBeenLastCalledWith({ ready: false, count: 2 }));
  fireEvent.change(sources[1], { target: { value: 'Guest Discord' } });
  await waitFor(() => expect(selection).toHaveBeenLastCalledWith({ ready: true, count: 2 }));
  fireEvent.change(screen.getAllByLabelText('Offset (ms, signed)')[1], {
    target: { value: '-2350' },
  });
  expect((screen.getAllByLabelText('Source label')[1] as HTMLInputElement).value).toBe(
    'Guest Discord',
  );
  expect((screen.getAllByLabelText('Offset (ms, signed)')[1] as HTMLInputElement).value).toBe(
    '-2350',
  );
  fireEvent.click(screen.getByLabelText('mic.wav'));
  await waitFor(() => expect(selection).toHaveBeenLastCalledWith({ ready: true, count: 1 }));
  const buttons = screen.getAllByRole('button', { name: 'Remove' });
  fireEvent.click(buttons[0]);
  expect(revoke).toHaveBeenCalledWith('blob:mic.wav');
  expect(screen.getAllByLabelText('Source label')).toHaveLength(1);
});

it('blocks undecodable enabled files but does not block other enabled files when disabled', async () => {
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
  const selection = vi.fn();
  render(<RecordedAudioInput running={false} onSelectionChange={selection} />);
  fireEvent.change(screen.getByLabelText('Add audio files'), {
    target: { files: [new File(['broken'], 'broken.wav', { type: 'audio/wav' })] },
  });
  expect(selection).toHaveBeenLastCalledWith({ ready: false, count: 1 });
  fireEvent.error(document.querySelector('audio')!);
  expect(await screen.findByText(/File cannot be decoded by Chromium/)).toBeTruthy();
  fireEvent.click(screen.getByLabelText('broken.wav'));
  await waitFor(() => expect(selection).toHaveBeenLastCalledWith({ ready: true, count: 0 }));
});
