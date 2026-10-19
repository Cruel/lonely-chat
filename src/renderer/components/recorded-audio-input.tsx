import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { recordedAudioPosition } from '../recorded-audio-timeline';
import {
  alignRecordedMedia,
  startRecordedMedia,
  resumeRecordedContext,
  AUDIO_DRIFT_TOLERANCE_MS,
  AUDIO_STALL_TIMEOUT_MS,
} from '../recorded-audio-sync';
import { recordedAudioWorkletSource } from '../recorded-audio-worklet';
import {
  inspectEmbeddedAudio,
  selectEmbeddedAudioTrack,
  type EmbeddedTrackChoice,
} from '../embedded-audio-tracks';
import type { RecordedVideoMedia } from './recorded-video-input';
import {
  recordedPreviewDuration,
  resolveRecordedSegment,
  type RecordedSegment,
} from '../recorded-preview-timeline';
import { RecordedMediaPreview } from './recorded-media-preview';
import { recordedCacheQuery, verifyRecordedCaches } from '../recorded-transcript-cache-client';
import { closeRecordedAudioRuntime, type RecordedAudioRuntime } from '../recorded-audio-runtime';
import type { RecordedTranscriptMode } from '../../shared/recorded-transcript-cache';

interface RecordedAudioTrack {
  kind: 'file' | 'video';
  file: File | null;
  embeddedTrackIndex: number | null;
  embeddedTracks: EmbeddedTrackChoice[] | null;
  id: string;
  url: string;
  name: string;
  label: string;
  enabled: boolean;
  offsetMs: number;
  durationMs: number | null;
  error: string | null;
}

export interface RecordedAudioHandle {
  verifyCache(): Promise<void>;
  prepare(): Promise<void>;
  begin(
    origin: { observedAt: number; monotonicMs: number },
    segment?: RecordedSegment,
  ): Promise<void>;
  stop(): void;
}

let nextTrack = 0;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** File-backed producers; independent of the VLM, native inference cadence, and monitor output. */
export const RecordedAudioInput = forwardRef<
  RecordedAudioHandle,
  {
    running: boolean;
    transcriptMode?: RecordedTranscriptMode;
    onSelectionChange: (state: { ready: boolean; count: number }) => void;
    video?: RecordedVideoMedia | null;
    onSegmentChange?: (state: { segment: RecordedSegment; valid: boolean }) => void;
  }
