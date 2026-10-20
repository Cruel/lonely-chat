import { useEffect, useState } from 'react';
import { Button } from './ui/button';
import {
  DEFAULT_NATIVE_VIDEO_PREFERENCES,
  validateNativeVideoPreferences,
  type NativeVideoPreferences,
  type VideoToolsStatus,
} from '../../shared/video-tools-contract';
import { NativeVideoControls } from './native-video-controls';

/** Optional local FFmpeg pair; absence never affects frame-based inference. */
export function VideoInferenceSettings() {
  const [status, setStatus] = useState<VideoToolsStatus | null>(null);
  const [working, setWorking] = useState(false);
  const [draft, setDraft] = useState<NativeVideoPreferences>(DEFAULT_NATIVE_VIDEO_PREFERENCES);
  const setCurrent = (value: VideoToolsStatus) => {
    setStatus(value);
    setDraft(value.preferences);
  };
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void window.lonelyChat
      ?.getVideoTools()
      .then((value) => {
        if (live) setCurrent(value);
      })
      .catch((reason: unknown) => {
        if (live) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      live = false;
    };
  }, []);

  async function run(task: () => Promise<VideoToolsStatus>) {
    setWorking(true);
    setError(null);
    try {
      setCurrent(await task());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setWorking(false);
    }
  }

  return (
    <div aria-label="Native video dependencies" className="space-y-3">
      <h3 className="font-medium">Native video decoding (optional FFmpeg)</h3>
      <p className="text-sm text-zinc-400">
        Native video uses host-installed ffmpeg and ffprobe. Multi-image frame inference continues
        to work without them. Only short recorded clips are supported in Playground.
      </p>
      <p role="status" className="text-sm">
        {status?.available
          ? `Detected: ${status.version} — ${status.directory}`
          : (status?.error ?? 'Checking FFmpeg and FFprobe…')}
      </p>
      {status?.configuredDirectory && (
        <p className="text-xs text-zinc-400">Configured directory: {status.configuredDirectory}</p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          disabled={working}
          onClick={() => void run(() => window.lonelyChat!.getVideoTools())}
        >
          Refresh detection
        </Button>
        <Button
          variant="secondary"
          disabled={working}
          onClick={() => void run(() => window.lonelyChat!.chooseVideoToolsDirectory())}
        >
          Choose directory…
        </Button>
        <Button
          variant="secondary"
          disabled={working || !status?.configuredDirectory}
          onClick={() => void run(() => window.lonelyChat!.resetVideoToolsDirectory())}
        >
          Use system PATH
        </Button>
      </div>
      <div className="mt-4 space-y-3">
        <h4 className="text-sm font-medium">Default native-video settings</h4>
        <p className="text-xs text-zinc-400">
          FPS and timestamp interval restart the warm worker when changed. Size and duration limits
          are checked when selecting and submitting clips.
        </p>
        <NativeVideoControls
          prefix="settings-native-video"
          value={draft}
          onChange={setDraft}
          disabled={working}
        />
        <Button
          variant="secondary"
          disabled={
            working || !status || JSON.stringify(draft) === JSON.stringify(status.preferences)
          }
          onClick={() =>
            void run(() =>
              window.lonelyChat!.configureNativeVideoPreferences(
                validateNativeVideoPreferences(draft),
              ),
            )
          }
        >
          Save native-video defaults
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-rose-300">
          {error}
        </p>
      )}
    </div>
  );
}
