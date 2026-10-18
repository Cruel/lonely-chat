import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { recordedAudioPosition } from '../recorded-audio-timeline';
import {
  alignRecordedMedia,
  startRecordedMedia,
  resumeRecordedContext,
  AUDIO_DRIFT_TOLERANCE_MS,
  AUDIO_STALL_TIMEOUT_MS,
} from '../recorded-audio-sync';
import { recordedAudioWorkletSource } from '../recorded-audio-worklet';

interface AudioFileTrack {
  id: string;
  url: string;
  name: string;
  label: string;
  enabled: boolean;
  offsetMs: number;
  durationMs: number | null;
  error: string | null;
}

interface AudioRuntime {
  captureId: string;
  audio: HTMLAudioElement;
  context: AudioContext;
  source: MediaElementAudioSourceNode;
  node: AudioWorkletNode;
  sink: GainNode;
  timeout: ReturnType<typeof setTimeout> | null;
  stallTimer: ReturnType<typeof setTimeout> | null;
  driftTimer: ReturnType<typeof setInterval> | null;
  active: boolean;
  started: boolean;
  recovering: boolean;
  stalled: boolean;
  queue: Promise<void>;
  flushResolver: (() => void) | null;
  pauseResolver: (() => void) | null;
  pauseToken: number;
  generation: number;
}

export interface RecordedAudioHandle {
  prepare(): Promise<void>;
  begin(origin: { observedAt: number; monotonicMs: number }): Promise<void>;
  stop(): void;
}

let nextTrack = 0;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** File-backed producers; independent of the VLM, native inference cadence, and monitor output. */
export const RecordedAudioInput = forwardRef<
  RecordedAudioHandle,
  {
    running: boolean;
    onSelectionChange: (state: { ready: boolean; count: number }) => void;
  }
