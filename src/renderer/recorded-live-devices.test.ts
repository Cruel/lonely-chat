// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { RecordedLiveDevices } from './recorded-live-devices';
import type { DesktopAPI } from '../shared/chat-contract';

type FakeNode = {
  port: {
    onmessage: ((event: MessageEvent<Float32Array | { type: string }>) => void) | null;
    postMessage: ReturnType<typeof vi.fn>;
  };
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
};
function node(): FakeNode {
  return {
    port: { onmessage: null, postMessage: vi.fn() },
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
}
const devices: RecordedLiveDevices[] = [];

afterEach(() => {
  for (const device of devices.splice(0)) device.stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete window.lonelyChat;
});

it('admits a live device to recorded Whisper PCM, pauses/resumes, flushes and closes at EOF', async () => {
  const mediaTrack = { stop: vi.fn(), addEventListener: vi.fn() };
  const stream = {
    getTracks: () => [mediaTrack],
    getAudioTracks: () => [mediaTrack],
  } as unknown as MediaStream;
  const getUserMedia = vi.fn(async () => stream);
  vi.stubGlobal(
    'navigator',
    Object.assign(Object.create(navigator), {
      mediaDevices: { getUserMedia },
    }),
  );
  const context = {
    sampleRate: 48000,
    destination: {},
    audioWorklet: { addModule: vi.fn(async () => {}) },
    createMediaStreamSource: vi.fn(() => node()),
    createGain: vi.fn(() => ({ ...node(), gain: { value: 1 } })),
    resume: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  vi.stubGlobal(
    'AudioContext',
    vi.fn(function () {
      return context;
    }),
  );
  const worker = node();
  worker.port.postMessage.mockImplementation((command: unknown) => {
    if (command !== 'flush') return;
    queueMicrotask(() => {
      worker.port.onmessage?.({ data: new Float32Array([0.6]) } as MessageEvent<Float32Array>);
      worker.port.onmessage?.({ data: { type: 'flushed' } } as MessageEvent<{ type: string }>);
    });
  });
  vi.stubGlobal(
    'AudioWorkletNode',
    vi.fn(function () {
      return worker;
    }),
  );
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:worklet'),
    revokeObjectURL: vi.fn(),
  });
  const start = vi.fn(async (request: { id: string }) => ({
    revision: 0,
    sources: [{ id: request.id, phase: 'ready' }],
    transcripts: [],
  }));
  const arm = vi.fn(async () => {});
  const push = vi.fn(async () => {});
  const finish = vi.fn(async () => {});
  window.lonelyChat = {
    startRecordedAudio: start,
    armRecordedAudio: arm,
    submitRecordedAudioPcm: push,
    finishRecordedAudio: finish,
  } as unknown as DesktopAPI;
  const ended = vi.fn();
  const failed = vi.fn();
  const live = new RecordedLiveDevices(ended, failed);
  devices.push(live);
  const origin = performance.now();
  await live.prepare([{ id: 'mic', deviceId: 'hardware-A', label: 'Mic', offsetMs: 0 }], {
    startMs: 0,
    endMs: null,
  });
  expect(getUserMedia).toHaveBeenCalledWith({
    audio: {
      deviceId: { exact: 'hardware-A' },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
    video: false,
  });
  expect(start).toHaveBeenCalledWith(
    expect.objectContaining({
      id: 'mic',
      label: 'Mic',
      sampleRate: 48000,
      seekMs: 0,
      offsetMs: 0,
    }),
  );
  await live.begin(
    { observedAt: 1700000000000, monotonicMs: origin },
    {
      startMs: 0,
      endMs: 350,
    },
  );
  expect(arm).toHaveBeenCalledOnce();
  expect(worker.port.postMessage).toHaveBeenCalledWith('start');
  worker.port.onmessage?.({ data: new Float32Array([0.3, -0.2]) } as MessageEvent<Float32Array>);
  await vi.waitFor(() => expect(push).toHaveBeenCalledOnce());
  live.pause();
  expect(worker.port.postMessage).toHaveBeenCalledWith('hold');
  worker.port.onmessage?.({ data: new Float32Array([0.2]) } as MessageEvent<Float32Array>);
  expect(push).toHaveBeenCalledOnce();
  await live.resume();
  expect(worker.port.postMessage).toHaveBeenCalledWith('continue');
  worker.port.onmessage?.({ data: new Float32Array([0.1]) } as MessageEvent<Float32Array>);
  await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(ended).toHaveBeenCalledWith('mic'), { timeout: 1200 });
  expect(push).toHaveBeenCalledTimes(3); // The final partial worklet buffer is not dropped.
  expect(finish).toHaveBeenCalledOnce();
  live.stop();
  expect(mediaTrack.stop).toHaveBeenCalledOnce();
  expect(context.close).toHaveBeenCalled();
  expect(failed).not.toHaveBeenCalled();
});

