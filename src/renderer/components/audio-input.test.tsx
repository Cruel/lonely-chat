// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesktopAPI } from '../../shared/chat-contract';
import { AudioInput } from './audio-input';

Element.prototype.scrollIntoView = () => {};
const microphone = {
  kind: 'audioinput',
  deviceId: 'mic-1',
  label: 'Test microphone',
} as MediaDeviceInfo;

const status = {
  revision: 0,
  phase: 'off' as const,
  sourceId: null,
  label: 'Microphone',
  error: null,
  pendingSegments: 0,
  transcripts: [],
};

function connect(getUserMedia: ReturnType<typeof vi.fn>) {
  const stopAudio = vi.fn(async (_captureId: string) => status);
  const startAudio = vi.fn(async (_sourceId: string, _label: string, _captureId: string) => ({
    ...status,
    phase: 'ready' as const,
  }));
  window.lonelyChat = {
    getAudioStatus: async () => status,
    onAudioChange: () => () => {},
    startAudio,
    stopAudio,
    submitAudioSegment: async () => {},
  } as unknown as DesktopAPI;
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      enumerateDevices: vi.fn(async () => [microphone]),
      getUserMedia,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
  return { startAudio, stopAudio };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete window.lonelyChat;
  Reflect.deleteProperty(navigator, 'mediaDevices');
});

describe('microphone permissions and lifecycle', () => {
  it('gracefully handles denied permission without starting native transcription', async () => {
    const getUserMedia = vi.fn(async () => {
      throw new DOMException('Permission denied', 'NotAllowedError');
    });
    const { startAudio } = connect(getUserMedia);
    render(<AudioInput />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: 'Input device' }));
    await user.click(await screen.findByRole('option', { name: 'Test microphone' }));
    await user.click(screen.getByRole('button', { name: 'Start audio' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/permission denied/i);
    expect(startAudio).not.toHaveBeenCalled();
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        deviceId: { exact: 'mic-1' },
        echoCancellation: false,
        autoGainControl: false,
        noiseSuppression: false,
      },
      video: false,
    });
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('off'));
  });

  it('captures 16 kHz mono PCM from a standard audioinput and stops the matching native session', async () => {
    const track = { stop: vi.fn(), onended: null as (() => void) | null };
    const stream = {
      getAudioTracks: () => [track],
      getTracks: () => [track],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn(async () => stream);
    const { startAudio, stopAudio } = connect(getUserMedia);
    const submitAudioSegment = vi.fn(
      async (
        _segment: import('../../shared/audio-contract').AudioSegment,
        _captureId: string,
      ) => {},
    );
    window.lonelyChat!.submitAudioSegment = submitAudioSegment;
    const url = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-worklet');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const connectNode = vi.fn();
    const disconnect = vi.fn();
    const close = vi.fn(async () => {});
    const addModule = vi.fn(async () => {});
    class MockAudioContext {
      sampleRate = 48000;
      audioWorklet = { addModule };
      destination = {};
      createMediaStreamSource = () => ({ connect: connectNode, disconnect });
      createGain = () => ({ gain: { value: 0 }, connect: connectNode, disconnect });
      resume = async () => {};
      close = close;
    }
    let workletPort: { onmessage: ((event: MessageEvent<Float32Array>) => void) | null } | null =
      null;
    class MockWorkletNode {
      port = {
        onmessage: null as ((event: MessageEvent<Float32Array>) => void) | null,
        close: vi.fn(),
      };
      connect = connectNode;
      disconnect = disconnect;
      constructor() {
        workletPort = this.port;
      }
    }
    vi.stubGlobal('AudioContext', MockAudioContext);
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    try {
      render(<AudioInput />);
      const user = userEvent.setup();
      await user.click(screen.getByRole('combobox', { name: 'Input device' }));
      await user.click(await screen.findByRole('option', { name: 'Test microphone' }));
      await user.click(screen.getByRole('button', { name: 'Start audio' }));
      await waitFor(() => expect(startAudio).toHaveBeenCalledOnce());
      await waitFor(() => expect(workletPort).not.toBeNull());
      expect(url).toHaveBeenCalledOnce();
      expect(addModule).toHaveBeenCalledWith('blob:test-worklet');
      expect(revoke).toHaveBeenCalledWith('blob:test-worklet');
      const pcm = new Float32Array(48000).fill(0.25);
      const silence = new Float32Array(48000);
      workletPort!.onmessage!({ data: pcm } as MessageEvent<Float32Array>);
      workletPort!.onmessage!({ data: silence } as MessageEvent<Float32Array>);
      await waitFor(() => expect(submitAudioSegment).toHaveBeenCalledOnce());
      const [segment, id] = submitAudioSegment.mock.calls[0];
      expect(segment.samples).toBeInstanceOf(Float32Array);
      expect(segment.samples.length).toBeGreaterThan(16000);
      expect(startAudio.mock.calls[0][2]).toBe(id);
      await user.click(screen.getByRole('button', { name: 'Stop audio' }));
      await waitFor(() => expect(stopAudio).toHaveBeenCalledWith(id));
      expect(track.stop).toHaveBeenCalled();
      expect(close).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('can remain disabled without requesting audio permission or a native worker', async () => {
    const getUserMedia = vi.fn();
    const { startAudio } = connect(getUserMedia);
    render(<AudioInput />);
    expect(await screen.findByRole('button', { name: 'Start audio' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(startAudio).not.toHaveBeenCalled();
  });
});
