import { recordedAudioWorkletSource } from './recorded-audio-worklet';
import type { RecordedSegment } from './recorded-preview-timeline';

export interface RecordedLiveDevice {
  id: string;
  deviceId: string;
  label: string;
  offsetMs: number;
}

interface Capture {
  track: RecordedLiveDevice;
  captureId: string;
  stream: MediaStream;
  context: AudioContext;
  node: AudioWorkletNode;
  source: MediaStreamAudioSourceNode;
  sink: GainNode;
  queue: Promise<void>;
  pending: number;
  active: boolean;
  armed: boolean;
  closed: boolean;
  finishing?: boolean;
  flush?: () => void;
  timer: ReturnType<typeof setTimeout> | null;
  endTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * A non-seekable device producer for Recorded Runs. Its samples enter exactly the
 * same per-source PCM/resampler/VAD/Whisper admission as recorded media. No device
 * samples or monitor audio are persisted, and no real-time audio is replayed on seek.
 */
export class RecordedLiveDevices {
  private readonly captures = new Map<string, Capture>();
  private origin: { observedAt: number; monotonicMs: number } | null = null;
  private segment: RecordedSegment = { startMs: 0, endMs: null };
  private pausedAt: number | null = null;
  private generation = 0;

  constructor(
    private readonly onEnded: (id: string) => void,
    private readonly onFailure: (id: string, message: string) => void,
  ) {}

  async prepare(tracks: readonly RecordedLiveDevice[], segment: RecordedSegment): Promise<void> {
    this.stop();
    this.segment = segment;
    const generation = this.generation;
    try {
      for (const track of tracks) {
        if (!navigator.mediaDevices?.getUserMedia)
          throw new Error('Microphone capture is not available in this environment.');
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: { exact: track.deviceId },
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
          video: false,
        });
        if (generation !== this.generation) {
          stream.getTracks().forEach((item) => item.stop());
          return;
        }
        const context = new AudioContext();
        try {
          const url = URL.createObjectURL(
            new Blob([recordedAudioWorkletSource], { type: 'text/javascript' }),
          );
          try {
            await context.audioWorklet.addModule(url);
          } finally {
            URL.revokeObjectURL(url);
          }
          if (generation !== this.generation) {
            stream.getTracks().forEach((item) => item.stop());
            await context.close();
            return;
          }
          const source = context.createMediaStreamSource(stream);
          const node = new AudioWorkletNode(context, 'lonely-chat-recorded-audio');
          const sink = context.createGain();
          sink.gain.value = 0;
          source.connect(node);
          node.connect(sink);
          sink.connect(context.destination);
          const captureId = crypto.randomUUID();
          if (generation !== this.generation) {
            node.disconnect();
            source.disconnect();
            sink.disconnect();
            stream.getTracks().forEach((item) => item.stop());
            await context.close();
            return;
          }
          const answer = await window.lonelyChat!.startRecordedAudio({
            id: track.id,
            label: track.label,
            captureId,
            sampleRate: context.sampleRate,
            offsetMs: track.offsetMs,
            seekMs: Math.max(0, segment.startMs - track.offsetMs),
          });
          if (!answer.sources.some((entry) => entry.id === track.id && entry.phase === 'ready'))
            throw new Error('Whisper worker did not admit live device ' + track.label);
          if (generation !== this.generation) {
            node.disconnect();
            source.disconnect();
            sink.disconnect();
            stream.getTracks().forEach((item) => item.stop());
            await context.close();
            return;
          }
          const runtime: Capture = {
            track,
            captureId,
            stream,
            context,
            node,
            source,
            sink,
            queue: Promise.resolve(),
            pending: 0,
            active: false,
            armed: false,
            closed: false,
            timer: null,
            endTimer: null,
          };
          this.captures.set(track.id, runtime);
          for (const inputTrack of stream.getAudioTracks())
            inputTrack.addEventListener('ended', () => {
              if (!runtime.closed) this.fail(runtime, 'Live audio device disconnected.');
            });
          node.port.onmessage = (event: MessageEvent<Float32Array | { type: string }>) => {
            if (runtime.closed) return;
            if (event.data instanceof Float32Array) {
              // A final 'flush' frame is permitted while a Run is ending.
              if (runtime.active || runtime.finishing) this.enqueue(runtime, event.data);
            } else if (event.data?.type === 'flushed') runtime.flush?.();
          };
        } catch (error) {
          stream.getTracks().forEach((item) => item.stop());
          await context.close().catch(() => {});
          throw error;
        }
      }
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  private enqueue(runtime: Capture, samples: Float32Array): void {
    if (++runtime.pending > 128) {
      this.fail(runtime, 'Live audio PCM queue overflowed.');
      return;
    }
    runtime.queue = runtime.queue
      .then(async () => {
        if (!runtime.closed)
          await window.lonelyChat!.submitRecordedAudioPcm(samples, runtime.captureId);
      })
      .then(
        () => {
          runtime.pending--;
        },
        (error: unknown) => {
          runtime.pending--;
          this.fail(runtime, String(error));
        },
      );
  }

  private fail(runtime: Capture, message: string): void {
    if (runtime.closed) return;
    this.onFailure(runtime.track.id, 'Recorded live audio ' + runtime.track.label + ': ' + message);
    this.close(runtime);
  }

  private close(runtime: Capture): void {
    if (runtime.closed) return;
    runtime.closed = true;
    runtime.active = false;
    // Stop must also release an EOF waiter blocked on a worklet that is being destroyed.
    runtime.flush?.();
    runtime.flush = undefined;
    if (runtime.timer !== null) clearTimeout(runtime.timer);
    if (runtime.endTimer !== null) clearTimeout(runtime.endTimer);
    runtime.node.port.onmessage = null;
    runtime.node.port.postMessage('pause');
    runtime.node.disconnect();
    runtime.source.disconnect();
    runtime.sink.disconnect();
    runtime.stream.getTracks().forEach((track) => track.stop());
    void runtime.context.close().catch(() => {});
    this.captures.delete(runtime.track.id);
  }

