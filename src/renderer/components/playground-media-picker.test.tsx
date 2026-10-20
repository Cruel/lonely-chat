// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PlaygroundFrame } from '../../shared/playground-media-contract';
import {
  DEFAULT_NATIVE_VIDEO_PREFERENCES,
  type NativeVideoPreferences,
} from '../../shared/video-tools-contract';
import { PlaygroundMediaPicker } from './playground-media-picker';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (Image.prototype as { decode?: () => Promise<void> }).decode;
});

function setup(onChange = vi.fn<(frames: PlaygroundFrame[]) => void>()) {
  const revoke = vi.fn();
  let sequence = 0;
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => `blob:playground-${++sequence}`),
    revokeObjectURL: revoke,
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,/9j/');
  return { onChange, revoke };
}

it('selects an opaque native clip without passing source bytes through renderer state', async () => {
  setup();
  const selected = {
    token: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    name: 'recorded.webm',
    durationSeconds: 4,
    sizeBytes: 1234,
  };
  const choose = vi.fn(async (_options?: NativeVideoPreferences) => selected);
  window.lonelyChat = {
    getVideoTools: async () => ({
      available: true,
      directory: '/usr/bin',
      configuredDirectory: null,
      version: 'ffmpeg version 7.1',
      error: null,
      preferences: DEFAULT_NATIVE_VIDEO_PREFERENCES,
    }),
    choosePlaygroundVideo: choose,
  } as unknown as NonNullable<typeof window.lonelyChat>;
  function Harness() {
    const [mode, setMode] = useState<'frames' | 'native-video'>('frames');
    const [video, setVideo] = useState<typeof selected | null>(null);
    const [options, setOptions] = useState<NativeVideoPreferences | null>(null);
    return (
      <PlaygroundMediaPicker
        frames={[]}
        onChange={() => {}}
        mode={mode}
        onModeChange={setMode}
        selectedVideo={video}
        onVideoChange={setVideo}
        videoOptions={options}
        onVideoOptionsChange={setOptions}
      />
    );
  }
  render(<Harness />);
  fireEvent.change(screen.getByLabelText('Video inference mode'), {
    target: { value: 'native-video' },
  });
  await screen.findByText(/FFmpeg detected/);
  fireEvent.click(screen.getByLabelText('Override native video defaults'));
  fireEvent.change(screen.getByLabelText(/Video FPS/), { target: { value: '8' } });
  fireEvent.change(screen.getByLabelText(/Max clip size/), { target: { value: '42' } });
  fireEvent.click(screen.getByRole('button', { name: 'Choose native video clip…' }));
  await waitFor(() =>
    expect(choose).toHaveBeenCalledWith({
      ...DEFAULT_NATIVE_VIDEO_PREFERENCES,
      fps: 8,
      maxClipSizeMiB: 42,
    }),
  );
  expect(await screen.findByText(/recorded.webm/)).toBeTruthy();
  expect(screen.queryByLabelText('Import images')).toBeNull();
  delete window.lonelyChat;
});

it('selects the currently decoded video frame at the actual timestamp, supports reordering/removal and cleans up the source', async () => {
  const { revoke } = setup();
  function Harness() {
    const [frames, setFrames] = useState<PlaygroundFrame[]>([]);
    return <PlaygroundMediaPicker frames={frames} onChange={setFrames} />;
  }
  const view = render(<Harness />);
  fireEvent.change(screen.getByLabelText('Video file'), {
    target: { files: [new File(['video'], 'scene.mp4', { type: 'video/mp4' })] },
  });
  const video = document.querySelector('video')!;
  vi.spyOn(video, 'duration', 'get').mockReturnValue(42);
  vi.spyOn(video, 'videoWidth', 'get').mockReturnValue(640);
  vi.spyOn(video, 'videoHeight', 'get').mockReturnValue(360);
  vi.spyOn(video, 'readyState', 'get').mockReturnValue(4);
  let playbackPosition = 9.5;
  vi.spyOn(video, 'currentTime', 'get').mockImplementation(() => playbackPosition);
  fireEvent.loadedData(video);
  fireEvent.click(screen.getByRole('button', { name: 'Add current video frame' }));
  expect(await screen.findByAltText('Selected frame 1')).toBeTruthy();
  playbackPosition = 1.25;
  fireEvent.click(screen.getByRole('button', { name: 'Add current video frame' }));
  expect(screen.getByText(/1.250 s/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Move frame 2 up' }));
  expect(screen.getByText(/1.250 s/).closest('div')?.parentElement?.textContent).toMatch(/1\./);
  fireEvent.click(screen.getByRole('button', { name: 'Remove frame 1' }));
  expect(screen.queryByText(/1.250 s/)).toBeNull();
  view.unmount();
  expect(revoke).toHaveBeenCalledWith('blob:playground-1');
});

it('blocks an undecodable video, oversized source and pending seek without submitting phantom frames', () => {
  const { onChange } = setup();
  render(<PlaygroundMediaPicker frames={[]} onChange={onChange} />);
  fireEvent.change(screen.getByLabelText('Video file'), {
    target: { files: [new File(['invalid'], 'broken.mkv', { type: 'video/x-matroska' })] },
  });
  const video = document.querySelector('video')!;
  fireEvent.error(video);
  expect(screen.getByRole('alert').textContent).toMatch(/cannot decode/);
  expect(
    screen.getByRole('button', { name: 'Add current video frame' }).hasAttribute('disabled'),
  ).toBe(true);
  expect(onChange).not.toHaveBeenCalled();
});

it('imports images after real decode, bounds dimensions and submits only JPEG snapshots', async () => {
  const { onChange, revoke } = setup();
  Object.defineProperty(Image.prototype, 'decode', {
    configurable: true,
    value: async () => {},
  });
  vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockReturnValue(400);
  render(<PlaygroundMediaPicker frames={[]} onChange={onChange} />);
  fireEvent.change(screen.getByLabelText('Import images'), {
    target: { files: [new File(['image'], 'scene.png', { type: 'image/png' })] },
  });
  await waitFor(() => expect(onChange).toHaveBeenCalledOnce());
  expect(onChange.mock.calls[0][0]).toEqual([
    {
      sourceId: 'image:scene.png',
      width: 640,
      height: 320,
      dataUrl: 'data:image/jpeg;base64,/9j/',
    },
  ]);
  expect(revoke).toHaveBeenCalledWith('blob:playground-1');
});

it('cancels image import after a replacement selection and revokes temporary URLs', async () => {
  const { onChange, revoke } = setup();
  let finish!: () => void;
  Object.defineProperty(Image.prototype, 'decode', {
    configurable: true,
    value: () =>
      new Promise<void>((resolve) => {
        finish = () => resolve();
      }),
  });
  const view = render(<PlaygroundMediaPicker frames={[]} onChange={onChange} />);
  fireEvent.change(screen.getByLabelText('Import images'), {
    target: { files: [new File(['image'], 'a.png', { type: 'image/png' })] },
  });
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  fireEvent.change(screen.getByLabelText('Video file'), { target: { files: [] } });
  finish();
  await waitFor(() => expect(revoke).toHaveBeenCalledWith('blob:playground-1'));
  expect(onChange).not.toHaveBeenCalled();
  view.unmount();
});
