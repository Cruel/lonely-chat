// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import type { DesktopAPI } from '../../shared/chat-contract';
import { RecordedAudioInput, type RecordedAudioHandle } from './recorded-audio-input';

let clock = 1000;
const instances: TestAudio[] = [];
const ports: Array<{
  postMessage: ReturnType<typeof vi.fn>;
  onmessage: ((event: MessageEvent) => void) | null;
}> = [];

class TestAudio extends EventTarget {
  currentTime = 0;
  readyState = 4;
  seeking = false;
  paused = true;
  ended = false;
  playbackRate = 1;
  preload = '';
  onended: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onwaiting: ((event: Event) => void) | null = null;
  onstalled: ((event: Event) => void) | null = null;
  onplaying: ((event: Event) => void) | null = null;
  onpause: ((event: Event) => void) | null = null;
  private start!: () => void;
  play = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        this.start = () => {
          this.paused = false;
          this.onplaying?.(new Event('playing'));
          resolve();
        };
      }),
  );
  pause = vi.fn(() => {
    this.paused = true;
    this.onpause?.(new Event('pause'));
  });
  constructor(_url: string) {
    super();
    instances.push(this);
  }
  startPlayback() {
    this.start();
  }
  stall() {
    this.readyState = 1;
    this.onwaiting?.(new Event('waiting'));
  }
  recover() {
    this.readyState = 4;
    this.onplaying?.(new Event('playing'));
  }
}

const connector = () => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
});
class TestContext {
  sampleRate = 48000;
  destination = {};
  audioWorklet = { addModule: vi.fn(async () => {}) };
  createMediaElementSource = vi.fn(() => connector());
  createGain = vi.fn(() => ({ ...connector(), gain: { value: 0 } }));
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {});
}
class TestWorklet {
  port = {
    postMessage: vi.fn((value: unknown) => {
      if (value && typeof value === 'object' && 'type' in value && value.type === 'pause') {
        const token = 'token' in value ? value.token : undefined;
        queueMicrotask(() =>
          this.port.onmessage?.({ data: { type: 'paused', token } } as MessageEvent),
        );
      }
    }),
    onmessage: null as ((event: MessageEvent) => void) | null,
    close: vi.fn(),
  };
  connect = vi.fn();
  disconnect = vi.fn();
  constructor() {
    ports.push(this.port);
  }
}
const createObjectURL = vi.fn(() => 'blob:fixture');
const revokeObjectURL = vi.fn();

function setup() {
  clock = 1000;
  instances.splice(0);
  ports.splice(0);
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.stubGlobal('Audio', TestAudio);
  vi.stubGlobal('AudioContext', TestContext);
  vi.stubGlobal('AudioWorkletNode', TestWorklet);
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
  const start = vi.fn(async (value: { id: string }) => ({
    sources: [{ id: value.id, phase: 'ready' as const }],
  }));
  const arm = vi.fn(async (_captureId: string, _originMs: number, _mediaMs: number) => {});
  const resync = vi.fn(async (_captureId: string, _originMs: number, _mediaMs: number) => {});
  const pcm = vi.fn(async () => {});
  const finish = vi.fn(async () => {});
  window.lonelyChat = {
    startRecordedAudio: start,
    armRecordedAudio: arm,
    resyncRecordedAudio: resync,
    submitRecordedAudioPcm: pcm,
    finishRecordedAudio: finish,
    stopAudio: vi.fn(async () => ({ sources: [], transcripts: [], revision: 0 })),
  } as unknown as DesktopAPI;
  const ref = createRef<RecordedAudioHandle>();
  const selection = vi.fn();
  const page = render(
    <RecordedAudioInput ref={ref} running={false} onSelectionChange={selection} />,
  );
  return { ...page, ref, start, arm, resync, pcm, finish, selection };
}
async function selectFiles(page: ReturnType<typeof setup>, count: number) {
  fireEvent.change(screen.getByLabelText('Add audio files'), {
    target: {
      files: Array.from(
        { length: count },
        (_, i) => new File(['audio'], 'track-' + i + '.wav', { type: 'audio/wav' }),
      ),
    },
  });
  const tags = document.querySelectorAll('audio');
  for (const tag of tags) {
    Object.defineProperty(tag, 'duration', { configurable: true, value: 10 });
    fireEvent.loadedMetadata(tag);
  }
  await waitFor(() => expect(page.selection).toHaveBeenLastCalledWith({ ready: true, count }));
  page.rerender(
    <RecordedAudioInput ref={page.ref} running={true} onSelectionChange={page.selection} />,
  );
  await page.ref.current!.prepare();
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete window.lonelyChat;
});