>(function RecordedAudioInput({ running, onSelectionChange }, ref) {
  const [tracks, setTracks] = useState<AudioFileTrack[]>([]);
  const [phases, setPhases] = useState<Record<string, string>>({});
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;
  const runtimes = useRef(new Map<string, AudioRuntime>());
  const urls = useRef(new Set<string>());
  const generation = useRef(0);

  const patch = (id: string, changes: Partial<AudioFileTrack>) => {
    setTracks((previous) =>
      previous.map((track) => (track.id === id ? { ...track, ...changes } : track)),
    );
  };
  const status = (id: string, phase: string) =>
    setPhases((previous) => ({ ...previous, [id]: phase }));

  const close = (runtime: AudioRuntime) => {
    runtime.active = false;
    runtime.started = false;
    if (runtime.timeout !== null) clearTimeout(runtime.timeout);
    if (runtime.stallTimer !== null) clearTimeout(runtime.stallTimer);
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
  };
  const stop = () => {
    ++generation.current;
    for (const runtime of runtimes.current.values()) close(runtime);
    runtimes.current.clear();
  };

  useImperativeHandle(ref, () => ({
    stop,
    async prepare() {
      stop();
      const currentGeneration = generation.current;
      const api = window.lonelyChat;
      if (!api) throw new Error('Desktop audio integration is unavailable.');
      const selected = tracksRef.current.filter(
        (track) => track.enabled && track.durationMs !== null,
      );
      // Per-source startup errors are isolated; other files and video still play.
      await Promise.all(
        selected.map(async (track) => {
          let runtime: AudioRuntime | null = null;
          let context: AudioContext | null = null;
          try {
            context = new AudioContext();
            const url = URL.createObjectURL(
              new Blob([recordedAudioWorkletSource], { type: 'text/javascript' }),
            );
            try {
              await context.audioWorklet.addModule(url);
            } finally {
              URL.revokeObjectURL(url);
            }
            if (currentGeneration !== generation.current) {
              await context.close();
              return;
            }
            const audio = new Audio(track.url);
            audio.preload = 'auto';
            audio.playbackRate = 1;
            const source = context.createMediaElementSource(audio);
            const node = new AudioWorkletNode(context, 'lonely-chat-recorded-audio');
            const sink = context.createGain();
            sink.gain.value = 0; // Explicit no-monitor default; capture uses the pre-gain worklet.
            source.connect(node);
            node.connect(sink);
            sink.connect(context.destination);
            const captureId = crypto.randomUUID();
            runtime = {
              captureId,
              audio,
              context,
              source,
              node,
              sink,
              timeout: null,
              stallTimer: null,
              driftTimer: null,
              active: false,
              started: false,
              recovering: false,
              stalled: false,
              queue: Promise.resolve(),
              flushResolver: null,
              pauseResolver: null,
              pauseToken: 0,
              generation: currentGeneration,
            };
            const current = runtime;
            const answer = await api.startRecordedAudio({
              id: track.id,
              label: track.label,
              captureId,
              sampleRate: context.sampleRate,
              offsetMs: track.offsetMs,
              seekMs: Math.max(0, -track.offsetMs),
            });
            const worker = answer.sources.find((entry) => entry.id === track.id);
            if (worker?.phase !== 'ready')
              throw new Error(worker?.error ?? 'Whisper worker failed to start for this file.');
            if (currentGeneration !== generation.current) {
              close(current);
              return;
            }
            runtimes.current.set(track.id, current);
            status(track.id, 'Ready for synchronized playback');
          } catch (error) {
            status(track.id, `Audio error: ${errorText(error)}`);
            if (runtime) close(runtime);
            else void context?.close().catch(() => {});
          }
        }),
      );
    },
    async begin(origin) {
      const api = window.lonelyChat;
      if (!api) return;
      await Promise.all(
        tracksRef.current.map(async (track) => {
          const runtime = runtimes.current.get(track.id);
          if (!runtime || !track.enabled || track.durationMs === null) return;
          const captureGeneration = runtime.generation;
          const current = () =>
            generation.current === captureGeneration && runtimes.current.get(track.id) === runtime;
          const failed = (error: unknown) => {
            if (!current()) return;
            status(track.id, 'Audio error: ' + errorText(error));
            close(runtime);
            runtimes.current.delete(track.id);
          };
          const clearStall = () => {
            if (runtime.stallTimer !== null) clearTimeout(runtime.stallTimer);
            runtime.stallTimer = null;
          };
          const pauseForBuffering = () => {
            if (!current() || !runtime.started || runtime.recovering || runtime.stalled) return;
            runtime.active = false;
            runtime.stalled = true;
            runtime.node.port.postMessage('pause');
            status(track.id, 'Waiting for audio playback');
            runtime.stallTimer = setTimeout(
              () => failed(new Error('Recorded audio buffering stalled.')),
              AUDIO_STALL_TIMEOUT_MS,
            );
          };
          const finish = async () => {
            if (!current()) return;
            runtime.active = false;
            runtime.started = false;
            runtime.pauseResolver?.();
            runtime.pauseResolver = null;
            clearStall();
            if (runtime.driftTimer !== null) clearInterval(runtime.driftTimer);
            runtime.driftTimer = null;
            await new Promise<void>((resolve, reject) => {
              const deadline = setTimeout(() => {
                runtime.flushResolver = null;
                runtime.node.port.onmessage = old;
                reject(new Error('Recorded audio worklet did not flush at end of file.'));
              }, AUDIO_STALL_TIMEOUT_MS);
              runtime.flushResolver = () => {
                clearTimeout(deadline);
                resolve();
              };
              const old = runtime.node.port.onmessage;
              runtime.node.port.onmessage = (
                event: MessageEvent<Float32Array | { type: string }>,
              ) => {
                if (event.data instanceof Float32Array) {
                  if (event.data.length > 0) {
                    runtime.queue = runtime.queue.then(() =>
                      api.submitRecordedAudioPcm(event.data as Float32Array, runtime.captureId),
                    );
                  }
                } else if (event.data?.type === 'flushed') {
                  runtime.node.port.onmessage = old;
                  runtime.flushResolver?.();
                  runtime.flushResolver = null;
                }
              };
              runtime.node.port.postMessage('flush');
            });
            await runtime.queue;
            if (!current()) return;
            await api.finishRecordedAudio(runtime.captureId);
            status(track.id, 'End of audio');
          };
          const synchronize = async (first: boolean) => {
            if (!current() || runtime.recovering) return;
            runtime.recovering = true;
            runtime.active = false;
            try {
              // The worklet confirms that pre-seek PCM has been discarded.
              // Its FIFO acknowledgement follows any earlier posted audio batches.
              const paused = new Promise<void>((resolve, reject) => {
                const token = ++runtime.pauseToken;
                const deadline = setTimeout(() => {
                  if (runtime.pauseToken !== token) return;
                  runtime.pauseResolver = null;
                  reject(new Error('Recorded audio worklet did not acknowledge its pause.'));
                }, AUDIO_STALL_TIMEOUT_MS);
                runtime.pauseResolver = () => {
                  clearTimeout(deadline);
                  resolve();
                };
                runtime.node.port.postMessage({ type: 'pause', token });
              });
              await paused;
              if (!current()) return;
              await runtime.queue;
              if (!current()) return;
              const mediaMs = await alignRecordedMedia(
                runtime.audio,
                track.offsetMs,
                track.durationMs!,
                origin.monotonicMs,
              );
              if (!current()) return;
              if (mediaMs === null) {
                await api.finishRecordedAudio(runtime.captureId);
                status(track.id, 'End of audio');
                runtime.started = false;
                clearStall();
                return;
              }
              let anchoredMs = mediaMs;
              let synchronized = false;
              for (let attempt = 0; attempt < 3; attempt++) {
                if (first && attempt === 0)
                  await api.armRecordedAudio(runtime.captureId, origin.observedAt, anchoredMs);
                else
                  await api.resyncRecordedAudio(runtime.captureId, origin.observedAt, anchoredMs);
                if (!current()) return;
                // Main-process IPC can itself be delayed while playback advances.
                // Refresh the decoder seek and anchor again before accepting PCM.
                const freshMs = await alignRecordedMedia(
                  runtime.audio,
                  track.offsetMs,
                  track.durationMs!,
                  origin.monotonicMs,
                );
                if (!current()) return;
                if (freshMs === null) break;
                if (Math.abs(freshMs - anchoredMs) <= AUDIO_DRIFT_TOLERANCE_MS) {
                  synchronized = true;
                  break;
                }
                anchoredMs = freshMs;
              }
              if (!synchronized)
                throw new Error(
                  'Recorded audio startup could not catch up with the shared timeline.',
                );
              runtime.started = true;
              runtime.stalled = false;
              clearStall();
              runtime.node.port.postMessage('start');
              runtime.active = true;
              status(track.id, 'Playing at 1× (synchronized)');
              if (runtime.driftTimer === null) {
                runtime.driftTimer = setInterval(() => {
                  if (!current() || !runtime.started || runtime.recovering || !runtime.active)
                    return;
                  if (
                    runtime.audio.paused ||
                    runtime.audio.seeking ||
                    runtime.audio.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
                  ) {
                    pauseForBuffering();
                    return;
                  }
                  const position = recordedAudioPosition(
                    track.offsetMs,
                    performance.now() - origin.monotonicMs,
                    track.durationMs!,
                  );
                  if (
                    position &&
                    Math.abs(runtime.audio.currentTime * 1000 - position.mediaMs) >
                      AUDIO_DRIFT_TOLERANCE_MS
                  ) {
                    // No silent PCM can be timestamped across this seek.
                    runtime.active = false;
                    runtime.node.port.postMessage('pause');
                    void synchronize(false).catch(failed);
                  }
                }, 350);
              }
            } finally {
              runtime.recovering = false;
            }
          };
          runtime.node.port.onmessage = (
            event: MessageEvent<Float32Array | { type: string; token?: number }>,
          ) => {
            if (!current()) return;
            if (!(event.data instanceof Float32Array)) {
              if (event.data?.type === 'paused' && event.data.token === runtime.pauseToken) {
                runtime.pauseResolver?.();
                runtime.pauseResolver = null;
              }
              return;
            }
            if (!runtime.active) return;
            if (
              runtime.audio.paused ||
              runtime.audio.seeking ||
              runtime.audio.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
            ) {
              pauseForBuffering();
              return;
            }
            runtime.queue = runtime.queue
              .then(() => api.submitRecordedAudioPcm(event.data as Float32Array, runtime.captureId))
              .catch(failed);
          };
          runtime.audio.onended = () => {
            void finish().catch(failed);
          };
          runtime.audio.onerror = () =>
            failed(new Error('Unable to decode or play this audio file.'));
          runtime.audio.onwaiting = pauseForBuffering;
          runtime.audio.onstalled = pauseForBuffering;
          runtime.audio.onpause = pauseForBuffering;
          runtime.audio.onplaying = () => {
            if (runtime.stalled && !runtime.recovering) void synchronize(false).catch(failed);
          };
          const playAtPosition = async () => {
            if (!current()) return;
            const position = recordedAudioPosition(
              track.offsetMs,
              performance.now() - origin.monotonicMs,
              track.durationMs!,
            );
            if (!position) {
              await api.finishRecordedAudio(runtime.captureId);
              status(track.id, 'End of audio (offset beyond file)');
              return;
            }
            if (position.delayMs > 0) {
              runtime.timeout = setTimeout(() => {
                runtime.timeout = null;
                void playAtPosition().catch(failed);
              }, position.delayMs);
              return;
            }
            await alignRecordedMedia(
              runtime.audio,
              track.offsetMs,
              track.durationMs!,
              origin.monotonicMs,
            );
            await resumeRecordedContext(runtime.context);
            if (!current()) return;
            await startRecordedMedia(runtime.audio);
            if (!current()) return;
            // Playback startup may have taken seconds: seek again and only then
            // arm Whisper. Other tracks are free to start meanwhile.
            await synchronize(true);
          };
          try {
            await playAtPosition();
          } catch (error) {
            failed(error);
          }
        }),
      );
    },
  }));

  useEffect(() => {
    onSelectionChange({
      ready: tracks.every(
        (track) =>
          !track.enabled ||
          (track.durationMs !== null && !track.error && track.label.trim().length > 0),
      ),
      count: tracks.filter((track) => track.enabled).length,
    });
  }, [tracks, onSelectionChange]);

  useEffect(() => {
    if (!running) stop();
  }, [running]);

  useEffect(
    () => () => {
      stop();
      for (const url of urls.current) URL.revokeObjectURL(url);
      urls.current.clear();
    },
    [],
  );

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    const additions = Array.from(files).map((file) => {
      const url = URL.createObjectURL(file);
      urls.current.add(url);
      const id = `recorded-audio-${++nextTrack}`;
      return {
        id,
        url,
        name: file.name,
        label: file.name.replace(/\.[^.]+$/, '').slice(0, 80) || 'Audio',
        enabled: true,
        offsetMs: 0,
        durationMs: null,
        error: null,
      };
    });
    setTracks((previous) => [...previous, ...additions]);
  };

  return (
    <div className="mt-5 border-t border-border pt-4">
      <h3 className="font-medium">Recorded audio tracks</h3>
      <p className="mt-2 text-sm text-zinc-400">
        Add independent audio files (microphone, Discord, or any other source). Each file plays at
        1× on the recorded video timeline, or by itself without video. Audio is not monitored; mono
        PCM flows through the production resampler, VAD and Whisper worker. Positive offsets delay
        the track; negative offsets skip its beginning.
      </p>
      <Label htmlFor="recorded-audio-files" className="mt-4 text-sm text-zinc-200">
        Add audio files
      </Label>
      <input
        id="recorded-audio-files"
        type="file"
        accept="audio/*,.wav,.flac,.mp3,.ogg,.m4a,.aac"
        multiple
        disabled={running}
        onChange={(event) => {
          addFiles(event.currentTarget.files);
          event.currentTarget.value = '';
        }}
        className="mt-2 block w-full text-sm text-zinc-300 file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-2 file:text-secondary-foreground"
      />
      <div className="mt-3 space-y-3">
        {tracks.map((track) => (
          <div key={track.id} className="rounded-md border border-border p-3">
            <audio
              preload="metadata"
              src={track.url}
              className="hidden"
              onLoadedMetadata={(event) => {
                const durationMs = Math.round(event.currentTarget.duration * 1000);
                patch(
                  track.id,
                  Number.isFinite(durationMs) && durationMs > 0
                    ? { durationMs, error: null }
                    : { durationMs: null, error: 'Audio duration is unavailable or invalid.' },
                );
              }}
              onError={() =>
                patch(track.id, {
                  durationMs: null,
                  error: 'File cannot be decoded by Chromium. Choose a supported audio format.',
                })
              }
            />
            <div className="flex items-center justify-between gap-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={track.enabled}
                  disabled={running}
                  onChange={(event) => patch(track.id, { enabled: event.target.checked })}
                />
                {track.name}
              </label>
              <Button
                variant="secondary"
                size="sm"
                disabled={running}
                onClick={() => {
                  setTracks((previous) => previous.filter((item) => item.id !== track.id));
                  URL.revokeObjectURL(track.url);
                  urls.current.delete(track.url);
                }}
              >
                Remove
              </Button>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor={`audio-label-${track.id}`}>Source label</Label>
                <Input
                  id={`audio-label-${track.id}`}
                  value={track.label}
                  maxLength={80}
                  disabled={running}
                  className="mt-1"
                  onChange={(event) => patch(track.id, { label: event.target.value })}
                />
              </div>
              <div>
                <Label htmlFor={`audio-offset-${track.id}`}>Offset (ms, signed)</Label>
                <Input
                  id={`audio-offset-${track.id}`}
                  type="number"
                  step={1}
                  min={-86400000}
                  max={86400000}
                  disabled={running}
                  className="mt-1"
                  value={track.offsetMs}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (Number.isSafeInteger(value) && Math.abs(value) <= 86_400_000)
                      patch(track.id, { offsetMs: value });
                  }}
                />
              </div>
            </div>
            <p role="status" className="mt-2 text-xs text-zinc-400">
              {track.error ??
                (track.enabled && !track.label.trim() ? 'Enter a source label.' : null) ??
                phases[track.id] ??
                (track.durationMs !== null
                  ? `Ready · ${(track.durationMs / 1000).toFixed(1)}s`
                  : 'Checking decoder…')}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
});