  private async start(runtime: Capture): Promise<void> {
    if (
      runtime.closed ||
      runtime.finishing ||
      runtime.armed ||
      !this.origin ||
      this.pausedAt !== null
    )
      return;
    const mediaPosition = performance.now() - this.origin.monotonicMs - runtime.track.offsetMs;
    if (mediaPosition < 0) {
      // The segment endpoint is scheduled independently in begin(), even when
      // the source's positive offset delays admission beyond the end of the Run.
      runtime.timer = setTimeout(() => {
        runtime.timer = null;
        void this.start(runtime).catch((error: unknown) => this.fail(runtime, String(error)));
      }, -mediaPosition);
      return;
    }
    if (
      this.segment.endMs !== null &&
      performance.now() - this.origin.monotonicMs >= this.segment.endMs
    ) {
      await this.finish(runtime);
      return;
    }
    await runtime.context.resume();
    if (runtime.closed || runtime.finishing || !this.origin || this.pausedAt !== null) return;
    await window.lonelyChat!.armRecordedAudio(
      runtime.captureId,
      this.origin.observedAt,
      Math.max(0, performance.now() - this.origin.monotonicMs - runtime.track.offsetMs),
    );
    if (runtime.closed || runtime.finishing) return;
    runtime.armed = true;
    runtime.active = true;
    runtime.node.port.postMessage('start');
    this.scheduleEnd(runtime);
  }

  private scheduleEnd(runtime: Capture): void {
    if (!this.origin || runtime.closed || this.segment.endMs === null) return;
    if (runtime.endTimer !== null) clearTimeout(runtime.endTimer);
    runtime.endTimer = setTimeout(
      () => {
        runtime.endTimer = null;
        void this.finish(runtime).catch((error: unknown) => this.fail(runtime, String(error)));
      },
      Math.max(0, this.origin.monotonicMs + this.segment.endMs - performance.now()),
    );
  }

  private async finish(runtime: Capture): Promise<void> {
    if (runtime.closed || runtime.finishing) return;
    runtime.finishing = true;
    const hadStarted = runtime.armed;
    runtime.active = false;
    if (runtime.timer !== null) clearTimeout(runtime.timer);
    if (runtime.endTimer !== null) clearTimeout(runtime.endTimer);
    runtime.timer = null;
    runtime.endTimer = null;
    if (!runtime.armed && this.origin) {
      // A delayed device can reach EOF without ever producing PCM. Arm and
      // finish its source so the main-process EOF barrier can still drain.
      const mediaStartMs = Math.max(
        Math.max(0, this.segment.startMs - runtime.track.offsetMs),
        (this.segment.endMs ?? this.segment.startMs) - runtime.track.offsetMs,
      );
      await window.lonelyChat!.armRecordedAudio(
        runtime.captureId,
        this.origin.observedAt,
        mediaStartMs,
      );
      if (runtime.closed) return;
      runtime.armed = true;
    }
    if (runtime.armed) {
      // Don't send a worklet flush without a consumer: no samples were captured.
      if (!hadStarted) {
        await runtime.queue;
        if (!runtime.closed) await window.lonelyChat!.finishRecordedAudio(runtime.captureId);
      } else {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            runtime.flush = undefined;
            reject(new Error('Live audio worklet flush timed out.'));
          }, 10_000);
          runtime.flush = () => {
            clearTimeout(timeout);
            runtime.flush = undefined;
            resolve();
          };
          runtime.node.port.postMessage('flush');
        });
        await runtime.queue;
        if (!runtime.closed) await window.lonelyChat!.finishRecordedAudio(runtime.captureId);
      }
    }
    if (runtime.closed) return;
    const id = runtime.track.id;
    this.close(runtime);
    this.onEnded(id);
  }

  async begin(
    origin: { observedAt: number; monotonicMs: number },
    segment: RecordedSegment,
  ): Promise<void> {
    this.segment = segment;
    this.origin = {
      observedAt: origin.observedAt - segment.startMs,
      monotonicMs: origin.monotonicMs - segment.startMs,
    };
    await Promise.all(
      [...this.captures.values()].map(async (runtime) => {
        try {
          this.scheduleEnd(runtime);
          await this.start(runtime);
        } catch (error) {
          this.fail(runtime, String(error));
          throw error;
        }
      }),
    );
  }

  pause(): void {
    if (this.pausedAt !== null) return;
    this.pausedAt = performance.now();
    for (const runtime of this.captures.values()) {
      if (runtime.timer !== null) clearTimeout(runtime.timer);
      if (runtime.endTimer !== null) clearTimeout(runtime.endTimer);
      runtime.timer = null;
      runtime.endTimer = null;
      runtime.active = false;
      runtime.node.port.postMessage('hold');
    }
  }

  async resume(): Promise<void> {
    if (this.pausedAt === null) return;
    const delta = Math.max(0, performance.now() - this.pausedAt);
    this.pausedAt = null;
    if (this.origin) {
      this.origin.monotonicMs += delta;
      this.origin.observedAt += delta;
    }
    for (const runtime of this.captures.values()) {
      if (!runtime.armed) await this.start(runtime);
      else {
        runtime.node.port.postMessage('continue');
        runtime.active = true;
        this.scheduleEnd(runtime);
      }
    }
  }

  stop(): void {
    ++this.generation;
    for (const runtime of this.captures.values()) this.close(runtime);
    this.origin = null;
    this.pausedAt = null;
  }
}
