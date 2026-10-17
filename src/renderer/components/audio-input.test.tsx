// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesktopAPI } from '../../shared/chat-contract';
import type { AudioStatus } from '../../shared/audio-contract';
import { AudioInput } from './audio-input';

Element.prototype.scrollIntoView = () => {};
const devices = [
  { kind: 'audioinput', deviceId: 'mic-1', label: 'Streamer microphone' },
  { kind: 'audioinput', deviceId: 'mic-2', label: 'Voice chat' },
] as MediaDeviceInfo[];
const empty: AudioStatus = { revision: 0, sources: [], transcripts: [] };

function connect(getUserMedia: ReturnType<typeof vi.fn>, windowsLoopback = false) {
  let listener: ((status: AudioStatus) => void) | undefined;
  let stopMedia = () => {};
  const active = new Map<string, AudioStatus['sources'][number]>();
  let listedDevices: MediaDeviceInfo[] = devices;
  const deviceListeners = new Set<() => void>();
  const startAudio = vi.fn(
    async (id: string, sourceId: string, label: string, _captureId: string) => {
      active.set(id, { id, sourceId, label, phase: 'ready', error: null, pendingSegments: 0 });
      const snapshot = { revision: 1, transcripts: [], sources: [...active.values()] };
      listener?.(snapshot);
      return snapshot;
    },
  );
  const stopAudio = vi.fn(async () => empty);
  const audioDisconnected = vi.fn(async () => empty);
  const setAudioLabel = vi.fn(async () => empty);
  const removeAudioInput = vi.fn(async () => empty);
  window.lonelyChat = {
    onMediaStop: (listener: () => void) => {
      stopMedia = listener;
      return () => {
        stopMedia = () => {};
      };
    },
    getAudioConfiguration: async () => [],
    setAudioConfiguration: async (
      inputs: import('../../shared/audio-contract').AudioInputConfiguration[],
    ) => inputs,
    getAudioStatus: async () => empty,
    getAudioCapabilities: async () => ({ windowsLoopback }),
    onAudioChange: (callback: (status: AudioStatus) => void) => {
      listener = callback;
      return () => {
        listener = undefined;
      };
    },
    startAudio,
    stopAudio,
    setAudioLabel,
    audioDisconnected,
    removeAudioInput,
    submitAudioSegment: async () => {},
  } as unknown as DesktopAPI;
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      enumerateDevices: vi.fn(async () => listedDevices),
      getUserMedia,
      getDisplayMedia: vi.fn(),
      addEventListener: vi.fn((type: string, listener: () => void) => {
        if (type === 'devicechange') deviceListeners.add(listener);
      }),
      removeEventListener: vi.fn((type: string, listener: () => void) => {
        if (type === 'devicechange') deviceListeners.delete(listener);
      }),
    },
  });
  return {
    stopMedia: () => stopMedia(),
    startAudio,
    stopAudio,
    setAudioLabel,
    audioDisconnected,
    removeAudioInput,
    changeDevices: (items: MediaDeviceInfo[]) => {
      listedDevices = items;
      for (const listener of deviceListeners) listener();
    },
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete window.lonelyChat;
  Reflect.deleteProperty(navigator, 'mediaDevices');
});

async function addDevice(user: ReturnType<typeof userEvent.setup>, number: number, device: string) {
  await user.click(screen.getByRole('button', { name: 'Add audio input' }));
  const boxes = screen.getAllByRole('combobox', { name: 'Input device' });
  await user.click(boxes[number - 1]!);
  await user.click(await screen.findByRole('option', { name: device }));
}

