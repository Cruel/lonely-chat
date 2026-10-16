// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesktopAPI } from '../../shared/chat-contract';
import { VideoInput } from './video-input';

Element.prototype.scrollIntoView = () => {};
const camera = {
  kind: 'videoinput',
  deviceId: 'test-camera',
  label: 'Test webcam',
} as MediaDeviceInfo;

function connect(media: {
  getUserMedia: ReturnType<typeof vi.fn>;
  enumerateDevices?: ReturnType<typeof vi.fn>;
}) {
  const selectVideoSource = vi.fn(async (_id: string | null) => {});
  const submitVideoFrame = vi.fn(async () => {});
  window.lonelyChat = {
    listDisplaySources: async () => [
      { id: 'display:screen:0:0', kind: 'screen', label: 'Main monitor' },
    ],
    selectVideoSource,
    submitVideoFrame,
  } as unknown as DesktopAPI;
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      enumerateDevices: media.enumerateDevices ?? vi.fn(async () => [camera]),
      getUserMedia: media.getUserMedia,
      getDisplayMedia: vi.fn(async () => {
        throw new Error('Unexpected screen capture');
      }),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
  return { selectVideoSource, submitVideoFrame };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete window.lonelyChat;
  Reflect.deleteProperty(navigator, 'mediaDevices');
});

async function selectCamera() {
  const user = userEvent.setup();
  await user.click(screen.getByRole('combobox', { name: 'Input device' }));
  await user.click(await screen.findByRole('option', { name: /Test webcam/ }));
  return user;
}

describe('live video input', () => {
  it('handles denied camera permission without endless retries and still allows turning video off', async () => {
    const getUserMedia = vi.fn(async () => {
      throw new DOMException('Permission denied', 'NotAllowedError');
    });
    const { selectVideoSource } = connect({ getUserMedia });
    render(<VideoInput />);
    const user = await selectCamera();
    await user.click(screen.getByRole('button', { name: 'Start video' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/permission denied/i);
    expect(screen.getByRole('status').textContent).toContain('error');
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(selectVideoSource).toHaveBeenCalledWith('camera:test-camera');
    await user.click(screen.getByRole('button', { name: 'Stop video' }));
    await waitFor(() => expect(selectVideoSource).toHaveBeenLastCalledWith(null));
    expect(screen.getByRole('status').textContent).toContain('off');
  });

  it('stops old tracks when disconnected and retries missing devices without stopping the simulation', async () => {
    let ended: (() => void) | null = null;
    const stop = vi.fn();
    const track = {
      stop,
      addEventListener: vi.fn((_type: string, listener: () => void) => {
        ended = listener;
      }),
    };
    const stream = {
      getTracks: () => [track],
      getVideoTracks: () => [track],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn(async () => stream);
    const { selectVideoSource } = connect({ getUserMedia });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    render(<VideoInput />);
    const user = await selectCamera();
    await user.click(screen.getByRole('button', { name: 'Start video' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('live'));
    expect(ended).not.toBeNull();
    fireEvent(screen.getByLabelText('Video input preview'), new Event('loadedmetadata'));
    vi.useFakeTimers();
    await act(async () => {
      ended?.();
    });
    expect(screen.getByRole('status').textContent).toContain('disconnected');
    expect(stop).toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(selectVideoSource).toHaveBeenCalledWith('camera:test-camera');
    vi.useRealTimers();
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('live'));
    await user.click(screen.getByRole('button', { name: 'Stop video' }));
    expect(stop.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('retries a screen that disappeared during selection and preserves its name', async () => {
    const { selectVideoSource } = connect({ getUserMedia: vi.fn() });
    let selectionAttempts = 0;
    selectVideoSource.mockImplementation(async (id) => {
      if (id === 'display:screen:0:0' && ++selectionAttempts === 1) {
        throw new Error('The selected screen or window is no longer available.');
      }
    });
    let ended: (() => void) | null = null;
    const track = {
      stop: vi.fn(),
      addEventListener: vi.fn((_event: string, listener: () => void) => {
        ended = listener;
      }),
    };
    const stream = {
      getTracks: () => [track],
      getVideoTracks: () => [track],
    } as unknown as MediaStream;
    const getDisplayMedia = vi.fn(async () => stream);
    Object.assign(navigator.mediaDevices, { getDisplayMedia });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    render(<VideoInput />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: 'Input device' }));
    await user.click(await screen.findByRole('option', { name: /Main monitor/ }));
    await waitFor(() => expect(selectionAttempts).toBe(1));
    expect(screen.getByRole('button', { name: 'Start video' }).hasAttribute('disabled')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Refresh sources' }));
    await waitFor(() => expect(selectionAttempts).toBe(2));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Start video' }).hasAttribute('disabled')).toBe(
        false,
      ),
    );
    // The display API must run synchronously inside the button's user gesture,
    // not from a React effect or after awaiting an Electron IPC call.
    fireEvent.click(screen.getByRole('button', { name: 'Start video' }));
    expect(getDisplayMedia).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('live'));
    expect(track.stop).not.toHaveBeenCalled();
    await act(async () => {
      ended?.();
    });
    expect(screen.getByRole('status').textContent).toContain('disconnected');
    expect(screen.getByRole('button', { name: 'Reconnect video' })).toBeTruthy();
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
    // Screen sharing cannot restart from a timer; a new click grants activation.
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect video' }));
    expect(getDisplayMedia).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('live'));
  });
});
