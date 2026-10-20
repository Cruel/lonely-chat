// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { VideoInferenceSettings } from './video-inference-settings';
import { DEFAULT_NATIVE_VIDEO_PREFERENCES } from '../../shared/video-tools-contract';

afterEach(() => {
  cleanup();
  delete window.lonelyChat;
});

it('loads persistent defaults, validates changes and applies native video settings', async () => {
  const status = {
    available: true,
    directory: '/usr/bin',
    configuredDirectory: null,
    error: null,
    version: 'ffmpeg version 7',
    preferences: DEFAULT_NATIVE_VIDEO_PREFERENCES,
  };
  const configure = vi.fn(async (preferences: typeof DEFAULT_NATIVE_VIDEO_PREFERENCES) => ({
    ...status,
    preferences,
  }));
  window.lonelyChat = {
    getVideoTools: async () => status,
    configureNativeVideoPreferences: configure,
  } as unknown as NonNullable<typeof window.lonelyChat>;
  render(<VideoInferenceSettings />);
  const fps = await screen.findByLabelText(/Video FPS/);
  expect((fps as HTMLInputElement).value).toBe('4');
  fireEvent.change(fps, { target: { value: '8' } });
  fireEvent.change(screen.getByLabelText(/Timestamp interval/), {
    target: { value: '2000' },
  });
  fireEvent.change(screen.getByLabelText(/Max clip size/), {
    target: { value: '100' },
  });
  fireEvent.change(screen.getByLabelText(/Max clip duration/), {
    target: { value: '60' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save native-video defaults' }));
  await waitFor(() =>
    expect(configure).toHaveBeenCalledWith({
      fps: 8,
      timestampIntervalMs: 2000,
      maxClipSizeMiB: 100,
      maxClipDurationSeconds: 60,
    }),
  );
  fireEvent.change(fps, { target: { value: '99' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save native-video defaults' }));
  expect(configure).toHaveBeenCalledTimes(1);
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    expect.stringMatching(/fps/),
  );
});
