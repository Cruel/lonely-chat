// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { DesktopAPI } from '../shared/chat-contract';
import { closeRecordedAudioRuntime, type RecordedAudioRuntime } from './recorded-audio-runtime';

afterEach(() => {
  delete window.lonelyChat;
  vi.restoreAllMocks();
});

it('releases the decoder, worklet, timers, listeners and native capture on close', async () => {
  const stopAudio = vi.fn(async () => {});
  window.lonelyChat = { stopAudio } as unknown as DesktopAPI;
  const port = { postMessage: vi.fn(), close: vi.fn() };
  const node = { port, disconnect: vi.fn() };
  const source = { disconnect: vi.fn() };
  const sink = { disconnect: vi.fn() };
  const context = { close: vi.fn(async () => {}) };
  const audio = { pause: vi.fn(), onended: vi.fn(), onwaiting: vi.fn(), onpause: vi.fn() };
  const release = vi.fn();
  const timeout = setTimeout(() => {}, 100000);
  const runtime = {
    captureId: 'capture-1',
    audio,
    node,
    source,
    sink,
    context,
    timeout,
    stallTimer: null,
    endTimer: null,
    driftTimer: null,
    active: true,
    started: true,
    recovering: false,
    stalled: false,
    completed: false,
    queue: Promise.resolve(),
    flushResolver: release,
    pauseResolver: null,
    pauseToken: 0,
    generation: 1,
    cached: false,
  } as unknown as RecordedAudioRuntime;
  closeRecordedAudioRuntime(runtime);
  expect(runtime.active).toBe(false);
  expect(runtime.started).toBe(false);
  expect(port.postMessage).toHaveBeenCalledWith('pause');
  expect(port.close).toHaveBeenCalled();
  expect(audio.pause).toHaveBeenCalled();
  expect(audio.onended).toBeNull();
  expect(audio.onwaiting).toBeNull();
  expect(audio.onpause).toBeNull();
  expect(release).toHaveBeenCalledOnce();
  expect(node.disconnect).toHaveBeenCalled();
  expect(source.disconnect).toHaveBeenCalled();
  expect(sink.disconnect).toHaveBeenCalled();
  expect(context.close).toHaveBeenCalled();
  expect(stopAudio).toHaveBeenCalledWith('capture-1');
});
