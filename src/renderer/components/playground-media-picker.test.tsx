// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

it('retains the shared visual token cap while switching between frame and native-video modes', () => {
  setup();
  function Harness() {
    const [mode, setMode] = useState<'frames' | 'native-video'>('frames');
    const [imageMaxTokens, setImageMaxTokens] = useState<number | null>(null);
    return (
      <PlaygroundMediaPicker
        frames={[]}
        onChange={() => {}}
        mode={mode}
        onModeChange={setMode}
        imageMaxTokens={imageMaxTokens}
        onImageMaxTokensChange={setImageMaxTokens}
      />
    );
  }
  render(<Harness />);
  const budget = screen.getByLabelText('Max visual tokens per image') as HTMLSelectElement;
  expect(budget.value).toBe('global');
  fireEvent.change(budget, { target: { value: '32' } });
  expect(budget.value).toBe('32');
  fireEvent.change(screen.getByLabelText('Video inference mode'), {
    target: { value: 'native-video' },
  });
  expect(budget.value).toBe('32');
  fireEvent.change(budget, { target: { value: '0' } });
  expect(budget.value).toBe('0');
  fireEvent.change(screen.getByLabelText('Video inference mode'), {
    target: { value: 'frames' },
  });
  expect(budget.value).toBe('0');
  fireEvent.change(budget, { target: { value: 'global' } });
  expect(budget.value).toBe('global');
});

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

it('uses updated saved clip-duration defaults without restarting an already mounted Playground', async () => {
  setup();
  const clip = {
    token: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    name: 'long-clip.mp4',
    durationSeconds: 25,
    sizeBytes: 1024,
  };
  let defaults: NativeVideoPreferences = DEFAULT_NATIVE_VIDEO_PREFERENCES;
  let notify:
    | ((status: import('../../shared/video-tools-contract').VideoToolsStatus) => void)
    | null = null;
  const unsubscribed = vi.fn();
  const status = () => ({
    available: true,
    directory: '/usr/bin',
    configuredDirectory: null,
    version: 'ffmpeg version 7.1',
    error: null,
    preferences: defaults,
  });
  const choose = vi.fn(async (override?: NativeVideoPreferences) => {
    if ((override ?? defaults).maxClipDurationSeconds < clip.durationSeconds)
      throw new Error('Video exceeds current duration limit.');
    return clip;
  });
  window.lonelyChat = {
    getVideoTools: async () => status(),
    onVideoToolsChange: (listener: typeof notify) => {
      notify = listener;
      return unsubscribed;
    },
    choosePlaygroundVideo: choose,
  } as unknown as NonNullable<typeof window.lonelyChat>;
  const changeMode = () => {};
  function Harness() {
    const [selectedVideo, setSelectedVideo] = useState<typeof clip | null>(null);
    return (
      <PlaygroundMediaPicker
        frames={[]}
        onChange={() => {}}
        mode="native-video"
        onModeChange={changeMode}
        onVideoOptionsChange={() => {}}
        selectedVideo={selectedVideo}
        onVideoChange={setSelectedVideo}
      />
    );
  }
  const view = render(<Harness />);
  await screen.findByText(/max 15 s/);
  defaults = { ...defaults, maxClipDurationSeconds: 30 };
  act(() => notify?.(status()));
  expect(screen.getByText(/max 30 s/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Choose native video clip…' }));
  await waitFor(() => expect(choose).toHaveBeenCalledWith(undefined));
  expect(await screen.findByText(/long-clip.mp4/)).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  view.unmount();
  expect(unsubscribed).toHaveBeenCalledOnce();
  delete window.lonelyChat;
});

it('refreshes all native-video defaults and FFmpeg directory on an open picker, while preserving explicit overrides', async () => {
  setup();
  const first = { ...DEFAULT_NATIVE_VIDEO_PREFERENCES };
  let status = {
    available: true,
    directory: '/old/ffmpeg',
    configuredDirectory: '/old/ffmpeg',
    version: 'ffmpeg version 7',
    error: null,
    preferences: first,
  };
  let notify: ((snapshot: typeof status) => void) | undefined;
  const choose = vi.fn(async (_options?: NativeVideoPreferences) => null);
  const onVideoToolsChange = vi.fn((listener: typeof notify) => {
    notify = listener;
    return () => {};
  });
  window.lonelyChat = {
    getVideoTools: async () => status,
    onVideoToolsChange,
    choosePlaygroundVideo: choose,
  } as unknown as NonNullable<typeof window.lonelyChat>;
  const changeMode = () => {};
  function Harness() {
    const [override, setOverride] = useState<NativeVideoPreferences | null>(null);
    return (
      <PlaygroundMediaPicker
        frames={[]}
        onChange={() => {}}
        mode="native-video"
        onModeChange={changeMode}
        videoOptions={override}
        onVideoOptionsChange={setOverride}
      />
    );
  }
  render(<Harness />);
  await screen.findByText(/FFmpeg detected: \/old\/ffmpeg/);
  const fresh = {
    fps: 8,
    timestampIntervalMs: 2000,
    maxClipSizeMiB: 80,
    maxClipDurationSeconds: 30,
  };
  act(() => {
    status = {
      ...status,
      directory: '/new/ffmpeg',
      configuredDirectory: '/new/ffmpeg',
      preferences: fresh,
    };
    notify?.(status);
  });
  expect(screen.getByText(/FFmpeg detected: \/new\/ffmpeg/)).toBeTruthy();
  expect(screen.getByText(/8 FPS, timestamp interval 2000 ms, max 80 MiB, max 30 s/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Choose native video clip…' }));
  await waitFor(() => expect(choose).toHaveBeenLastCalledWith(undefined));
  fireEvent.click(screen.getByLabelText('Override native video defaults'));
  expect((screen.getByLabelText(/Video FPS/) as HTMLInputElement).value).toBe('8');
  expect((screen.getByLabelText(/Timestamp interval/) as HTMLInputElement).value).toBe('2000');
  expect((screen.getByLabelText(/Max clip size/) as HTMLInputElement).value).toBe('80');
  expect((screen.getByLabelText(/Max clip duration/) as HTMLInputElement).value).toBe('30');
  fireEvent.change(screen.getByLabelText(/Video FPS/), { target: { value: '12' } });
  const newer = {
    fps: 10,
    timestampIntervalMs: 3000,
    maxClipSizeMiB: 100,
    maxClipDurationSeconds: 60,
  };
  act(() => {
    status = { ...status, preferences: newer };
    notify?.(status);
  });
  expect(screen.getByText(/12 FPS, timestamp interval 2000 ms, max 80 MiB, max 30 s/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Choose native video clip…' }));
  await waitFor(() => expect(choose).toHaveBeenLastCalledWith({ ...fresh, fps: 12 }));
  fireEvent.click(screen.getByLabelText('Override native video defaults'));
  expect(
    screen.getByText(/10 FPS, timestamp interval 3000 ms, max 100 MiB, max 60 s/),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Choose native video clip…' }));
  await waitFor(() => expect(choose).toHaveBeenLastCalledWith(undefined));
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
