// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef, useState } from 'react';
import userEvent from '@testing-library/user-event';
import type { DesktopAPI } from '../../shared/chat-contract';
import { RecordedVideoInput, type RecordedVideoMedia } from './recorded-video-input';
import type { RecordedAudioHandle } from './recorded-audio-input';
import { RecordedAudioInput } from './recorded-audio-input';

vi.mock('../media-fingerprint', () => ({
  mediaFingerprint: vi.fn(async () => 'a'.repeat(64)),
}));

const create = vi.fn((file: File | Blob) => {
  if (file instanceof File) return `blob:${file.name}`;
  return 'blob:worklet';
});
const revoke = vi.fn();

async function selectOption(label: string, option: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole('combobox', { name: label }));
  await user.click(await screen.findByRole('option', { name: option }));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  create.mockClear();
  revoke.mockClear();
  vi.unstubAllGlobals();
  delete window.lonelyChat;
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

it('does not opt a video into Whisper unless its audio is explicitly added; changing video discards the old source', async () => {
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  const selection = vi.fn();
  const start = vi.fn();
  window.lonelyChat = { startRecordedAudio: start } as unknown as DesktopAPI;
  const ref = createRef<RecordedAudioHandle>();
  function Harness() {
    const [video, setVideo] = useState<RecordedVideoMedia | null>(null);
    const [showVideo, setShowVideo] = useState(true);
    return (
      <>
        <button onClick={() => setShowVideo(false)}>Leave recorded simulation</button>
        {showVideo && (
          <RecordedVideoInput
            running={false}
            onSelectionChange={vi.fn()}
            onMediaChange={setVideo}
          />
        )}
        <RecordedAudioInput ref={ref} running={false} onSelectionChange={selection} video={video} />
      </>
    );
  }
  render(<Harness />);
  fireEvent.change(screen.getByLabelText('Video file'), {
    target: { files: [new File(['video'], 'scene.mp4', { type: 'video/mp4' })] },
  });
  expect(selection).toHaveBeenLastCalledWith({ ready: true, count: 0 });
  await ref.current!.prepare();
  expect(start).not.toHaveBeenCalled();
  await selectOption('Audio source type', 'Audio from video');
  fireEvent.click(screen.getByRole('button', { name: 'Add audio from video' }));
  const media = document.querySelector('audio')!;
  expect(media.getAttribute('src')).toBe('blob:scene.mp4');
  Object.defineProperty(media, 'duration', { configurable: true, value: 8 });
  Object.defineProperty(media, 'captureStream', {
    configurable: true,
    value: () => ({ getAudioTracks: () => [{ id: 'mixed' }] }),
  });
  fireEvent.loadedMetadata(media);
  await waitFor(() => expect(selection).toHaveBeenLastCalledWith({ ready: true, count: 1 }));
  expect((screen.getByLabelText('Source label') as HTMLInputElement).value).toBe(
    'Video soundtrack',
  );
  fireEvent.change(screen.getByLabelText('Offset (ms, signed)'), {
    target: { value: '-300' },
  });
  expect((screen.getByLabelText('Offset (ms, signed)') as HTMLInputElement).value).toBe('-300');
  fireEvent.click(screen.getByLabelText('Audio from scene.mp4'));
  expect(selection).toHaveBeenLastCalledWith({ ready: true, count: 0 });
  fireEvent.click(screen.getByLabelText('Audio from scene.mp4'));
  await waitFor(() => expect(selection).toHaveBeenLastCalledWith({ ready: true, count: 1 }));
  fireEvent.change(screen.getByLabelText('Video file'), {
    target: { files: [new File(['next'], 'next.mp4', { type: 'video/mp4' })] },
  });
  await waitFor(() => expect(selection).toHaveBeenLastCalledWith({ ready: true, count: 0 }));
  expect(document.querySelectorAll('audio')).toHaveLength(0);
  expect(revoke).toHaveBeenCalledWith('blob:scene.mp4'); // Only the video owner revokes it.
  fireEvent.click(screen.getByRole('button', { name: 'Add audio from video' }));
  expect(document.querySelectorAll('audio')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Leave recorded simulation' }));
  expect(document.querySelectorAll('audio')).toHaveLength(0);
  expect(
    screen.getByRole('button', { name: 'Add audio from video' }).hasAttribute('disabled'),
  ).toBe(true);
  expect(selection).toHaveBeenLastCalledWith({ ready: true, count: 0 });
});

it('rejects a video without accessible audio and allows disabling the invalid source', async () => {
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
  const selection = vi.fn();
  render(
    <RecordedAudioInput
      running={false}
      onSelectionChange={selection}
      video={{ url: 'blob:silent-video', name: 'silent.mp4' }}
    />,
  );
  await selectOption('Audio source type', 'Audio from video');
  fireEvent.click(screen.getByRole('button', { name: 'Add audio from video' }));
  const media = document.querySelector('audio')!;
  Object.defineProperty(media, 'duration', { configurable: true, value: 7 });
  Object.defineProperty(media, 'captureStream', {
    configurable: true,
    value: () => ({ getAudioTracks: () => [] }),
  });
  fireEvent.loadedMetadata(media);
  expect(
    await screen.findByText('This video has no accessible embedded audio soundtrack.'),
  ).toBeTruthy();
  expect(selection).toHaveBeenLastCalledWith({ ready: false, count: 1 });
  fireEvent.click(screen.getByLabelText('Audio from silent.mp4'));
  await waitFor(() => expect(selection).toHaveBeenLastCalledWith({ ready: true, count: 0 }));
});

it('validates the preview segment against the longest enabled source and closes pre-run decoders on Start', async () => {
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  const selection = vi.fn();
  const onSegmentChange = vi.fn();
  const ref = createRef<RecordedAudioHandle>();
  const props = { onSelectionChange: selection, onSegmentChange };
  const page = render(<RecordedAudioInput ref={ref} running={false} {...props} />);
  fireEvent.change(screen.getByLabelText('Add audio files'), {
    target: { files: [new File(['a'], 'mic.wav', { type: 'audio/wav' })] },
  });
  const tag = document.querySelector('audio')!;
  Object.defineProperty(tag, 'duration', { configurable: true, value: 10 });
  fireEvent.loadedMetadata(tag);
  await waitFor(() => expect(selection).toHaveBeenLastCalledWith({ ready: true, count: 1 }));
  fireEvent.change(screen.getByLabelText('Start (ms)'), { target: { value: '1500' } });
  fireEvent.change(screen.getByLabelText('End (ms, blank = automatic)'), {
    target: { value: '11500' },
  });
  expect(screen.getByRole('alert').textContent).toMatch(/not exceed/);
  expect(selection).toHaveBeenLastCalledWith({ ready: false, count: 1 });
  expect(screen.getByRole('button', { name: 'Open media preview' }).hasAttribute('disabled')).toBe(
    true,
  );
  fireEvent.change(screen.getByLabelText('End (ms, blank = automatic)'), {
    target: { value: '7500' },
  });
  await waitFor(() =>
    expect(onSegmentChange).toHaveBeenLastCalledWith({
      segment: { startMs: 1500, endMs: 7500 },
      valid: true,
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Open media preview' }));
  expect(screen.getByLabelText('Recorded media preview')).toBeTruthy();
  expect(screen.getByLabelText('Preview audio: mic')).toBeTruthy();
  page.rerender(<RecordedAudioInput ref={ref} running={true} {...props} />);
  expect(screen.queryByLabelText('Recorded media preview')).toBeNull();
});

it('rechecks cached transcript readiness whenever the selected speech model changes', async () => {
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
  vi.stubGlobal(
    'AudioContext',
    class {
      sampleRate = 48000;
      async close() {}
    },
  );
  let modelChanged: (() => void) | undefined;
  let available = true;
  const check = vi.fn(async () => ({
    available,
    reason: available ? 'ready' : 'stale',
    count: available ? 1 : 0,
  }));
  window.lonelyChat = {
    checkRecordedAudioCache: check,
    onModelsChange: (listener: () => void) => {
      modelChanged = listener;
      return () => {
        modelChanged = undefined;
      };
    },
  } as unknown as DesktopAPI;
  const selection = vi.fn();
  render(
    <RecordedAudioInput running={false} transcriptMode="cached" onSelectionChange={selection} />,
  );
  fireEvent.change(screen.getByLabelText('Add audio files'), {
    target: { files: [new File(['audio'], 'voice.wav', { type: 'audio/wav' })] },
  });
  const audio = document.querySelector('audio')!;
  Object.defineProperty(audio, 'duration', { configurable: true, value: 4 });
  fireEvent.loadedMetadata(audio);
  await waitFor(() => expect(selection).toHaveBeenLastCalledWith({ ready: true, count: 1 }));
  expect(check).toHaveBeenCalledTimes(1);
  available = false;
  act(() => modelChanged?.());
  await waitFor(() => expect(selection).toHaveBeenLastCalledWith({ ready: false, count: 1 }));
  expect(screen.getByText(/Saved transcripts for voice are stale/)).toBeTruthy();
  available = true;
  act(() => modelChanged?.());
  await waitFor(() => expect(selection).toHaveBeenLastCalledWith({ ready: true, count: 1 }));
  expect(check).toHaveBeenCalledTimes(3);
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