>(function RecordedAudioInput(
  { running, transcriptMode = 'transcribe', onSelectionChange, video, onSegmentChange },
  ref,
) {
  const [tracks, setTracks] = useState<RecordedAudioTrack[]>([]);
  const [addType, setAddType] = useState<'file' | 'video'>('file');
  const [segment, setSegment] = useState<RecordedSegment>({ startMs: 0, endMs: null });
  const [previewOpen, setPreviewOpen] = useState(false);
  // A soundtrack is attached to one specific video selection, never its replacement.
  const activeTracks = useMemo(
    () => tracks.filter((track) => track.kind === 'file' || track.url === video?.url),
    [tracks, video?.url],
  );
  const previewTracks = useMemo(
    () =>
      activeTracks.map(({ id, url, label, enabled, offsetMs, durationMs, embeddedTrackIndex }) => ({
        id,
        url,
        label,
        enabled,
        offsetMs,
        durationMs,
        embeddedTrackIndex,
      })),
    [activeTracks],
  );
  const previewDurationMs = recordedPreviewDuration(video?.durationMs ?? null, previewTracks);
  const hasMedia = Boolean(video) || activeTracks.some((track) => track.enabled);
  const segmentValid =
    previewDurationMs === 0
      ? segment.startMs === 0 && segment.endMs === null
      : resolveRecordedSegment(segment, previewDurationMs) !== null;
  const [phases, setPhases] = useState<Record<string, string>>({});
  const [cacheState, setCacheState] = useState<{ ready: boolean; text: string }>({
    ready: false,
    text: 'Checking saved transcripts…',
  });
  const [speechModelRevision, setSpeechModelRevision] = useState(0);
  useEffect(() => {
    if (transcriptMode !== 'cached') return;
    return window.lonelyChat?.onModelsChange(() =>
      setSpeechModelRevision((revision) => revision + 1),
    );
  }, [transcriptMode]);
  const tracksRef = useRef(tracks);
  tracksRef.current = activeTracks;
  useEffect(() => {
    setTracks((previous) =>
      previous.filter((track) => track.kind === 'file' || track.url === video?.url),
    );
  }, [video?.url]);
  useEffect(() => setPreviewOpen(false), [video?.url]);
  useEffect(() => {
    if (running) setPreviewOpen(false);
  }, [running]);
  useEffect(() => {
    onSegmentChange?.({ segment, valid: segmentValid });
  }, [segment, segmentValid, onSegmentChange]);
  const runtimes = useRef(new Map<string, RecordedAudioRuntime>());
  const urls = useRef(new Set<string>());
  const generation = useRef(0);
  const segmentRef = useRef(segment);
  segmentRef.current = segment;

  const patch = (id: string, changes: Partial<RecordedAudioTrack>) => {
    setTracks((previous) =>
      previous.map((track) => (track.id === id ? { ...track, ...changes } : track)),
    );
  };
  const status = (id: string, phase: string) =>
    setPhases((previous) => ({ ...previous, [id]: phase }));

  const close = closeRecordedAudioRuntime;
  const stop = () => {
    ++generation.current;
    for (const runtime of runtimes.current.values()) close(runtime);
    runtimes.current.clear();
  };

  const cacheDuration = () => recordedPreviewDuration(video?.durationMs ?? null, tracksRef.current);
  const makeCacheQuery = (track: RecordedAudioTrack, sampleRate: number) =>
    recordedCacheQuery(track, sampleRate, segmentRef.current, cacheDuration());

  const verifyCache = async (): Promise<void> => {
    if (transcriptMode === 'transcribe') return;
    const api = window.lonelyChat;
    if (!api) throw new Error('Desktop transcript cache integration is unavailable.');
    await verifyRecordedCaches(
      transcriptMode,
      tracksRef.current,
      segmentRef.current,
      cacheDuration(),
      (query) => api.checkRecordedAudioCache(query),
    );
  };

  useEffect(() => {
    if (transcriptMode === 'transcribe') return;
    let canceled = false;
    setCacheState({ ready: false, text: 'Checking media fingerprint and transcript cache…' });
    void verifyCache().then(
      () => {
        if (!canceled)
          setCacheState({
            ready: true,
            text:
              transcriptMode === 'cached'
                ? 'Cached transcripts available for all selected tracks'
                : 'Ready to transcribe and save text-only caches',
          });
      },
      (error: unknown) => {
        if (!canceled) setCacheState({ ready: false, text: errorText(error) });
      },
    );
    return () => {
      canceled = true;
    };
  }, [transcriptMode, activeTracks, segment, video?.durationMs, speechModelRevision]);

  useImperativeHandle(ref, () => ({
    stop,
    verifyCache,
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
          let runtime: RecordedAudioRuntime | null = null;
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
            if (track.kind === 'video') {
              if (audio.readyState < HTMLMediaElement.HAVE_METADATA) {
                await new Promise<void>((resolve, reject) => {
                  const timer = setTimeout(() => {
                    audio.removeEventListener('loadedmetadata', loaded);
                    audio.removeEventListener('error', failed);
                    reject(new Error('Embedded soundtrack metadata timed out.'));
                  }, AUDIO_STALL_TIMEOUT_MS);
                  const cleanup = () => {
                    clearTimeout(timer);
                    audio.removeEventListener('loadedmetadata', loaded);
                    audio.removeEventListener('error', failed);
                  };
                  const loaded = () => {
                    cleanup();
                    resolve();
                  };
                  const failed = () => {
                    cleanup();
                    reject(new Error('Unable to decode the embedded soundtrack.'));
                  };
                  audio.addEventListener('loadedmetadata', loaded);
                  audio.addEventListener('error', failed);
                  audio.load();
                });
              }
              if (currentGeneration !== generation.current) {
                await context.close();
                return;
              }
              selectEmbeddedAudioTrack(audio, track.embeddedTrackIndex);
            }
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
              endTimer: null,
              completed: false,
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
              cached: transcriptMode === 'cached',
            };
            const current = runtime;
            const cache =
              transcriptMode === 'transcribe'
                ? undefined
                : {
                    ...(await makeCacheQuery(track, context.sampleRate)),
                    mode: transcriptMode,
                  };
            const answer = await api.startRecordedAudio({
              ...(cache ? { cache } : {}),
              id: track.id,
              label: track.label,
              captureId,
              sampleRate: context.sampleRate,
              offsetMs: track.offsetMs,
              seekMs: Math.max(0, segmentRef.current.startMs - track.offsetMs),
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
            if (transcriptMode === 'cached') throw error;
          }
        }),
      );
    },
    async begin(origin, segment = { startMs: 0, endMs: null }) {
      // Shift the media coordinate while preserving observedAt at the start of the clip.
      origin = {
        observedAt: origin.observedAt - segment.startMs,
        monotonicMs: origin.monotonicMs - segment.startMs,
      };
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
            // HTMLMediaElement fires pause immediately before ended. Chromium
            // may not set ended until after pause, so also check media position.
            // Preserve partial PCM for EOF, but fail if the expected end never arrives.
            if (
              runtime.audio.ended ||
              runtime.audio.currentTime * 1000 >= track.durationMs! - 150
            ) {
              if (runtime.stallTimer === null)
                runtime.stallTimer = setTimeout(
                  () => failed(new Error('Recorded audio did not complete at end of file.')),
                  AUDIO_STALL_TIMEOUT_MS,
                );
              return;
            }
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
            if (!current() || runtime.completed) return;
            runtime.completed = true;
            if (runtime.endTimer !== null) clearTimeout(runtime.endTimer);
            runtime.endTimer = null;
            if (runtime.timeout !== null) clearTimeout(runtime.timeout);
            runtime.timeout = null;
            runtime.active = false;
            runtime.started = false;
            // Freeze decoding at the clip boundary before worklet/Whisper draining.
            // Do not clear the buffered PCM: onpause sees started=false.
            runtime.audio.pause();
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
                  if (!runtime.cached && event.data.length > 0) {
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
          if (segment.endMs !== null) {
            const remainingMs = Math.max(
              0,
              segment.endMs - (performance.now() - origin.monotonicMs),
            );
            runtime.endTimer = setTimeout(() => {
              void finish().catch(failed);
            }, remainingMs);
          }
          const synchronize = async (first: boolean) => {
            if (!current() || runtime.completed || runtime.recovering) return;
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
                  if (runtime.audio.ended) return;
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
            if (!runtime.active || runtime.cached) return;
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
            else clearStall();
          };
          const playAtPosition = async () => {
            if (!current() || runtime.completed) return;
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
            if (!current() || runtime.completed) {
              runtime.audio.pause();
              return;
            }
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
      ready:
        segmentValid &&
        (transcriptMode === 'transcribe' || cacheState.ready) &&
        activeTracks.every(
          (track) =>
            !track.enabled ||
            (track.durationMs !== null && !track.error && track.label.trim().length > 0),
        ),
      count: activeTracks.filter((track) => track.enabled).length,
    });
  }, [activeTracks, onSelectionChange, segmentValid, transcriptMode, cacheState.ready]);

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
        kind: 'file' as const,
        file,
        embeddedTrackIndex: null,
        embeddedTracks: null,
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

  const addVideoAudio = () => {
    if (!video || running) return;
    setTracks((previous) => [
      ...previous,
      {
        kind: 'video',
        file: video.file ?? null,
        embeddedTrackIndex: null,
        embeddedTracks: null,
        id: `recorded-audio-${++nextTrack}`,
        url: video.url,
        name: `Audio from ${video.name}`,
        label: 'Video soundtrack',
        enabled: true,
        offsetMs: 0,
        durationMs: null,
        error: null,
      },
    ]);
  };

  return (
    <div className="mt-5 border-t border-border pt-4">
      <h3 className="font-medium">Recorded audio tracks</h3>
      <p className="mt-2 text-sm text-zinc-400">
        Add independent audio files or explicitly capture the video soundtrack. Every enabled source
        plays at 1× on the shared timeline and feeds the production resampler, VAD and Whisper
        worker. Audio is not monitored. Positive offsets delay a track; negative offsets skip its
        beginning.
      </p>
      {transcriptMode !== 'transcribe' && (
        <p
          role="status"
          className={`mt-2 text-xs ${cacheState.ready ? 'text-zinc-400' : 'text-amber-300'}`}
        >
          {cacheState.text}
        </p>
      )}
      <Label htmlFor="recorded-audio-type" className="mt-4 text-sm text-zinc-200">
        Audio source type
      </Label>
      <Select
        items={[
          { value: 'file', label: 'Audio files' },
          { value: 'video', label: 'Audio from video' },
        ]}
        value={addType}
        onValueChange={(value) => setAddType(value as 'file' | 'video')}
        disabled={running}
      >
        <SelectTrigger id="recorded-audio-type" className="mt-2">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="file">Audio files</SelectItem>
          <SelectItem value="video">Audio from video</SelectItem>
        </SelectContent>
      </Select>
      {addType === 'file' ? (
        <>
          <Label htmlFor="recorded-audio-files" className="mt-3 text-sm text-zinc-200">
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
        </>
      ) : (
        <div className="mt-3">
          <Button variant="secondary" disabled={running || !video} onClick={addVideoAudio}>
            Add audio from video
          </Button>
          <p className="mt-2 text-xs text-zinc-400">
            {video
              ? 'Captures the selected video soundtrack only when added below. Separate tracks can be selected only if Chromium exposes them; otherwise the mix remains one source.'
              : 'Select a recorded video above before adding its soundtrack.'}
          </p>
        </div>
      )}
      <div className="mt-3 space-y-3">
        {activeTracks.map((track) => (
          <div key={track.id} className="rounded-md border border-border p-3">
            <audio
              preload="metadata"
              src={track.url}
              className="hidden"
              onLoadedMetadata={(event) => {
                const durationMs = Math.round(event.currentTarget.duration * 1000);
                const embedded =
                  track.kind === 'video' ? inspectEmbeddedAudio(event.currentTarget) : null;
                const valid = Number.isFinite(durationMs) && durationMs > 0;
                const index = track.embeddedTrackIndex;
                const missingTrack =
                  embedded?.tracks &&
                  index !== null &&
                  !embedded.tracks.some((item) => item.index === index);
                patch(track.id, {
                  durationMs: valid ? durationMs : null,
                  embeddedTracks: embedded?.tracks ?? null,
                  embeddedTrackIndex: embedded?.tracks?.length && index === null ? 0 : index,
                  error: !valid
                    ? 'Audio duration is unavailable or invalid.'
                    : (embedded?.error ??
                      (missingTrack ? 'Selected embedded audio track is unavailable.' : null)),
                });
              }}
              onError={() =>
                patch(track.id, {
                  durationMs: null,
                  error:
                    track.kind === 'video'
                      ? 'Embedded soundtrack cannot be decoded by Chromium.'
                      : 'File cannot be decoded by Chromium. Choose a supported audio format.',
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
                  if (track.kind === 'file') {
                    URL.revokeObjectURL(track.url);
                    urls.current.delete(track.url);
                  }
                }}
              >
                Remove
              </Button>
            </div>
            {track.kind === 'video' && track.embeddedTracks && track.embeddedTracks.length > 1 && (
              <div className="mt-3">
                <Label htmlFor={`audio-embedded-${track.id}`}>Embedded audio track</Label>
                <Select
                  items={track.embeddedTracks.map((choice) => ({
                    value: String(choice.index),
                    label: choice.label,
                  }))}
                  value={String(track.embeddedTrackIndex ?? 0)}
                  disabled={running}
                  onValueChange={(value) =>
                    patch(track.id, { embeddedTrackIndex: Number(value), error: null })
                  }
                >
                  <SelectTrigger id={`audio-embedded-${track.id}`} className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {track.embeddedTracks.map((choice) => (
                      <SelectItem key={choice.index} value={String(choice.index)}>
                        {choice.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
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
      <div className="mt-5 border-t border-border pt-4">
        <h3 className="font-medium">Recorded segment and preview</h3>
        <p className="mt-2 text-xs text-zinc-400">
          Segment times are on the shared presentation timeline. End defaults to the longest enabled
          media source, including offsets. A preview never creates transcripts or chat.
        </p>
        <div className="mt-3 grid max-w-xl gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="recorded-segment-start">Start (ms)</Label>
            <Input
              id="recorded-segment-start"
              type="number"
              min={0}
              step={1}
              value={segment.startMs}
              disabled={running}
              className="mt-1"
              onChange={(event) =>
                setSegment((previous) => ({ ...previous, startMs: Number(event.target.value) }))
              }
            />
          </div>
          <div>
            <Label htmlFor="recorded-segment-end">End (ms, blank = automatic)</Label>
            <Input
              id="recorded-segment-end"
              type="number"
              min={1}
              step={1}
              placeholder={previewDurationMs ? String(previewDurationMs) : 'No duration'}
              value={segment.endMs ?? ''}
              disabled={running}
              className="mt-1"
              onChange={(event) =>
                setSegment((previous) => ({
                  ...previous,
                  endMs: event.target.value === '' ? null : Number(event.target.value),
                }))
              }
            />
          </div>
        </div>
        {!segmentValid && (
          <p role="alert" className="mt-2 text-sm text-rose-300">
            Segment must start at or after 0 ms, end after start, and not exceed the
            {previewDurationMs} ms enabled-media duration.
          </p>
        )}
        <div className="mt-3">
          <Button
            variant="secondary"
            disabled={running || !hasMedia || !previewDurationMs || !segmentValid}
            onClick={() => setPreviewOpen((previous) => !previous)}
          >
            {previewOpen ? 'Close preview' : 'Open media preview'}
          </Button>
        </div>
        {previewOpen && !running && segmentValid && (
          <RecordedMediaPreview
            video={video ?? null}
            tracks={previewTracks}
            segment={segment}
            durationMs={previewDurationMs}
            onClose={() => setPreviewOpen(false)}
          />
        )}
      </div>
    </div>
  );
});
