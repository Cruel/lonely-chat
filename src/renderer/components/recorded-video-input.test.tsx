// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { createRef } from 'react';
import { RecordedVideoInput, type RecordedVideoHandle } from './recorded-video-input';
import type { DesktopAPI } from '../../shared/chat-contract';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete window.lonelyChat;
});

it('restores an authorized video path and blocks missing files until relink or removal', async () => {
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  const selection = vi.fn();
  const open = vi.fn(async (path: string) => {
    if (path.includes('missing')) throw new Error('ENOENT');
    return 'lonely-recorded-media://desktop/authorized';
  });
  window.lonelyChat = { openRecordedMedia: open } as unknown as DesktopAPI;
  const ref = createRef<RecordedVideoHandle>();
  const { rerender } = render(
    <RecordedVideoInput
      running={false}
      ref={ref}
      onSelectionChange={selection}
      restore={{ key: 'first', path: '/archive/video.mp4' }}
    />,
  );
  await waitFor(() =>
    expect(document.querySelector('video')?.getAttribute('src')).toContain('authorized'),
  );
  expect(ref.current?.snapshot()).toEqual({ path: '/archive/video.mp4', offsetMs: 0 });
  fireEvent.change(screen.getByLabelText(/Video offset/), { target: { value: '-1250' } });
  expect(ref.current?.snapshot()).toEqual({ path: '/archive/video.mp4', offsetMs: -1250 });
  rerender(
    <RecordedVideoInput
      running={false}
      ref={ref}
      onSelectionChange={selection}
      restore={{ key: 'missing', path: '/archive/missing.mp4' }}
    />,
  );
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Relink or remove'));
  expect(selection).toHaveBeenLastCalledWith({ hasFile: true, ready: false });
  fireEvent.click(screen.getByRole('button', { name: 'Remove video source' }));
  await waitFor(() => expect(selection).toHaveBeenLastCalledWith({ hasFile: false, ready: true }));
  expect(ref.current?.snapshot()).toBeNull();
});

it('validates a local file, plays at 1× and sends decoded JPEGs through trusted capture without touching inference', async () => {
  const select = vi.fn();
  const submit = vi.fn(async (_frame: import('../../shared/video-contract').VideoFrame) => {});
  const now = performance.timeOrigin + performance.now();
  window.lonelyChat = {
    getVideoClock: async () => now,
    submitVideoFrame: submit,
    reportRecordedVideoError: vi.fn(async () => {
      throw new Error('Not expected.');
    }),
  } as unknown as DesktopAPI;
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:recorded-test'),
    revokeObjectURL: vi.fn(),
  });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async function (
    this: HTMLMediaElement,
  ) {
    Object.defineProperty(this, 'paused', { configurable: true, value: false });
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(4);
  vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(640);
  vi.spyOn(HTMLVideoElement.prototype, 'videoHeight', 'get').mockReturnValue(360);
  const drawn = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: drawn,
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,/9j/');
  const ref = createRef<RecordedVideoHandle>();
  const { unmount } = render(
    <RecordedVideoInput running={false} ref={ref} onSelectionChange={select} />,
  );
  fireEvent.change(screen.getByLabelText('Video file'), {
    target: { files: [new File(['fake'], 'sample.mp4', { type: 'video/mp4' })] },
  });
  const video = document.querySelector('video')!;
  Object.defineProperty(video, 'duration', { configurable: true, value: 10 });
  fireEvent.canPlay(video);
  await waitFor(() => expect(select).toHaveBeenCalledWith({ hasFile: true, ready: true }));
  await ref.current!.begin(500);
  await waitFor(() => expect(submit).toHaveBeenCalledOnce());
  const sent = submit.mock.calls[0][0] as unknown as {
    sourceId: string;
    observedAt: number;
    mediaTimeMs: number;
    width: number;
    height: number;
    dataUrl: string;
  };
  expect(sent).toMatchObject({
    sourceId: 'recorded:video',
    mediaTimeMs: 0,
    width: 320,
    height: 180,
    dataUrl: 'data:image/jpeg;base64,/9j/',
  });
  expect(sent.observedAt).toBeGreaterThanOrEqual(now);
  expect(drawn).toHaveBeenCalledOnce();
  expect(document.querySelector('video')?.playbackRate).toBe(1);
  expect(document.querySelector('video')?.muted).toBe(true);
  ref.current!.stop();
  unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:recorded-test');
});

