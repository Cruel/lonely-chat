import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Label } from '@/components/ui/label';
import { RecordedVideoTimeline } from '../recorded-video-timeline';
import { reportRecordedIssue } from '../recorded-media-health-client';
import type { RecordedSegment } from '../recorded-preview-timeline';
import {
  seekRecordedMedia,
  startRecordedMedia,
  AUDIO_STALL_TIMEOUT_MS,
} from '../recorded-audio-sync';

const VIDEO_CATCHUP_DRIFT_MS = 450;

export interface RecordedVideoMedia {
  url: string;
  file?: File;
  path?: string;
  name: string;
  durationMs?: number | null;
}

export interface RecordedVideoHandle {
  begin(
    captureIntervalMs: number,
    origin?: { observedAt: number; monotonicMs: number },
    segment?: RecordedSegment,
  ): Promise<void>;
  stop(): void;
  pause(): void;
  resume(): Promise<void>;
  snapshot(): { path: string } | null;
}

export const RecordedVideoInput = forwardRef<
  RecordedVideoHandle,
  {
    running: boolean;
    onSelectionChange: (state: { hasFile: boolean; ready: boolean }) => void;
    onMediaChange?: (media: RecordedVideoMedia | null) => void;
    onEnded?: () => void;
    restore?: { key: string; path: string | null };
  }