it('finishes at the segment endpoint even when positive offset keeps microphone silent', async () => {
  const track = { stop: vi.fn(), addEventListener: vi.fn() };
  vi.stubGlobal(
    'navigator',
    Object.assign(Object.create(navigator), {
      mediaDevices: {
        getUserMedia: async () => ({
          getTracks: () => [track],
          getAudioTracks: () => [track],
        }),
      },
    }),
  );
  const context = {
    sampleRate: 48000,
    destination: {},
    audioWorklet: { addModule: async () => {} },
    createMediaStreamSource: () => node(),
    createGain: () => ({ ...node(), gain: { value: 0 } }),
    resume: async () => {},
    close: async () => {},
  };
  vi.stubGlobal('AudioContext', function () {
    return context;
  });
  vi.stubGlobal('AudioWorkletNode', function () {
    return node();
  });
  vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:worklet', revokeObjectURL: vi.fn() });
  const arm = vi.fn(async () => {});
  const finish = vi.fn(async () => {});
  const pcm = vi.fn(async () => {});
  window.lonelyChat = {
    startRecordedAudio: async () => ({
      revision: 0,
      sources: [{ id: 'delayed', phase: 'ready' }],
      transcripts: [],
    }),
    armRecordedAudio: arm,
    finishRecordedAudio: finish,
    submitRecordedAudioPcm: pcm,
  } as unknown as DesktopAPI;
  const ended = vi.fn();
  const failed = vi.fn();
  const live = new RecordedLiveDevices(ended, failed);
  devices.push(live);
  await live.prepare([{ id: 'delayed', label: 'Guest', deviceId: 'hardware', offsetMs: 1500 }], {
    startMs: 0,
    endMs: 35,
  });
  await live.begin(
    { observedAt: 1700000000000, monotonicMs: performance.now() },
    {
      startMs: 0,
      endMs: 35,
    },
  );
  await vi.waitFor(() => expect(ended).toHaveBeenCalledWith('delayed'), { timeout: 1000 });
  expect(arm).toHaveBeenCalledOnce();
  expect(finish).toHaveBeenCalledOnce();
  expect(pcm).not.toHaveBeenCalled();
  expect(failed).not.toHaveBeenCalled();
  expect(track.stop).toHaveBeenCalledOnce();
});

it('marks unexpected device disconnection as fatal and releases the microphone', async () => {
  const listeners = new Map<string, () => void>();
  const track = {
    stop: vi.fn(),
    addEventListener: vi.fn((event: string, fn: () => void) => listeners.set(event, fn)),
  };
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
  vi.stubGlobal(
    'navigator',
    Object.assign(Object.create(navigator), {
      mediaDevices: { getUserMedia: async () => stream },
    }),
  );
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: () => 'blob:processor',
    revokeObjectURL: vi.fn(),
  });
  const worklet = node();
  vi.stubGlobal(
    'AudioWorkletNode',
    vi.fn(function () {
      return worklet;
    }),
  );
  vi.stubGlobal(
    'AudioContext',
    vi.fn(function () {
      return {
        sampleRate: 48000,
        destination: {},
        audioWorklet: { addModule: async () => {} },
        createMediaStreamSource: () => node(),
        createGain: () => ({ ...node(), gain: { value: 0 } }),
        close: async () => {},
      };
    }),
  );
  window.lonelyChat = {
    startRecordedAudio: async () => ({
      revision: 0,
      sources: [{ id: 'mic', phase: 'ready' }],
      transcripts: [],
    }),
  } as unknown as DesktopAPI;
  const failed = vi.fn();
  const live = new RecordedLiveDevices(vi.fn(), failed);
  devices.push(live);
  await live.prepare([{ id: 'mic', deviceId: 'device-1', label: 'Mic', offsetMs: 0 }], {
    startMs: 0,
    endMs: null,
  });
  listeners.get('ended')?.();
  expect(failed).toHaveBeenCalledWith('mic', expect.stringContaining('disconnected'));
  expect(track.stop).toHaveBeenCalledOnce();
});