it('starts at the selected presentation timestamp and submits irregular decoded frame times', async () => {
  const select = vi.fn();
  const submit = vi.fn(async (_frame: import('../../shared/video-contract').VideoFrame) => {});
  const observedAt = performance.timeOrigin + performance.now();
  window.lonelyChat = {
    submitVideoFrame: submit,
    reportRecordedVideoError: vi.fn(),
  } as unknown as DesktopAPI;
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:recorded-clip'),
    revokeObjectURL: vi.fn(),
  });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async function (
    this: HTMLMediaElement,
  ) {
    Object.defineProperty(this, 'paused', { configurable: true, value: false });
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(4);
  vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(640);
  vi.spyOn(HTMLVideoElement.prototype, 'videoHeight', 'get').mockReturnValue(360);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,/9j/');
  const ref = createRef<RecordedVideoHandle>();
  render(<RecordedVideoInput ref={ref} running={false} onSelectionChange={select} />);
  fireEvent.change(screen.getByLabelText('Video file'), {
    target: { files: [new File(['fake'], 'variable.mp4', { type: 'video/mp4' })] },
  });
  const video = screen.getByLabelText('Video file').parentElement!.querySelector('video')!;
  Object.defineProperty(video, 'duration', { configurable: true, value: 10 });
  fireEvent.canPlay(video);
  await ref.current!.begin(
    100,
    { observedAt, monotonicMs: performance.now() },
    { startMs: 2500, endMs: 4000 },
  );
  await waitFor(() => expect(submit).toHaveBeenCalledOnce());
  expect(submit.mock.calls[0][0]).toMatchObject({
    sourceId: 'recorded:video',
    mediaTimeMs: 2500,
  });
  // This is a presentation timestamp, not a fabricated constant-FPS frame number.
  video.currentTime = 2.813;
  await waitFor(() => expect(submit.mock.calls.length).toBeGreaterThan(1));
  expect(submit.mock.calls[1][0]).toMatchObject({ mediaTimeMs: 2813 });
  ref.current!.stop();
});

it('rejects a decoder with unknown duration until metadata resolves', async () => {
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(640);
  vi.spyOn(HTMLVideoElement.prototype, 'videoHeight', 'get').mockReturnValue(360);
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:unknown'),
    revokeObjectURL: vi.fn(),
  });
  const selection = vi.fn();
  render(<RecordedVideoInput running={false} onSelectionChange={selection} />);
  fireEvent.change(screen.getByLabelText('Video file'), {
    target: { files: [new File(['file'], 'unknown-duration.mp4')] },
  });
  const video = document.querySelector('video')!;
  Object.defineProperty(video, 'duration', { configurable: true, value: Infinity, writable: true });
  fireEvent.canPlay(video);
  expect(screen.getByRole('alert').textContent).toContain('duration is unavailable');
  expect(selection).not.toHaveBeenCalledWith({ hasFile: true, ready: true });
  Object.defineProperty(video, 'duration', { configurable: true, value: 3 });
  fireEvent.durationChange(video);
  await waitFor(() => expect(selection).toHaveBeenCalledWith({ hasFile: true, ready: true }));
});

it('replays a previously ended video after a positive offset, then submits decoded frames', async () => {
  const submit = vi.fn(async (_frame: import('../../shared/video-contract').VideoFrame) => {});
  const onEnded = vi.fn();
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async function (
    this: HTMLMediaElement,
  ) {
    Object.defineProperty(this, 'paused', { configurable: true, value: false });
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(4);
  vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(640);
  vi.spyOn(HTMLVideoElement.prototype, 'videoHeight', 'get').mockReturnValue(360);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,/9j/');
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:replay-after-eof'),
    revokeObjectURL: vi.fn(),
  });
  window.lonelyChat = { submitVideoFrame: submit } as unknown as DesktopAPI;
  const ref = createRef<RecordedVideoHandle>();
  render(
    <RecordedVideoInput running={false} ref={ref} onSelectionChange={vi.fn()} onEnded={onEnded} />,
  );
  fireEvent.change(screen.getByLabelText('Video file'), {
    target: { files: [new File(['file'], 'previously-ended.mp4')] },
  });
  const video = document.querySelector('video')!;
  Object.defineProperty(video, 'duration', { configurable: true, value: 2 });
  Object.defineProperty(video, 'ended', {
    configurable: true,
    get: () => video.currentTime >= video.duration,
  });
  fireEvent.canPlay(video);
  fireEvent.change(screen.getByLabelText(/Video offset/), { target: { value: '150' } });
  // The decoder is still at EOF from the previous Run.
  video.currentTime = 2;
  expect(video.ended).toBe(true);
  await ref.current!.begin(
    25,
    { observedAt: performance.timeOrigin + performance.now(), monotonicMs: performance.now() },
    { startMs: 0, endMs: 800 },
  );
  expect(play).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
  await waitFor(() => expect(play).toHaveBeenCalledOnce(), { timeout: 1000 });
  await waitFor(() => expect(submit).toHaveBeenCalled(), { timeout: 1000 });
  expect(video.ended).toBe(false);
  expect(submit.mock.calls[0][0]).toMatchObject({
    sourceId: 'recorded:video',
    width: 320,
    height: 180,
  });
  expect(onEnded).not.toHaveBeenCalled();
  ref.current!.stop();
});

