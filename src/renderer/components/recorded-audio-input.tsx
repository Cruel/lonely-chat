import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { recordedAudioPosition } from '../recorded-audio-timeline';
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
  active: boolean;
  queue: Promise<void>;
  flushResolver: (() => void) | null;
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
    if (runtime.timeout !== null) clearTimeout(runtime.timeout);
    runtime.audio.pause();
    runtime.flushResolver?.();
    runtime.flushResolver = null;
    runtime.audio.onended = null;
    runtime.audio.onerror = null;
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
              active: false,
              queue: Promise.resolve(),
              flushResolver: null,
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
      const pending: Promise<void>[] = [];
      for (const track of tracksRef.current) {
        const runtime = runtimes.current.get(track.id);
        if (!runtime || !track.enabled || track.durationMs === null) continue;
        pending.push(
          (async () => {
            const captureGeneration = runtime.generation;
            const failed = (error: unknown) => {
              if (generation.current !== captureGeneration) return;
              status(track.id, `Audio error: ${errorText(error)}`);
              runtime.active = false;
              close(runtime);
              runtimes.current.delete(track.id);
            };
            try {
              if (captureGeneration !== generation.current) return;
              const finish = async () => {
                runtime.active = false;
                await new Promise<void>((resolve) => {
                  runtime.flushResolver = resolve;
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
                      runtime.flushResolver = null;
                      resolve();
                    }
                  };
                  runtime.node.port.postMessage('flush');
                });
                await runtime.queue;
                if (captureGeneration !== generation.current) return;
                await api.finishRecordedAudio(runtime.captureId);
                status(track.id, 'End of audio');
              };
              runtime.node.port.onmessage = (event: MessageEvent<Float32Array>) => {
                if (!runtime.active || !(event.data instanceof Float32Array)) return;
                runtime.queue = runtime.queue
                  .then(() => api.submitRecordedAudioPcm(event.data, runtime.captureId))
                  .catch(failed);
              };
              runtime.audio.onended = () => {
                void finish().catch(failed);
              };
              runtime.audio.onerror = () =>
                failed(new Error('Unable to decode or play this audio file.'));
              const playAtPosition = async () => {
                if (captureGeneration !== generation.current) return;
                const elapsed = performance.now() - origin.monotonicMs;
                const position = recordedAudioPosition(track.offsetMs, elapsed, track.durationMs!);
                if (!position) {
                  await api.finishRecordedAudio(runtime.captureId);
                  status(track.id, 'End of audio (offset beyond file)');
                  return;
                }
                if (position.delayMs > 0) {
                  runtime.timeout = setTimeout(() => {
                    void playAtPosition().catch(failed);
                  }, position.delayMs);
                  return;
                }
                runtime.audio.currentTime = position.mediaMs / 1000;
                await api.armRecordedAudio(runtime.captureId, origin.observedAt, position.mediaMs);
                await runtime.context.resume();
                if (captureGeneration !== generation.current) return;
                runtime.active = true;
                runtime.node.port.postMessage('start');
                await runtime.audio.play();
                status(track.id, 'Playing at 1×');
              };
              await playAtPosition();
            } catch (error) {
              failed(error);
            }
          })(),
        );
      }
      await Promise.all(pending);
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
