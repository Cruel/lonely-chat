// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import type { DesktopAPI } from '../../shared/chat-contract';
import type { PreviewTrack } from '../recorded-preview-timeline';
import { RecordedMediaPreview } from './recorded-media-preview';

const tracks: PreviewTrack[] = [
  {
    id: 'a',
    url: 'blob:mic',
    label: 'Mic',
    enabled: true,
    offsetMs: -250,
    durationMs: 5000,
    embeddedTrackIndex: null,
  },
  {
    id: 'b',
    url: 'blob:guest',
    label: 'Guest',
    enabled: true,
    offsetMs: 550,
    durationMs: 2500,
    embeddedTrackIndex: null,
  },
  {
    id: 'c',
    url: 'blob:silent',
    label: 'Silent',
    enabled: false,
    offsetMs: 0,
    durationMs: null,
    embeddedTrackIndex: null,
  },
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete window.lonelyChat;
});

it('scrubs video and every enabled audio against PTS and signed offsets without submitting inference or chat', () => {
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  const publish = vi.fn();
  const submitAudio = vi.fn();
  const submitVideo = vi.fn();
  window.lonelyChat = {
    publishSample: publish,
    submitVideoFrame: submitVideo,
    submitRecordedAudioPcm: submitAudio,
  } as unknown as DesktopAPI;
  render(
    <RecordedMediaPreview
      video={{ url: 'blob:scene', name: 'scene.mp4', durationMs: 8000 }}
      tracks={tracks}
      segment={{ startMs: 500, endMs: 3000 }}
      durationMs={8000}
      onClose={vi.fn()}
    />,
  );
  const video = screen.getByLabelText('Preview video') as HTMLVideoElement;
  const mic = screen.getByLabelText('Preview audio: Mic') as HTMLAudioElement;
  const guest = screen.getByLabelText('Preview audio: Guest') as HTMLAudioElement;
  expect(screen.queryByLabelText('Preview audio: Silent')).toBeNull();
  fireEvent.change(screen.getByLabelText('Seek (ms)'), { target: { value: '775' } });
  expect(video.currentTime).toBeCloseTo(0.775);
  expect(mic.currentTime).toBeCloseTo(1.025);
  expect(guest.currentTime).toBeCloseTo(0.225);
  fireEvent.change(screen.getByLabelText('Seek (ms)'), { target: { value: '500' } });
  expect(guest.currentTime).toBeCloseTo(0.225); // Gap before guest's 550-ms offset.
  expect(mic.muted).toBe(true);
  expect(guest.muted).toBe(true);
  expect(submitAudio).not.toHaveBeenCalled();
  expect(submitVideo).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
});

it('keeps monitoring muted unless explicitly enabled; solo suppresses other monitored tracks', async () => {
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async function (
    this: HTMLMediaElement,
  ) {
    Object.defineProperty(this, 'paused', { configurable: true, value: false });
  });
  const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    Object.defineProperty(this, 'paused', { configurable: true, value: true });
  });
  render(
    <RecordedMediaPreview
      video={null}
      tracks={tracks}
      segment={{ startMs: 0, endMs: 2000 }}
      durationMs={5000}
      onClose={vi.fn()}
    />,
  );
  const mic = screen.getByLabelText('Preview audio: Mic') as HTMLAudioElement;
  const guest = screen.getByLabelText('Preview audio: Guest') as HTMLAudioElement;
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Play preview' }));
  });
  expect(play).toHaveBeenCalled();
  expect(mic.muted).toBe(true);
  expect(guest.muted).toBe(true);
  fireEvent.click(screen.getByLabelText('Monitor Mic'));
  fireEvent.click(screen.getByLabelText('Monitor Guest'));
  fireEvent.change(screen.getByLabelText('Volume Mic'), { target: { value: '35' } });
  fireEvent.change(screen.getByLabelText('Seek (ms)'), { target: { value: '1000' } });
  fireEvent.click(screen.getByLabelText('Solo Guest'));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 130));
  });
  expect(mic.muted).toBe(true);
  expect(guest.muted).toBe(false);
  expect(guest.volume).toBe(1);
  fireEvent.click(screen.getByLabelText('Solo Guest'));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 130));
  });
  expect(mic.muted).toBe(false);
  expect(mic.volume).toBeCloseTo(0.35);
  // A React render to update monitoring must not detach/pause an active decoder.
  expect(pause.mock.instances).not.toContain(mic);
  fireEvent.click(screen.getByRole('button', { name: 'Pause preview' }));
  expect(pause).toHaveBeenCalled();
});

it('pauses independent decoders on close and never touches recorded session APIs', async () => {
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async function (
    this: HTMLMediaElement,
  ) {
    Object.defineProperty(this, 'paused', { configurable: true, value: false });
  });
  const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    Object.defineProperty(this, 'paused', { configurable: true, value: true });
  });
  const start = vi.fn();
  const frame = vi.fn();
  window.lonelyChat = {
    startRecordedAudio: start,
    submitVideoFrame: frame,
  } as unknown as DesktopAPI;
  function Harness() {
    const [open, setOpen] = useState(true);
    return open ? (
      <RecordedMediaPreview
        video={{ url: 'blob:scene', name: 'scene.mp4', durationMs: 10000 }}
        tracks={tracks}
        segment={{ startMs: 0, endMs: 3000 }}
        durationMs={10000}
        onClose={() => setOpen(false)}
      />
    ) : (
      <p>Preview closed</p>
    );
  }
  render(<Harness />);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Play preview' }));
  });
  expect(play).toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
  expect(screen.getByText('Preview closed')).toBeTruthy();
  expect(pause).toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
  expect(frame).not.toHaveBeenCalled();
});
