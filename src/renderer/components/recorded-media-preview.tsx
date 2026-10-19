import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { selectEmbeddedAudioTrack } from '../embedded-audio-tracks';
import {
  previewMediaPosition,
  previewMonitorGain,
  type PreviewTrack,
  type RecordedSegment,
} from '../recorded-preview-timeline';
import type { RecordedVideoMedia } from './recorded-video-input';

interface MonitorSettings {
  muted: boolean;
  solo: boolean;
  volume: number;
}

const defaultMonitor = (): MonitorSettings => ({ muted: true, solo: false, volume: 1 });
const ERROR_TOLERANCE_MS = 150;

export function RecordedMediaPreview({
  video,
  tracks,
  segment,
  durationMs,
  onClose,
}: {
  video: RecordedVideoMedia | null;
  tracks: readonly PreviewTrack[];
  segment: RecordedSegment;
  durationMs: number;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const knownMedia = useRef(new Set<HTMLMediaElement>());
  const audioRefs = useRef(new Map<string, HTMLAudioElement>());
  const audioRefCallbacks = useRef(new Map<string, (node: HTMLAudioElement | null) => void>());
  const registerVideo = useCallback((node: HTMLVideoElement | null) => {
    videoRef.current = node;
    if (node) knownMedia.current.add(node);
  }, []);
  const audioRefFor = (id: string) => {
    let callback = audioRefCallbacks.current.get(id);
    if (!callback) {
      callback = (node) => {
        if (node) {
          audioRefs.current.set(id, node);
          knownMedia.current.add(node);
        } else {
          audioRefs.current.get(id)?.pause();
          audioRefs.current.delete(id);
        }
      };
      audioRefCallbacks.current.set(id, callback);
    }
    return callback;
  };
  const [positionMs, setPositionMs] = useState(segment.startMs);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [monitor, setMonitor] = useState<Record<string, MonitorSettings>>({});
  const clock = useRef({ positionMs: segment.startMs, startedMs: performance.now() });
  const playingRef = useRef(false);
  const positionRef = useRef(segment.startMs);
  const active = useMemo(
    () => tracks.filter((track) => track.enabled && track.durationMs !== null),
    [tracks],
  );
  const anySolo = active.some((track) => monitor[track.id]?.solo);
  const endMs = segment.endMs ?? durationMs;

  const pause = useCallback(() => {
    playingRef.current = false;
    setPlaying(false);
    videoRef.current?.pause();
    for (const audio of audioRefs.current.values()) audio.pause();
  }, []);

  const synchronize = useCallback(
    (ms: number, play: boolean, exact = false) => {
      for (const track of active) {
        const audio = audioRefs.current.get(track.id);
        if (!audio) continue;
        const mediaMs = previewMediaPosition(ms, track.offsetMs, track.durationMs!);
        if (mediaMs === null || ms >= endMs) {
          audio.pause();
          continue;
        }
        try {
          selectEmbeddedAudioTrack(audio, track.embeddedTrackIndex);
          if (exact || Math.abs(audio.currentTime * 1000 - mediaMs) > ERROR_TOLERANCE_MS)
            audio.currentTime = mediaMs / 1000;
          const settings = monitor[track.id] ?? defaultMonitor();
          const gain = previewMonitorGain(
            settings.muted,
            settings.solo,
            Boolean(anySolo),
            settings.volume,
          );
          audio.muted = gain === 0;
          audio.volume = gain;
          if (play && audio.paused) {
            void audio.play().catch((reason: unknown) => {
              if (playingRef.current)
                setError(
                  reason instanceof Error ? reason.message : 'Unable to play audio preview.',
                );
            });
          }
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : 'Unable to select audio track.');
          audio.pause();
        }
      }
    },
    [active, endMs, monitor, anySolo],
  );

  const seek = (ms: number) => {
    const clamped = Math.max(segment.startMs, Math.min(endMs, ms));
    positionRef.current = clamped;
    setPositionMs(clamped);
    clock.current = { positionMs: clamped, startedMs: performance.now() };
    const element = videoRef.current;
    if (element) {
      const videoEndMs = video?.durationMs ?? Infinity;
      if (clamped >= videoEndMs) element.pause();
      element.currentTime = Math.min(clamped, videoEndMs) / 1000;
    }
    synchronize(clamped, playingRef.current, true);
    if (clamped >= endMs) pause();
  };

  const play = async () => {
    if (endMs <= segment.startMs) return;
    const from = positionRef.current >= endMs ? segment.startMs : positionRef.current;
    seek(from);
    playingRef.current = true;
    setPlaying(true);
    setError(null);
    clock.current = { positionMs: from, startedMs: performance.now() };
    try {
      // Begin all elements from the same user gesture (before awaiting the video).
      synchronize(from, true);
      // An expired video must stay paused while longer audio continues playing.
      if (videoRef.current && from < (video?.durationMs ?? Infinity)) await videoRef.current.play();
    } catch (reason) {
      pause();
      setError(reason instanceof Error ? reason.message : 'Unable to play recorded preview.');
    }
  };

  // Actual decoded media timestamps drive sync when video is active (including variable frame rate).
  // For audio-only previews and time after video EOF, the same 1x monotonic timeline advances.
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      if (!playingRef.current) return;
      const element = videoRef.current;
      const wallPosition = clock.current.positionMs + performance.now() - clock.current.startedMs;
      const mediaPosition =
        element &&
        wallPosition < (video?.durationMs ?? Infinity) &&
        !element.ended &&
        element.currentTime * 1000 < (video?.durationMs ?? Infinity)
          ? element.currentTime * 1000
          : wallPosition;
      const nextMs = Math.min(endMs, Math.max(segment.startMs, mediaPosition));
      positionRef.current = nextMs;
      setPositionMs(nextMs);
      if (nextMs >= endMs) {
        pause();
        return;
      }
      synchronize(nextMs, true);
    }, 80);
    return () => clearInterval(timer);
  }, [playing, video, endMs, segment.startMs, synchronize, pause]);

  useEffect(() => {
    // Source offsets and enabled tracks are explicit timeline edits, not playback drift.
    synchronize(positionRef.current, playingRef.current, true);
  }, [active, synchronize]);

  useEffect(() => {
    // Always destroy preview decoders on close, independent of inference services.
    return () => {
      for (const element of knownMedia.current) element.pause();
      knownMedia.current.clear();
      audioRefs.current.clear();
      audioRefCallbacks.current.clear();
      playingRef.current = false;
    };
  }, []);

  const setSettings = (id: string, changes: Partial<MonitorSettings>) => {
    setMonitor((previous) => ({
      ...previous,
      [id]: { ...defaultMonitor(), ...previous[id], ...changes },
    }));
  };

  return (
    <section
      aria-label="Recorded media preview"
      className="mt-4 rounded-lg border border-border p-4"
    >
      <div className="flex items-center justify-between gap-3">
        <h4 className="font-medium">Pre-run media preview</h4>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            pause();
            onClose();
          }}
        >
          Close preview
        </Button>
      </div>
      <p className="mt-2 text-xs text-zinc-400">
        Scrub and listen without starting a Simulation. Monitoring is muted by default and never
        changes the audio sent to Whisper.
      </p>
      {video && (
        <video
          ref={registerVideo}
          aria-label="Preview video"
          src={video.url}
          preload="auto"
          playsInline
          muted
          className="mt-3 max-h-60 w-full rounded-md bg-black object-contain"
          onError={() => setError('Video preview could not decode this file.')}
        />
      )}
      {active.map((track) => {
        const settings = monitor[track.id] ?? defaultMonitor();
        return (
          <div key={track.id} className="mt-3 rounded-md border border-border p-3">
            <audio
              aria-label={`Preview audio: ${track.label}`}
              ref={audioRefFor(track.id)}
              src={track.url}
              preload="auto"
              muted
              onLoadedMetadata={(event) => {
                try {
                  selectEmbeddedAudioTrack(event.currentTarget, track.embeddedTrackIndex);
                } catch (reason) {
                  setError(
                    reason instanceof Error ? reason.message : 'Unsupported embedded track.',
                  );
                }
              }}
              onError={() => setError(`Cannot decode preview audio: ${track.label}`)}
            />
            <p className="text-sm">
              {track.label} · offset {track.offsetMs} ms
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={!settings.muted}
                  onChange={(event) => setSettings(track.id, { muted: !event.target.checked })}
                />
                Monitor {track.label}
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={settings.solo}
                  onChange={(event) => setSettings(track.id, { solo: event.target.checked })}
                />
                Solo {track.label}
              </label>
              <div className="flex items-center gap-2">
                <Label htmlFor={`preview-volume-${track.id}`}>Volume {track.label}</Label>
                <Input
                  id={`preview-volume-${track.id}`}
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  className="w-24"
                  value={Math.round(settings.volume * 100)}
                  onChange={(event) =>
                    setSettings(track.id, { volume: Number(event.target.value) / 100 })
                  }
                />
              </div>
            </div>
          </div>
        );
      })}
      <div className="mt-3 flex items-center gap-3">
        <Button
          variant="secondary"
          onClick={() => {
            if (playing) pause();
            else void play();
          }}
        >
          {playing ? 'Pause preview' : 'Play preview'}
        </Button>
        <span role="status" className="text-sm text-zinc-400">
          {(positionMs / 1000).toFixed(3)}s / {(endMs / 1000).toFixed(3)}s
        </span>
      </div>
      <Label htmlFor="recorded-preview-position" className="mt-3 block">
        Seek (ms)
      </Label>
      <Input
        id="recorded-preview-position"
        type="range"
        min={segment.startMs}
        max={endMs}
        step={1}
        value={positionMs}
        onChange={(event) => seek(Number(event.target.value))}
        className="mt-2 w-full"
      />
      {error && (
        <p role="alert" className="mt-3 text-sm text-rose-300">
          {error}
        </p>
      )}
    </section>
  );
}
