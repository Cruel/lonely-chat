import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  MAX_PLAYGROUND_FRAME_DATA_URL,
  MAX_PLAYGROUND_FRAMES,
  MAX_PLAYGROUND_SOURCE_VIDEO_BYTES,
  MAX_PLAYGROUND_VIDEO_DURATION_SECONDS,
  type PlaygroundFrame,
} from '../../shared/playground-media-contract';
import type { PlaygroundVideoMode } from '../../shared/playground-contract';
import {
  DEFAULT_NATIVE_VIDEO_PREFERENCES,
  type NativeVideoPreferences,
  type PlaygroundVideoSelection,
  type VideoToolsStatus,
} from '../../shared/video-tools-contract';
import { NativeVideoControls } from './native-video-controls';

const MAX_IMAGE_FILE_BYTES = 20 * 1024 * 1024;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

function jpegSnapshot(
  source: CanvasImageSource,
  width: number,
  height: number,
): Pick<PlaygroundFrame, 'width' | 'height' | 'dataUrl'> {
  const scale = Math.min(1, 640 / width, 360 / height);
  if (!Number.isFinite(scale) || scale <= 0) throw new Error('Media has invalid dimensions.');
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas decoding is unavailable in this desktop runtime.');
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
  if (!dataUrl.startsWith('data:image/jpeg;base64,'))
    throw new Error('This runtime could not encode a JPEG snapshot.');
  if (dataUrl.length > MAX_PLAYGROUND_FRAME_DATA_URL)
    throw new Error('Captured JPEG is too large. Try a less complex frame or smaller image.');
  return { width: canvas.width, height: canvas.height, dataUrl };
}

function formatTime(milliseconds: number) {
  return (milliseconds / 1000).toFixed(3) + ' s';
}

/**
 * Local source files and object URLs never cross IPC. Only chosen JPEG snapshots
 * are retained; selection order is the request order (including manual reordering).
 */