it('delays a positively offset video without capturing early frames and completes at the clip boundary', async () => {
  const submit = vi.fn(async () => {});
  const ended = vi.fn();
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async function (
    this: HTMLMediaElement,
  ) {
    Object.defineProperty(this, 'paused', { configurable: true, value: false });
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(4);
  vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(640);
  vi.spyOn(HTMLVideoElement.prototype, 'videoHeight', 'get').mockReturnValue(360);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,/9j/');
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:delayed'),
    revokeObjectURL: vi.fn(),
  });
  window.lonelyChat = { submitVideoFrame: submit } as unknown as DesktopAPI;
  const ref = createRef<RecordedVideoHandle>();
  render(
    <RecordedVideoInput running={false} ref={ref} onSelectionChange={vi.fn()} onEnded={ended} />,
  );
  fireEvent.change(screen.getByLabelText('Video file'), {
    target: { files: [new File(['file'], 'delayed.mp4')] },
  });
  const video = document.querySelector('video')!;
  Object.defineProperty(video, 'duration', { configurable: true, value: 2 });
  fireEvent.canPlay(video);
  fireEvent.change(screen.getByLabelText(/Video offset/), { target: { value: '150' } });
  await ref.current!.begin(
    25,
    {
      observedAt: performance.timeOrigin + performance.now(),
      monotonicMs: performance.now(),
    },
    { startMs: 0, endMs: 350 },
  );
  expect(play).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
  await waitFor(() => expect(play).toHaveBeenCalledOnce(), { timeout: 1000 });
  await waitFor(() => expect(submit).toHaveBeenCalled(), { timeout: 1000 });
  await waitFor(() => expect(ended).toHaveBeenCalledOnce(), { timeout: 1000 });
  fireEvent.ended(video);
  expect(ended).toHaveBeenCalledOnce();
});

it('skips an entirely expired video offset without starting its decoder or waiting for EOF', async () => {
  const submit = vi.fn();
  const ended = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(4);
  vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(640);
  vi.spyOn(HTMLVideoElement.prototype, 'videoHeight', 'get').mockReturnValue(360);
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:expired'),
    revokeObjectURL: vi.fn(),
  });
  window.lonelyChat = { submitVideoFrame: submit } as unknown as DesktopAPI;
  const ref = createRef<RecordedVideoHandle>();
  render(
    <RecordedVideoInput running={false} ref={ref} onSelectionChange={vi.fn()} onEnded={ended} />,
  );
  fireEvent.change(screen.getByLabelText('Video file'), {
    target: { files: [new File(['file'], 'expired.mp4')] },
  });
  const video = document.querySelector('video')!;
  Object.defineProperty(video, 'duration', { configurable: true, value: 2 });
  fireEvent.canPlay(video);
  fireEvent.change(screen.getByLabelText(/Video offset/), { target: { value: '-3000' } });
  await ref.current!.begin(100, { observedAt: 10000, monotonicMs: performance.now() });
  expect(ended).toHaveBeenCalledOnce();
  fireEvent.ended(video);
  expect(ended).toHaveBeenCalledOnce();
  expect(play).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
});

it('shows an actionable unsupported-codec message and disallows starting with an undecodable file', async () => {
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:unsupported'),
    revokeObjectURL: vi.fn(),
  });
  const selection = vi.fn();
  render(<RecordedVideoInput running={false} onSelectionChange={selection} />);
  fireEvent.change(screen.getByLabelText('Video file'), {
    target: { files: [new File(['bad'], 'unreadable.mkv')] },
  });
  const video = document.querySelector('video')!;
  Object.defineProperty(video, 'error', { configurable: true, value: { code: 4, message: '' } });
  fireEvent.error(video);
  expect(screen.getByRole('alert').textContent).toContain('Unsupported video container or codec');
  await waitFor(() => expect(selection).toHaveBeenCalledWith({ hasFile: true, ready: false }));
});