describe('multiple microphone inputs', () => {
  it('starts with zero capture, handles permissions, and exposes platform loopback fallback', async () => {
    const getUserMedia = vi.fn(async () => {
      throw new DOMException('Permission denied', 'NotAllowedError');
    });
    const { startAudio } = connect(getUserMedia);
    render(<AudioInput />);
    const user = userEvent.setup();
    expect(screen.queryByRole('button', { name: 'Start audio' })).toBeNull();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(screen.getByText(/loopback is available only on Windows/i)).toBeTruthy();
    await addDevice(user, 1, 'Streamer microphone');
    await user.click(screen.getByRole('button', { name: 'Start audio' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/permission denied/i);
    expect(startAudio).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('off'));
  });

  it('captures two devices independently, renames a running input, and removes one without stopping the other', async () => {
    const tracks = Array.from({ length: 2 }, () => ({ stop: vi.fn(), addEventListener: vi.fn() }));
    const getUserMedia = vi.fn(async () => {
      const track = tracks[getUserMedia.mock.calls.length - 1]!;
      return {
        getAudioTracks: () => [track],
        getTracks: () => [track],
      } as unknown as MediaStream;
    });
    const { startAudio, stopAudio, removeAudioInput, stopMedia } = connect(getUserMedia);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:audio-worklet');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const close = vi.fn(async () => {});
    class MockAudioContext {
      sampleRate = 48000;
      audioWorklet = { addModule: vi.fn(async () => {}) };
      destination = {};
      createMediaStreamSource = () => ({ connect: vi.fn(), disconnect: vi.fn() });
      createGain = () => ({ gain: { value: 0 }, connect: vi.fn(), disconnect: vi.fn() });
      resume = async () => {};
      close = close;
    }
    class MockWorkletNode {
      port = { onmessage: null, close: vi.fn() };
      connect = vi.fn();
      disconnect = vi.fn();
    }
    vi.stubGlobal('AudioContext', MockAudioContext);
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const user = userEvent.setup();
    render(<AudioInput />);
    await addDevice(user, 1, 'Streamer microphone');
    await addDevice(user, 2, 'Voice chat');
    const startButtons = screen.getAllByRole('button', { name: 'Start audio' });
    await user.click(startButtons[0]!);
    await user.click(startButtons[1]!);
    await waitFor(() => expect(startAudio).toHaveBeenCalledTimes(2));
    expect(startAudio.mock.calls.map((args) => args[1])).toEqual(['mic-1', 'mic-2']);
    expect(startAudio.mock.calls[0]![3]).not.toBe(startAudio.mock.calls[1]![3]);
    await waitFor(() =>
      expect(
        screen.getAllByRole('status').every((node) => node.textContent?.includes('ready')),
      ).toBe(true),
    );
    const labels = screen.getAllByRole('textbox', { name: 'Transcript source label' });
    await user.clear(labels[1]!);
    await user.type(labels[1]!, 'Discord');
    await user.click(screen.getByRole('button', { name: 'Remove input 1' }));
    await waitFor(() =>
      expect(removeAudioInput).toHaveBeenCalledWith(startAudio.mock.calls[0]![0]),
    );
    await waitFor(() => expect(stopAudio).toHaveBeenCalledWith(startAudio.mock.calls[0]![3]));
    expect(screen.getByRole('button', { name: 'Stop audio' })).toBeTruthy();
    expect(tracks[0]!.stop).toHaveBeenCalled();
    expect(tracks[1]!.stop).not.toHaveBeenCalled();
    await act(async () => {
      stopMedia();
    });
    expect(tracks[1]!.stop).toHaveBeenCalled();
    expect(stopAudio).toHaveBeenCalledWith(startAudio.mock.calls[1]![3]);
    expect(screen.queryByRole('button', { name: 'Stop audio' })).toBeNull();
  });

  it('offers Windows playback loopback as another independent source', async () => {
    connect(vi.fn(), true);
    render(<AudioInput />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add audio input' }));
    await user.click(screen.getByRole('combobox', { name: 'Input device' }));
    expect(
      await screen.findByRole('option', { name: 'Windows system audio (loopback)' }),
    ).toBeTruthy();
  });

  it('requests Windows loopback capture directly from the user click', async () => {
    connect(vi.fn(), true);
    const capture = vi.fn(() => new Promise<MediaStream>(() => {}));
    Object.assign(navigator.mediaDevices, { getDisplayMedia: capture });
    render(<AudioInput />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add audio input' }));
    await user.click(screen.getByRole('combobox', { name: 'Input device' }));
    await user.click(
      await screen.findByRole('option', { name: 'Windows system audio (loopback)' }),
    );
    await user.click(screen.getByRole('button', { name: 'Start audio' }));
    expect(capture).toHaveBeenCalledExactlyOnceWith({ audio: true, video: true });
  });

  it('reports an unplugged device and reconnects using its original device identity', async () => {
    const track = { stop: vi.fn(), addEventListener: vi.fn() };
    const getUserMedia = vi.fn(
      async () =>
        ({
          getAudioTracks: () => [track],
          getTracks: () => [track],
        }) as unknown as MediaStream,
    );
    const { startAudio, audioDisconnected, changeDevices } = connect(getUserMedia);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:worklet');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    class AudioContextStub {
      sampleRate = 48000;
      audioWorklet = { addModule: async () => {} };
      destination = {};
      createMediaStreamSource = () => ({ connect: () => {}, disconnect: () => {} });
      createGain = () => ({ gain: { value: 0 }, connect: () => {}, disconnect: () => {} });
      resume = async () => {};
      close = async () => {};
    }
    class WorkletStub {
      port = { onmessage: null, close: () => {} };
      connect = () => {};
      disconnect = () => {};
    }
    vi.stubGlobal('AudioContext', AudioContextStub);
    vi.stubGlobal('AudioWorkletNode', WorkletStub);
    const user = userEvent.setup();
    render(<AudioInput />);
    await addDevice(user, 1, 'Streamer microphone');
    await user.click(screen.getByRole('button', { name: 'Start audio' }));
    await waitFor(() => expect(startAudio).toHaveBeenCalledTimes(1));
    changeDevices([]);
    await waitFor(() =>
      expect(audioDisconnected).toHaveBeenCalledWith(startAudio.mock.calls[0]![3]),
    );
    expect(screen.getByRole('status').textContent).toContain('disconnected');
    changeDevices(devices);
    await waitFor(() => expect(startAudio).toHaveBeenCalledTimes(2));
    expect(startAudio.mock.calls[1]![0]).toBe(startAudio.mock.calls[0]![0]);
    expect(startAudio.mock.calls[1]![1]).toBe('mic-1');
    expect(startAudio.mock.calls[1]![3]).not.toBe(startAudio.mock.calls[0]![3]);
  });
});