it('anchors each track after its actual asynchronous playback starts, not before', async () => {
  const page = setup();
  await selectFiles(page, 2);
  const origin = { observedAt: 100000, monotonicMs: 0 };
  const beginning = page.ref.current!.begin(origin);
  await waitFor(() =>
    expect(instances.every((audio) => audio.play.mock.calls.length === 1)).toBe(true),
  );
  expect(page.arm).not.toHaveBeenCalled();
  clock = 1450;
  instances[0].startPlayback();
  await waitFor(() => expect(page.arm).toHaveBeenCalledTimes(1));
  expect(page.arm.mock.calls[0][2]).toBeCloseTo(1450);
  expect(ports[0].postMessage).toHaveBeenCalledWith('start');
  clock = 2200;
  instances[1].startPlayback();
  await beginning;
  expect(page.arm).toHaveBeenCalledTimes(2);
  expect(page.arm.mock.calls[1][2]).toBeCloseTo(2200);
  expect(ports[1].postMessage).toHaveBeenCalledWith('start');
  page.ref.current!.stop();
});

it('waits for a decoded seek before trying to play or arm Whisper', async () => {
  const page = setup();
  await selectFiles(page, 1);
  instances[0].seeking = true;
  instances[0].readyState = 1;
  const beginning = page.ref.current!.begin({ observedAt: 100000, monotonicMs: 0 });
  await Promise.resolve();
  expect(instances[0].play).not.toHaveBeenCalled();
  expect(page.arm).not.toHaveBeenCalled();
  instances[0].seeking = false;
  instances[0].readyState = 4;
  instances[0].dispatchEvent(new Event('seeked'));
  await waitFor(() => expect(instances[0].play).toHaveBeenCalledTimes(1));
  instances[0].startPlayback();
  await beginning;
  expect(page.arm).toHaveBeenCalledOnce();
  page.ref.current!.stop();
});

it('fails a prolonged buffering track without interrupting another track', async () => {
  const page = setup();
  await selectFiles(page, 2);
  const started = page.ref.current!.begin({ observedAt: 100000, monotonicMs: 0 });
  await waitFor(() =>
    expect(instances.every((audio) => audio.play.mock.calls.length === 1)).toBe(true),
  );
  instances[0].startPlayback();
  instances[1].startPlayback();
  await started;
  vi.useFakeTimers();
  try {
    instances[0].stall();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7100);
    });
    expect(screen.getByText(/Audio error: Recorded audio buffering stalled/)).toBeTruthy();
    expect(ports[0].postMessage).toHaveBeenCalledWith('pause');
    expect(ports[1].postMessage).toHaveBeenCalledWith('start');
    expect(page.arm).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
    page.ref.current!.stop();
  }
});

it('flushes the final audio worklet samples and closes the transcription source on EOF', async () => {
  const page = setup();
  await selectFiles(page, 1);
  const beginning = page.ref.current!.begin({ observedAt: 100000, monotonicMs: 0 });
  await waitFor(() => expect(instances[0].play).toHaveBeenCalled());
  instances[0].startPlayback();
  await beginning;
  instances[0].onended?.(new Event('ended'));
  await waitFor(() => expect(ports[0].postMessage).toHaveBeenCalledWith('flush'));
  ports[0].onmessage?.({ data: new Float32Array(4096) } as MessageEvent);
  ports[0].onmessage?.({ data: { type: 'flushed' } } as MessageEvent);
  await waitFor(() => expect(page.finish).toHaveBeenCalledTimes(1));
  expect(page.pcm).toHaveBeenCalledTimes(1);
  page.ref.current!.stop();
});

it('fails only the affected track if the audio worklet never acknowledges EOF flush', async () => {
  const page = setup();
  await selectFiles(page, 2);
  const beginning = page.ref.current!.begin({ observedAt: 100000, monotonicMs: 0 });
  await waitFor(() =>
    expect(instances.every((audio) => audio.play.mock.calls.length === 1)).toBe(true),
  );
  instances[0].startPlayback();
  instances[1].startPlayback();
  await beginning;
  vi.useFakeTimers();
  try {
    instances[0].onended?.(new Event('ended'));
    expect(ports[0].postMessage).toHaveBeenCalledWith('flush');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7100);
    });
    expect(
      screen.getByText(/Audio error: Recorded audio worklet did not flush at end of file/),
    ).toBeTruthy();
    expect(ports[1].postMessage).toHaveBeenCalledWith('start');
  } finally {
    vi.useRealTimers();
    page.ref.current!.stop();
  }
});

it('stops posting PCM during buffering and reanchors after playback recovery', async () => {
  const page = setup();
  await selectFiles(page, 1);
  const started = page.ref.current!.begin({ observedAt: 100000, monotonicMs: 0 });
  await waitFor(() => expect(instances[0].play).toHaveBeenCalled());
  instances[0].startPlayback();
  await started;
  expect(page.arm).toHaveBeenCalledTimes(1);
  instances[0].stall();
  expect(ports[0].postMessage).toHaveBeenCalledWith('pause');
  ports[0].onmessage?.({ data: new Float32Array(4096) } as MessageEvent);
  expect(page.pcm).not.toHaveBeenCalled();
  clock = 3200;
  instances[0].recover();
  await waitFor(() => expect(page.resync).toHaveBeenCalledTimes(1));
  expect(page.resync.mock.calls[0][2]).toBeCloseTo(3200);
  await waitFor(() =>
    expect(ports[0].postMessage.mock.calls.filter(([command]) => command === 'start')).toHaveLength(
      2,
    ),
  );
  page.ref.current!.stop();
});
