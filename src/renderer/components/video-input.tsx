import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { VideoSource } from '../../shared/video-contract';

type CaptureStatus = 'off' | 'starting' | 'live' | 'disconnected' | 'error';

function describeError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return 'Video permission denied. Allow camera or screen capture in your system/browser settings, then try again.';
    }
    if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') {
      return 'Selected video source is missing. Capture will retry when it becomes available.';
    }
    if (error.name === 'NotReadableError' || error.name === 'AbortError') {
      return 'Video source is unavailable or in use. Capture will retry.';
    }
  }
  return error instanceof Error ? error.message : 'Unable to start video capture.';
}

function reconnectable(error: unknown): boolean {
  return (
    (error instanceof DOMException &&
      ['NotFoundError', 'NotReadableError', 'OverconstrainedError', 'AbortError'].includes(
        error.name,
      )) ||
    (error instanceof Error && error.message.includes('no longer available'))
  );
}

/** A single Chromium media stream. Stays mounted when navigating away from Inputs. */
export function VideoInput({ visible = true }: { visible?: boolean }) {
  const [sources, setSources] = useState<VideoSource[]>([]);
  const [selected, setSelected] = useState('none');
  const [lastSelected, setLastSelected] = useState<VideoSource | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState<CaptureStatus>('off');
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [displayReady, setDisplayReady] = useState(false);
  const pendingDisplay = useRef<Promise<MediaStream> | null>(null);
  const selectionEpoch = useRef(0);
  const video = useRef<HTMLVideoElement>(null);

  const refresh = useCallback(async () => {
    const api = window.lonelyChat;
    if (!api) return;
    const [display, cameras] = await Promise.allSettled([
      api.listDisplaySources(),
      navigator.mediaDevices?.enumerateDevices() ?? Promise.resolve([]),
    ]);
    const next: VideoSource[] = [
      ...(cameras.status === 'fulfilled'
        ? cameras.value
            .filter((device) => device.kind === 'videoinput' && device.deviceId)
            .map((device, index) => ({
              id: `camera:${device.deviceId}`,
              label: device.label || `Camera ${index + 1} (permission required for name)`,
              kind: 'camera' as const,
            }))
        : []),
      ...(display.status === 'fulfilled' ? display.value : []),
    ];
    setSources(next);
    const problems = [
      cameras.status === 'rejected' ? `Camera enumeration: ${describeError(cameras.reason)}` : '',
      display.status === 'rejected'
        ? `Screen/window enumeration: ${describeError(display.reason)}`
        : '',
    ].filter(Boolean);
    setRefreshError(problems.join(' ') || null);
  }, []);

  useEffect(() => {
    if (!visible && !enabled) return;
    void refresh();
    navigator.mediaDevices?.addEventListener?.('devicechange', refresh);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', refresh);
  }, [refresh, visible, enabled]);

  useEffect(() => {
    let valid = true;
    let stream: MediaStream | null = null;
    let sampleTimer: ReturnType<typeof setInterval> | null = null;
    let inFlight = false;
    const stopStream = () => {
      if (sampleTimer !== null) clearInterval(sampleTimer);
      sampleTimer = null;
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
      if (video.current) video.current.srcObject = null;
    };

    if (!enabled || selected === 'none' || !window.lonelyChat) {
      setStatus('off');
      setError(null);
    } else {
      const start = async () => {
        setStatus('starting');
        setError(null);
        try {
          await window.lonelyChat!.selectVideoSource(selected);
          if (!valid) return;
          const media = navigator.mediaDevices;
          if (!media) throw new Error('Chromium media capture is unavailable.');
          // getDisplayMedia must be invoked synchronously in the click handler: Chromium
          // requires transient user activation even when Electron selects the source.
          const nextStream = selected.startsWith('camera:')
            ? await media.getUserMedia({
                audio: false,
                video: { deviceId: { exact: selected.slice('camera:'.length) } },
              })
            : await (pendingDisplay.current ??
                Promise.reject(new Error('Click Reconnect video to authorize screen capture.')));
          if (!selected.startsWith('camera:')) pendingDisplay.current = null;
          if (!valid) {
            nextStream.getTracks().forEach((track) => track.stop());
            return;
          }
          stream = nextStream;
          const track = nextStream.getVideoTracks()[0];
          if (!track) throw new Error('Selected input did not provide a video track.');
          track.addEventListener('ended', () => {
            if (!valid) return;
            stopStream();
            void window.lonelyChat?.selectVideoSource(null).catch(() => {});
            setStatus('disconnected');
            setError(
              selected.startsWith('camera:')
                ? 'Video input disconnected. Waiting for the source to become available again.'
                : 'Screen/window capture ended. Click Reconnect video to authorize capture again.',
            );
          });
          if (video.current) {
            video.current.srcObject = nextStream;
            void video.current.play().catch(() => {});
          }
          const canvas = document.createElement('canvas');
          const context = canvas.getContext('2d');
          if (!context) throw new Error('JPEG frame capture is unavailable.');
          const sample = () => {
            if (!valid || inFlight || !video.current || video.current.readyState < 2) return;
            const width = video.current.videoWidth;
            const height = video.current.videoHeight;
            if (!width || !height) return;
            const scale = Math.min(1, 320 / width, 180 / height);
            canvas.width = Math.max(1, Math.round(width * scale));
            canvas.height = Math.max(1, Math.round(height * scale));
            context.drawImage(video.current, 0, 0, canvas.width, canvas.height);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.65);
            inFlight = true;
            void window
              .lonelyChat!.submitVideoFrame({
                sourceId: selected,
                observedAt: Date.now(),
                width: canvas.width,
                height: canvas.height,
                dataUrl,
              })
              .catch((reason: unknown) => {
                if (valid) setError(describeError(reason));
              })
              .finally(() => {
                inFlight = false;
              });
          };
          sampleTimer = setInterval(sample, 500);
          setStatus('live');
          void refresh();
        } catch (reason) {
          if (!valid) return;
          stopStream();
          void window.lonelyChat?.selectVideoSource(null).catch(() => {});
          setStatus(reconnectable(reason) ? 'disconnected' : 'error');
          setError(
            selected.startsWith('display:') && reconnectable(reason)
              ? `${describeError(reason)} Click Reconnect video to authorize capture again.`
              : describeError(reason),
          );
        }
      };
      void start();
    }

    return () => {
      valid = false;
      stopStream();
    };
  }, [enabled, selected, retry, refresh]);

  useEffect(() => {
    if (status !== 'disconnected' || !enabled || !selected.startsWith('camera:')) return;
    const timer = setInterval(() => {
      void refresh();
      setRetry((value) => value + 1);
    }, 4000);
    return () => clearInterval(timer);
  }, [status, enabled, refresh, selected]);

  // Keep the former selection legible when a device disappears from enumeration.
  const availableSources =
    selected !== 'none' && !sources.some((source) => source.id === selected) && lastSelected
      ? [lastSelected, ...sources]
      : sources;
  const selectedSource = availableSources.find((source) => source.id === selected);
  return (
    <div>
      <h3 className="font-medium">Video source</h3>
      <p className="mt-2 text-sm text-zinc-400">
        Choose a webcam, virtual camera, screen, or window. Video is kept in memory and never sent
        to the browser overlay. Capture can run independently of simulation and audio.
      </p>
      <Label htmlFor="video-source" className="mt-4 text-sm text-zinc-200">
        Input device
      </Label>
      <Select
        items={[
          { value: 'none', label: 'No video' },
          ...availableSources.map((source) => ({
            value: source.id,
            label: `${source.label} (${source.kind})`,
          })),
        ]}
        value={selected}
        onValueChange={(value) => {
          if (typeof value !== 'string') return;
          setEnabled(false);
          pendingDisplay.current = null;
          setLastSelected(sources.find((source) => source.id === value) ?? null);
          setSelected(value);
          setDisplayReady(false);
          const selection = ++selectionEpoch.current;
          // Arm Electron's chosen desktop source ahead of Start. The subsequent
          // getDisplayMedia call must happen directly inside the user's click.
          if (value.startsWith('display:')) {
            void window.lonelyChat?.selectVideoSource(value).then(
              () => {
                if (selection === selectionEpoch.current) setDisplayReady(true);
              },
              (reason: unknown) => {
                if (selection === selectionEpoch.current) setError(describeError(reason));
              },
            );
          } else {
            void window.lonelyChat?.selectVideoSource(null).catch(() => {});
          }
        }}
      >
        <SelectTrigger id="video-source" className="mt-2 w-full text-sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">No video</SelectItem>
          {availableSources.map((source) => (
            <SelectItem key={source.id} value={source.id}>
              {source.label} ({source.kind})
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            void refresh();
            if (selected.startsWith('display:') && !enabled) {
              setDisplayReady(false);
              const selection = ++selectionEpoch.current;
              void window.lonelyChat?.selectVideoSource(selected).then(
                () => {
                  if (selection !== selectionEpoch.current) return;
                  setDisplayReady(true);
                  setError(null);
                },
                (reason: unknown) => {
                  if (selection === selectionEpoch.current) setError(describeError(reason));
                },
              );
            }
          }}
        >
          Refresh sources
        </Button>
        <Button
          size="sm"
          disabled={
            selected === 'none' || (selected.startsWith('display:') && !displayReady && !enabled)
          }
          onClick={() => {
            const reconnectDisplay =
              enabled && status === 'disconnected' && selected.startsWith('display:');
            if (enabled && !reconnectDisplay) {
              setEnabled(false);
              pendingDisplay.current = null;
              void window.lonelyChat?.selectVideoSource(null).catch(() => {});
            } else {
              if (selected.startsWith('display:')) {
                // This must be synchronous with a real click, not awaited IPC/effect work.
                const pending = navigator.mediaDevices.getDisplayMedia({
                  video: true,
                  audio: false,
                });
                pendingDisplay.current = pending;
                // Release a stream if the user stopped or switched while its chooser was open.
                void pending.then(
                  (stream) => {
                    if (pendingDisplay.current !== pending) {
                      stream.getTracks().forEach((track) => track.stop());
                    }
                  },
                  () => {},
                );
              }
              setRetry((value) => value + 1);
              setEnabled(true);
            }
          }}
        >
          {enabled
            ? status === 'disconnected' && selected.startsWith('display:')
              ? 'Reconnect video'
              : 'Stop video'
            : 'Start video'}
        </Button>
        <span role="status" aria-live="polite" className="text-xs text-zinc-400">
          Video: {status}
          {selectedSource ? ` · ${selectedSource.label}` : ''}
        </span>
      </div>
      {refreshError && <p className="mt-2 text-xs text-amber-300">{refreshError}</p>}
      {error && (
        <p role="alert" className="mt-2 text-sm text-amber-300">
          {error}
        </p>
      )}
      <video
        ref={video}
        aria-label="Video input preview"
        autoPlay
        playsInline
        muted
        className="mt-4 aspect-video w-full rounded-lg border border-border bg-black object-contain"
      />
      <p className="mt-2 text-xs text-zinc-500">
        Live sampling: up to 2 JPEG frames/sec at 320 × 180; inference selects up to 8 timestamped
        frames per observation interval. Stopping video does not stop the chat.
      </p>
    </div>
  );
}
