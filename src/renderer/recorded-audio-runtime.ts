/** Isolated decoder/worklet lifetime; safe to call on startup failures, Stop and unmount. */
export interface RecordedAudioRuntime {
  captureId: string;
  audio: HTMLAudioElement;
  context: AudioContext;
  source: MediaElementAudioSourceNode;
  node: AudioWorkletNode;
  sink: GainNode;
  timeout: ReturnType<typeof setTimeout> | null;
  stallTimer: ReturnType<typeof setTimeout> | null;
  endTimer: ReturnType<typeof setTimeout> | null;
  completed: boolean;
  driftTimer: ReturnType<typeof setInterval> | null;
  active: boolean;
  started: boolean;
  recovering: boolean;
  stalled: boolean;
  queue: Promise<void>;
  pendingPcmChunks: number;
  flushResolver: (() => void) | null;
  pauseResolver: (() => void) | null;
  pauseToken: number;
  generation: number;
  cached: boolean;
}

export function closeRecordedAudioRuntime(runtime: RecordedAudioRuntime): void {
  runtime.active = false;
  runtime.started = false;
  if (runtime.timeout !== null) clearTimeout(runtime.timeout);
  if (runtime.stallTimer !== null) clearTimeout(runtime.stallTimer);
  if (runtime.endTimer !== null) clearTimeout(runtime.endTimer);
  if (runtime.driftTimer !== null) clearInterval(runtime.driftTimer);
  runtime.node.port.postMessage('pause');
  runtime.audio.pause();
  runtime.flushResolver?.();
  runtime.flushResolver = null;
  runtime.pauseResolver?.();
  runtime.pauseResolver = null;
  runtime.audio.onended = null;
  runtime.audio.onerror = null;
  runtime.audio.onwaiting = null;
  runtime.audio.onstalled = null;
  runtime.audio.onplaying = null;
  runtime.audio.onpause = null;
  runtime.node.port.close();
  runtime.node.disconnect();
  runtime.source.disconnect();
  runtime.sink.disconnect();
  void runtime.context.close().catch(() => {});
  void window.lonelyChat?.stopAudio(runtime.captureId).catch(() => {});
}