>(function RecordedVideoInput(
  { running, onSelectionChange, onMediaChange, onEnded, restore },
  ref,
) {
  const video = useRef<HTMLVideoElement>(null);
  const selectedFile = useRef<File | null>(null);
  const selectedPath = useRef<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState('No file (video optional)');
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const epoch = useRef(0);
  const inFlight = useRef(false);
  const suspendedAt = useRef<number | null>(null);
  const resumePlayback = useRef<((elapsed: number) => Promise<void>) | null>(null);

  const stop = () => {
    ++epoch.current;
    suspendedAt.current = null;
    resumePlayback.current = null;
    if (video.current) video.current.onended = null;
    if (timer.current !== null) clearInterval(timer.current);
    timer.current = null;
    video.current?.pause();
  };

  useImperativeHandle(
    ref,
    () => ({
      stop,
      snapshot: () => (selectedPath.current ? { path: selectedPath.current } : null),
      pause() {
        if (suspendedAt.current !== null || !resumePlayback.current) return;
        suspendedAt.current = performance.now();
        video.current?.pause();
      },
      async resume() {
        if (suspendedAt.current === null) return;
        const elapsed = Math.max(0, performance.now() - suspendedAt.current);
        suspendedAt.current = null;
        await resumePlayback.current?.(elapsed);
      },
      async begin(captureIntervalMs: number, origin, segment = { startMs: 0, endMs: null }) {
        if (!url) return;
        const element = video.current;
        if (!element || !ready || element.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
          throw new Error('Selected video is not yet decodable.');
        }
        const api = window.lonelyChat;
        if (!api) throw new Error('Desktop media integration is unavailable.');
        stop();
        const generation = epoch.current;
        element.pause();
        element.playbackRate = 1;
        element.muted = true; // Embedded audio must not leak into live monitoring or STT.
        const originObservationMs = origin?.observedAt ?? (await api.getVideoClock());
        let originMonotonicMs = origin?.monotonicMs ?? performance.now();
        if (generation !== epoch.current) return;
        const mediaElapsedMs = () => Math.max(0, performance.now() - originMonotonicMs);
        const expectedMediaMs = () => {
          const elapsed = segment.startMs + mediaElapsedMs();
          const fileEnd = Number.isFinite(element.duration)
            ? Math.max(0, element.duration * 1000 - 10)
            : Infinity;
          return Math.min(elapsed, fileEnd);
        };
        const timeline = new RecordedVideoTimeline(
          originObservationMs,
          originMonotonicMs,
          captureIntervalMs,
        );
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        if (!context) throw new Error('JPEG decoding/capture is unavailable.');
        resumePlayback.current = async (elapsed) => {
          originMonotonicMs += elapsed;
          timeline.shiftObservationTime(elapsed);
          if (generation !== epoch.current || element.ended) return;
          await startRecordedMedia(element);
        };
        let synchronizing = false;
        let stalledAt: number | null = null;
        let droppedFrames = element.getVideoPlaybackQuality?.().droppedVideoFrames ?? 0;
        let lastDropReportAt = 0;
        let lastDelayReportAt = 0;
        const failPlayback = (reason: unknown) => {
          if (generation !== epoch.current) return;
          const message =
            reason instanceof Error ? reason.message : 'Unable to synchronize recorded video.';
          setError(message);
          stop();
          reportRecordedIssue({
            kind: 'video',
            sourceId: 'recorded:video',
            code: /stall/i.test(message) ? 'stall' : 'decoder',
            fatal: true,
          });
        };
        const capture = () => {
          if (
            generation !== epoch.current ||
            suspendedAt.current !== null ||
            inFlight.current ||
            synchronizing ||
            element.ended
          )
            return;
          if (segment.endMs !== null && segment.startMs + mediaElapsedMs() >= segment.endMs) {
            if (timer.current !== null) clearInterval(timer.current);
            timer.current = null;
            element.pause();
            setStatus('End of selected video segment');
            onEnded?.();
            return;
          }
          if (element.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || element.paused) {
            stalledAt ??= performance.now();
            if (performance.now() - stalledAt >= AUDIO_STALL_TIMEOUT_MS)
              failPlayback(new Error('Recorded video playback stalled.'));
            return;
          }
          stalledAt = null;
          const now = performance.now();
          const quality = element.getVideoPlaybackQuality?.();
          if (
            quality &&
            quality.droppedVideoFrames > droppedFrames &&
            now - lastDropReportAt >= 1000
          ) {
            reportRecordedIssue({
              kind: 'video',
              sourceId: 'recorded:video',
              code: 'frame-drop',
              fatal: false,
              count: quality.droppedVideoFrames - droppedFrames,
            });
            lastDropReportAt = now;
          }
          if (quality) droppedFrames = quality.droppedVideoFrames;
          const expected = expectedMediaMs();
          if (expected - element.currentTime * 1000 > VIDEO_CATCHUP_DRIFT_MS) {
            if (now - lastDelayReportAt >= 1000) {
              reportRecordedIssue({
                kind: 'video',
                sourceId: 'recorded:video',
                code: 'decode-delay',
                fatal: false,
                count: Math.min(86_400_000, Math.round(expected - element.currentTime * 1000)),
              });
              lastDelayReportAt = now;
            }
            synchronizing = true;
            void seekRecordedMedia(element, expected)
              .catch(failPlayback)
              .finally(() => {
                synchronizing = false;
              });
            return;
          }
          const timestamp = timeline.sample(element.currentTime, performance.now());
          if (!timestamp) return;
          const scale = Math.min(1, 320 / element.videoWidth, 180 / element.videoHeight);
          if (!Number.isFinite(scale) || scale <= 0) return;
          canvas.width = Math.max(1, Math.round(element.videoWidth * scale));
          canvas.height = Math.max(1, Math.round(element.videoHeight * scale));
          let dataUrl: string;
          try {
            context.drawImage(element, 0, 0, canvas.width, canvas.height);
            dataUrl = canvas.toDataURL('image/jpeg', 0.65);
          } catch (error) {
            failPlayback(error);
            return;
          }
          inFlight.current = true;
          void api
            .submitVideoFrame({
              sourceId: 'recorded:video',
              ...timestamp,
              width: canvas.width,
              height: canvas.height,
              dataUrl,
            })
            .catch((reason: unknown) => {
              if (generation === epoch.current) {
                const message =
                  reason instanceof Error ? reason.message : 'Unable to submit video frame.';
                setError(message);
                stop();
                reportRecordedIssue({
                  kind: 'video',
                  sourceId: 'recorded:video',
                  code: 'decoder',
                  fatal: true,
                });
              }
            })
            .finally(() => {
              inFlight.current = false;
            });
        };
        try {
          await seekRecordedMedia(element, expectedMediaMs());
          if (generation !== epoch.current) return;
          await startRecordedMedia(element);
          if (generation !== epoch.current) {
            element.pause();
            return;
          }
          element.onended = () => {
            if (generation !== epoch.current) return;
            if (timer.current !== null) clearInterval(timer.current);
            timer.current = null;
            setStatus('End of video');
            onEnded?.();
          };
          setStatus('Playing at 1×');
          setError(null);
          capture();
          // Decode independently of inference (including in-flight retries). Polling also
          // works when requestVideoFrameCallback is throttled on a hidden desktop page.
          timer.current = setInterval(capture, Math.min(250, captureIntervalMs));
        } catch (reason) {
          stop();
          throw new Error(
            `Unable to play selected video: ${reason instanceof Error ? reason.message : String(reason)}`,
          );
        }
      },
    }),
    [ready, url, onEnded],
  );

  useEffect(() => {
    onSelectionChange({
      hasFile: url !== null || selectedPath.current !== null,
      ready: (!url && selectedPath.current === null) || ready,
    });
  }, [url, ready, onSelectionChange]);

  // The URL is owned by this component. Consumers must discard it on unmount,
  // including when switching away from Recorded Simulation or the Simulation page.
  useEffect(() => () => onMediaChange?.(null), [onMediaChange]);

  useEffect(() => {
    if (!running) stop();
    return () => {}; // Running while another navigation category is open keeps the producer mounted.
  }, [running]);

  useEffect(
    () => () => {
      stop();
      if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
    },
    [url],
  );

  const selectFile = (file: File | undefined) => {
    stop();
    selectedFile.current = file ?? null;
    selectedPath.current = file ? (window.lonelyChat?.pathForRecordedFile?.(file) ?? null) : null;
    setReady(false);
    setError(null);
    if (!file) {
      onMediaChange?.(null);
      setUrl(null);
      setFileName(null);
      setReady(true);
      setStatus('No file (video optional)');
      return;
    }
    const nextUrl = URL.createObjectURL(file);
    onMediaChange?.({
      url: nextUrl,
      name: file.name,
      file,
      ...(selectedPath.current ? { path: selectedPath.current } : {}),
    });
    setFileName(file.name);
    setUrl(nextUrl);
    setStatus('Checking Chromium video decoder…');
  };

  const selectPath = async (filePath: string | null) => {
    stop();
    selectedFile.current = null;
    selectedPath.current = filePath;
    setReady(false);
    setError(null);
    if (!filePath) {
      setUrl(null);
      setFileName(null);
      setReady(true);
      onMediaChange?.(null);
      setStatus('No file (video optional)');
      return;
    }
    const name = filePath.split(/[\\/]/).at(-1) ?? 'Video';
    setFileName(name);
    setStatus('Checking saved video source…');
    try {
      const authorized = await window.lonelyChat!.openRecordedMedia!(filePath);
      if (selectedPath.current !== filePath) return;
      setUrl(authorized);
      onMediaChange?.({ url: authorized, name, path: filePath });
    } catch (reason) {
      if (selectedPath.current !== filePath) return;
      setUrl(null);
      setError(
        `Source unavailable: ${reason instanceof Error ? reason.message : String(reason)}. Relink or remove it.`,
      );
      setStatus('Missing or unreadable file');
    }
  };

  useEffect(() => {
    if (restore) void selectPath(restore.path);
  }, [restore?.key]);

  const decoderError = () => {
    const mediaError = video.current?.error;
    const reason =
      mediaError?.message ||
      (mediaError?.code === 4 /* MEDIA_ERR_SRC_NOT_SUPPORTED */
        ? 'Unsupported video container or codec in the installed Chromium runtime.'
        : 'Unable to decode the selected video file.');
    setError(reason);
    setReady(false);
    setStatus('Decoder failed');
    if (running)
      reportRecordedIssue({
        kind: 'video',
        sourceId: 'recorded:video',
        code: 'decoder',
        fatal: true,
      });
  };

  return (
    <div className="mt-5 border-t border-border pt-4">
      <h3 className="font-medium">Recorded video</h3>
      <p className="mt-2 text-sm text-zinc-400">
        Optional local file decoded by Chromium at normal speed, independent of model inference.
        Embedded audio is muted and ignored unless separately added as an audio input. Only sampled
        JPEG frames enter the video input. Use the synchronized media preview below to seek.
      </p>
      <Label htmlFor="recorded-video-file" className="mt-4 text-sm text-zinc-200">
        Video file
      </Label>
      <input
        id="recorded-video-file"
        type="file"
        accept="video/*,.mkv,.mov,.mp4,.webm"
        disabled={running}
        onChange={(event) => selectFile(event.currentTarget.files?.[0])}
        className="mt-2 block w-full text-sm text-zinc-300 file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-2 file:text-secondary-foreground"
      />
      <button
        type="button"
        disabled={running}
        className="mt-2 block text-xs text-sky-300 hover:underline"
        onClick={async () => {
          try {
            const chosen = await window.lonelyChat?.chooseRecordedMedia?.('video');
            if (chosen) await selectPath(chosen);
          } catch (reason) {
            setError(String(reason));
          }
        }}
      >
        Choose / relink video file…
      </button>
      {(url || selectedPath.current) && (
        <button
          type="button"
          disabled={running}
          className="mt-2 ml-3 text-xs text-zinc-400 hover:underline"
          onClick={() => void selectPath(null)}
        >
          Remove video source
        </button>
      )}
      {url && (
        <video
          ref={video}
          crossOrigin="anonymous"
          src={url}
          className="mt-3 max-h-60 w-full rounded-md bg-black object-contain"
          preload="auto"
          playsInline
          muted
          onCanPlay={() => {
            if (video.current?.videoWidth && video.current.videoHeight) {
              const seconds = video.current.duration;
              onMediaChange?.({
                url,
                ...(selectedFile.current ? { file: selectedFile.current } : {}),
                ...(selectedPath.current ? { path: selectedPath.current } : {}),
                name: fileName ?? 'Video',
                durationMs:
                  Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null,
              });
              setReady(true);
              setError(null);
              if (!running) setStatus('Ready');
            }
          }}
          onError={decoderError}
          onEnded={() => {
            if (timer.current !== null) clearInterval(timer.current);
            timer.current = null;
            setStatus('End of video — simulation continues without new frames');
          }}
        />
      )}
      <p role="status" className="mt-2 text-xs text-zinc-400">
        {fileName ? `${fileName} · ${status}` : status}
      </p>
      {error && (
        <p role="alert" className="mt-2 text-sm text-rose-300">
          {error}
        </p>
      )}
    </div>
  );
});
