import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Label } from '@/components/ui/label';
import { RecordedVideoTimeline } from '../recorded-video-timeline';

export interface RecordedVideoHandle {
  begin(captureIntervalMs: number): Promise<void>;
  stop(): void;
}

export const RecordedVideoInput = forwardRef<
  RecordedVideoHandle,
  {
    running: boolean;
    onSelectionChange: (state: { hasFile: boolean; ready: boolean }) => void;
  }
>(function RecordedVideoInput({ running, onSelectionChange }, ref) {
  const video = useRef<HTMLVideoElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState('No file (video optional)');
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const epoch = useRef(0);
  const inFlight = useRef(false);

  const stop = () => {
    ++epoch.current;
    if (timer.current !== null) clearInterval(timer.current);
    timer.current = null;
    video.current?.pause();
  };

  useImperativeHandle(
    ref,
    () => ({
      stop,
      async begin(captureIntervalMs: number) {
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
        element.currentTime = 0;
        element.playbackRate = 1;
        element.muted = true; // Embedded audio must not leak into live monitoring or STT.
        const originObservationMs = await api.getVideoClock();
        const originMonotonicMs = performance.now();
        if (generation !== epoch.current) return;
        const timeline = new RecordedVideoTimeline(
          originObservationMs,
          originMonotonicMs,
          captureIntervalMs,
        );
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        if (!context) throw new Error('JPEG decoding/capture is unavailable.');
        const capture = () => {
          if (generation !== epoch.current || inFlight.current || element.readyState < 2) return;
          if (element.paused && element.currentTime > 0) return;
          const timestamp = timeline.sample(element.currentTime, performance.now());
          if (!timestamp) return;
          const scale = Math.min(1, 320 / element.videoWidth, 180 / element.videoHeight);
          if (!Number.isFinite(scale) || scale <= 0) return;
          canvas.width = Math.max(1, Math.round(element.videoWidth * scale));
          canvas.height = Math.max(1, Math.round(element.videoHeight * scale));
          context.drawImage(element, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.65);
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
                void api.reportRecordedVideoError(message).catch(() => {});
              }
            })
            .finally(() => {
              inFlight.current = false;
            });
        };
        try {
          await element.play();
          if (generation !== epoch.current) {
            element.pause();
            return;
          }
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
    [ready, url],
  );

  useEffect(() => {
    onSelectionChange({ hasFile: url !== null, ready: !url || ready });
  }, [url, ready, onSelectionChange]);

  useEffect(() => {
    if (!running) stop();
    return () => {}; // Running while another navigation category is open keeps the producer mounted.
  }, [running]);

  useEffect(
    () => () => {
      stop();
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );

  const selectFile = (file: File | undefined) => {
    stop();
    setReady(false);
    setError(null);
    if (!file) {
      setUrl(null);
      setFileName(null);
      setReady(true);
      setStatus('No file (video optional)');
      return;
    }
    setFileName(file.name);
    setUrl(URL.createObjectURL(file));
    setStatus('Checking Chromium video decoder…');
  };

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
    if (running) void window.lonelyChat?.reportRecordedVideoError(reason).catch(() => {});
  };

  return (
    <div className="mt-5 border-t border-border pt-4">
      <h3 className="font-medium">Recorded video</h3>
      <p className="mt-2 text-sm text-zinc-400">
        Optional local file decoded by Chromium at normal speed, independent of model inference.
        Embedded audio is muted and discarded. Only sampled JPEG frames enter the session.
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
      {url && (
        <video
          ref={video}
          src={url}
          className="mt-3 max-h-60 w-full rounded-md bg-black object-contain"
          preload="auto"
          playsInline
          muted
          controls={!running}
          onCanPlay={() => {
            if (video.current?.videoWidth && video.current.videoHeight) {
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