export function PlaygroundMediaPicker({
  frames,
  onChange,
  mode = 'frames',
  onModeChange,
  selectedVideo,
  onVideoChange,
  videoOptions,
  onVideoOptionsChange,
}: {
  readonly frames: readonly PlaygroundFrame[];
  readonly onChange: (frames: PlaygroundFrame[]) => void;
  readonly mode?: PlaygroundVideoMode;
  readonly onModeChange?: (mode: PlaygroundVideoMode) => void;
  readonly selectedVideo?: PlaygroundVideoSelection | null;
  readonly onVideoChange?: (video: PlaygroundVideoSelection | null) => void;
  readonly videoOptions?: NativeVideoPreferences | null;
  readonly onVideoOptionsChange?: (options: NativeVideoPreferences | null) => void;
}) {
  const [tools, setTools] = useState<VideoToolsStatus | null>(null);
  const [nativeBusy, setNativeBusy] = useState(false);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoName, setVideoName] = useState('');
  const [videoReady, setVideoReady] = useState(false);
  const [videoStatus, setVideoStatus] = useState('No video selected');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const generation = useRef(0);
  useEffect(() => {
    if (!onModeChange) return;
    let live = true;
    void window.lonelyChat
      ?.getVideoTools?.()
      ?.then((value) => {
        if (live) setTools(value);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [onModeChange]);

  const chooseNativeClip = async () => {
    setNativeBusy(true);
    setError(null);
    try {
      const clip = await window.lonelyChat?.choosePlaygroundVideo(
        videoOptions ?? tools?.preferences ?? DEFAULT_NATIVE_VIDEO_PREFERENCES,
      );
      if (clip) onVideoChange?.(clip);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setNativeBusy(false);
    }
  };
  const latestFrames = useRef(frames);
  latestFrames.current = frames;

  useEffect(
    () => () => {
      ++generation.current;
    },
    [],
  );
  useEffect(
    () => () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    },
    [videoUrl],
  );

  const addImageFiles = async (files: FileList | File[] | null) => {
    if (!files?.length) return;
    const token = ++generation.current;
    setBusy(true);
    setError(null);
    const chosen: PlaygroundFrame[] = [];
    try {
      if (files.length + frames.length > MAX_PLAYGROUND_FRAMES)
        throw new Error(`Choose at most ${MAX_PLAYGROUND_FRAMES} total frames.`);
      for (const file of Array.from(files)) {
        if (!IMAGE_TYPES.includes(file.type))
          throw new Error(`Unsupported image format for ${file.name}; use JPEG, PNG or WebP.`);
        if (file.size > MAX_IMAGE_FILE_BYTES)
          throw new Error(`${file.name} exceeds the 20 MiB image source limit.`);
        const url = URL.createObjectURL(file);
        try {
          const img = new Image();
          img.src = url;
          await img.decode();
          if (token !== generation.current) return;
          if (
            img.naturalWidth > 16384 ||
            img.naturalHeight > 16384 ||
            img.naturalWidth * img.naturalHeight > 40_000_000
          )
            throw new Error('Image dimensions exceed 16,384 pixels per side or 40 megapixels.');
          const result = jpegSnapshot(img, img.naturalWidth, img.naturalHeight);
          chosen.push({ ...result, sourceId: `image:${file.name.slice(0, 90)}` });
        } catch (reason) {
          if (
            reason instanceof Error &&
            (reason.message.includes('JPEG') ||
              reason.message.includes('dimensions') ||
              reason.message.includes('Canvas'))
          )
            throw reason;
          throw new Error(`Cannot decode ${file.name}. Use a supported JPEG, PNG or WebP image.`);
        } finally {
          URL.revokeObjectURL(url);
        }
      }
      if (token === generation.current) {
        if (latestFrames.current.length + chosen.length > MAX_PLAYGROUND_FRAMES)
          throw new Error(`Choose at most ${MAX_PLAYGROUND_FRAMES} total frames.`);
        onChange([...latestFrames.current, ...chosen]);
      }
    } catch (reason) {
      if (token === generation.current)
        setError(reason instanceof Error ? reason.message : 'Unable to import images.');
    } finally {
      if (token === generation.current) setBusy(false);
    }
  };

  const selectVideo = (file?: File) => {
    ++generation.current;
    setBusy(false);
    setVideoReady(false);
    setError(null);
    setVideoUrl(null);
    if (!file) {
      setVideoName('');
      setVideoStatus('No video selected');
      return;
    }
    if (file.size > MAX_PLAYGROUND_SOURCE_VIDEO_BYTES) {
      setVideoStatus('Video rejected');
      setError('Video source is larger than 512 MiB. Select a shorter or smaller file.');
      return;
    }
    setVideoName(file.name);
    setVideoStatus('Checking Chromium decoder…');
    setVideoUrl(URL.createObjectURL(file));
  };

  const videoError = () => {
    setVideoReady(false);
    setVideoStatus('Unsupported video');
    setError(
      'Chromium cannot decode this video container or codec. Convert it to MP4/H.264 or WebM and try again.',
    );
  };

  const capture = () => {
    const element = video.current;
    if (
      !videoReady ||
      !element ||
      element.seeking ||
      element.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
    ) {
      setError(
        'Video frame is still decoding. Seek to a time and wait until the frame is visible.',
      );
      return;
    }
    if (frames.length >= MAX_PLAYGROUND_FRAMES) {
      setError(`At most ${MAX_PLAYGROUND_FRAMES} frames may be submitted.`);
      return;
    }
    try {
      if (
        !Number.isFinite(element.currentTime) ||
        element.currentTime < 0 ||
        element.currentTime > MAX_PLAYGROUND_VIDEO_DURATION_SECONDS
      )
        throw new Error('Video playback position is invalid. Seek to a valid decoded frame.');
      const result = jpegSnapshot(element, element.videoWidth, element.videoHeight);
      const timestamp = Math.round(element.currentTime * 1000);
      onChange([
        ...frames,
        { ...result, sourceId: `video:${videoName.slice(0, 90)}`, mediaTimeMs: timestamp },
      ]);
      setError(null);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'Could not capture the selected video frame.',
      );
    }
  };

  const move = (index: number, delta: number) => {
    const next = [...frames];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item);
    onChange(next);
  };

  return (
    <section aria-label="One-shot media" className="space-y-3 rounded-md border border-border p-3">
      {onModeChange && (
        <div className="space-y-2">
          <Label htmlFor="playground-video-mode">Video inference mode</Label>
          <select
            id="playground-video-mode"
            aria-label="Video inference mode"
            className="block w-full rounded-md border border-border bg-background p-2 text-sm"
            value={mode}
            onChange={(event) => onModeChange(event.target.value as PlaygroundVideoMode)}
          >
            <option value="frames">Multi-image frames</option>
            <option value="native-video">Native video (FFmpeg)</option>
          </select>
        </div>
      )}
      {mode === 'native-video' ? (
        <div className="space-y-3">
          <h4 className="text-sm font-medium">Native video clip</h4>
          <p className="text-xs text-zinc-400">
            Submit a recorded clip directly to llama.cpp within the configured size and duration
            limits. FFmpeg and FFprobe must be installed; audio is not analyzed in this mode.
          </p>
          <p className="text-xs text-zinc-400">
            {tools?.available
              ? `FFmpeg detected: ${tools.directory}`
              : (tools?.error ?? 'Checking FFmpeg… Configure it in Settings if necessary.')}
          </p>
          {onVideoOptionsChange && (
            <div className="space-y-3">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  aria-label="Override native video defaults"
                  checked={videoOptions !== null && videoOptions !== undefined}
                  onChange={(event) =>
                    onVideoOptionsChange(
                      event.target.checked
                        ? { ...(tools?.preferences ?? DEFAULT_NATIVE_VIDEO_PREFERENCES) }
                        : null,
                    )
                  }
                />
                Override native-video defaults for this Playground
              </label>
              {videoOptions && (
                <NativeVideoControls
                  prefix="playground-native-video"
                  value={videoOptions}
                  onChange={onVideoOptionsChange}
                  disabled={nativeBusy}
                />
              )}
              <p className="text-xs text-zinc-400">
                Effective:{' '}
                {(videoOptions ?? tools?.preferences ?? DEFAULT_NATIVE_VIDEO_PREFERENCES).fps} FPS,{' '}
                timestamp interval{' '}
                {
                  (videoOptions ?? tools?.preferences ?? DEFAULT_NATIVE_VIDEO_PREFERENCES)
                    .timestampIntervalMs
                }{' '}
                ms, max{' '}
                {
                  (videoOptions ?? tools?.preferences ?? DEFAULT_NATIVE_VIDEO_PREFERENCES)
                    .maxClipSizeMiB
                }{' '}
                MiB, max{' '}
                {
                  (videoOptions ?? tools?.preferences ?? DEFAULT_NATIVE_VIDEO_PREFERENCES)
                    .maxClipDurationSeconds
                }{' '}
                s
              </p>
            </div>
          )}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void chooseNativeClip()}
            disabled={nativeBusy || tools?.available === false}
          >
            {nativeBusy ? 'Checking clip…' : 'Choose native video clip…'}
          </Button>
          {selectedVideo && (
            <p className="text-xs text-zinc-300">
              {selectedVideo.name} · {selectedVideo.durationSeconds.toFixed(2)} s ·{' '}
              {(selectedVideo.sizeBytes / 1024 / 1024).toFixed(1)} MiB
            </p>
          )}
          {error && (
            <p role="alert" className="text-xs text-rose-300">
              {error}
            </p>
          )}
        </div>
      ) : (
        <>
          <h4 className="text-sm font-medium">Images and video frames</h4>
          <p className="text-xs text-zinc-400">
            Select up to {MAX_PLAYGROUND_FRAMES} JPEG snapshots. Images are decoded locally. For
            video, seek to a position, wait for the visible frame, then select it. Reorder snapshots
            to set their exact inference order. Source files remain local; only chosen JPEGs are
            submitted.
          </p>
          <div>
            <Label htmlFor="playground-images">Import images</Label>
            <input
              id="playground-images"
              aria-label="Import images"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              className="mt-1 block w-full text-xs"
              onChange={(event) => {
                void addImageFiles(event.currentTarget.files);
                event.currentTarget.value = '';
              }}
            />
          </div>
          <div>
            <Label htmlFor="playground-video-file">Video file</Label>
            <input
              id="playground-video-file"
              aria-label="Video file"
              type="file"
              accept="video/*,.mp4,.webm,.mov,.mkv"
              className="mt-1 block w-full text-xs"
              onChange={(event) => selectVideo(event.currentTarget.files?.[0])}
            />
            {videoUrl && (
              <video
                ref={video}
                src={videoUrl}
                controls
                muted
                preload="auto"
                playsInline
                className="mt-2 max-h-64 w-full rounded bg-black object-contain"
                onLoadedData={() => {
                  const current = video.current;
                  if (!current) return;
                  if (
                    !Number.isFinite(current.duration) ||
                    current.duration <= 0 ||
                    current.duration > MAX_PLAYGROUND_VIDEO_DURATION_SECONDS ||
                    !current.videoWidth ||
                    !current.videoHeight
                  ) {
                    setVideoReady(false);
                    setVideoStatus('Invalid duration or dimensions');
                    setError(
                      'Video must have valid dimensions and a finite duration of at most 2 hours.',
                    );
                    return;
                  }
                  setVideoReady(true);
                  setVideoStatus('Ready — seek to select frames');
                }}
                onError={videoError}
              />
            )}
            <p role="status" className="mt-1 text-xs text-zinc-400">
              {videoName ? `${videoName} · ${videoStatus}` : videoStatus}
            </p>
            {videoUrl && (
              <Button
                size="sm"
                variant="secondary"
                onClick={capture}
                disabled={!videoReady || busy || frames.length >= MAX_PLAYGROUND_FRAMES}
              >
                Add current video frame
              </Button>
            )}
          </div>
          {busy && (
            <p role="status" className="text-xs text-zinc-400">
              Decoding selected images…
            </p>
          )}
          {error && (
            <p role="alert" className="text-xs text-rose-300">
              {error}
            </p>
          )}
          {frames.length > 0 && (
            <div aria-label="Selected frames" className="grid gap-2 sm:grid-cols-2">
              {frames.map((frame, index) => (
                <div key={index} className="min-w-0 rounded-md border border-border p-2">
                  <img
                    src={frame.dataUrl}
                    alt={`Selected frame ${index + 1}`}
                    className="h-28 w-full bg-black object-contain"
                  />
                  <p className="mt-1 truncate text-xs" title={frame.sourceId}>
                    {index + 1}. {frame.sourceId}
                  </p>
                  <p className="text-xs text-zinc-400">
                    {frame.width} × {frame.height}
                    {frame.mediaTimeMs === undefined ? '' : ` · ${formatTime(frame.mediaTimeMs)}`}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    <Button
                      size="xs"
                      variant="secondary"
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                      aria-label={`Move frame ${index + 1} up`}
                    >
                      Up
                    </Button>
                    <Button
                      size="xs"
                      variant="secondary"
                      disabled={index === frames.length - 1}
                      onClick={() => move(index, 1)}
                      aria-label={`Move frame ${index + 1} down`}
                    >
                      Down
                    </Button>
                    <Button
                      size="xs"
                      variant="destructive"
                      onClick={() => onChange(frames.filter((_, itemIndex) => index !== itemIndex))}
                      aria-label={`Remove frame ${index + 1}`}
                    >
                      Remove
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
