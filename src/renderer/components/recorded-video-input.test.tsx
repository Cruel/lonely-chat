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
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
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
  fireEvent.canPlay(document.querySelector('video')!);
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
