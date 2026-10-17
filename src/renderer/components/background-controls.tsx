import { useEffect, useState } from 'react';
import type { WindowStatus } from '../../shared/window-status-contract';

/** Main-window policy only; changing this never starts or stops simulation. */
export function BackgroundControls() {
  const [status, setStatus] = useState<WindowStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void window.lonelyChat
      ?.getWindowStatus()
      .then((next) => {
        if (active) setStatus(next);
      })
      .catch((reason: unknown) => {
        if (active) setError(String(reason));
      });
    return () => {
      active = false;
    };
  }, []);

  const change = async (enabled: boolean) => {
    if (!window.lonelyChat || busy) return;
    setBusy(true);
    setError(null);
    try {
      setStatus(await window.lonelyChat.setCloseToTray(enabled));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div aria-label="Background operation settings">
      <h3 className="font-medium">Background operation</h3>
      <p className="mt-2 text-sm text-zinc-400">
        Keep a running simulation and browser/floating overlays alive when you close the
        configuration window. Use the system tray to show the app, stop simulation or quit
        completely.
      </p>
      <label className="mt-4 flex items-center gap-3 text-sm">
        <input
          aria-label="Close to system tray during simulation"
          type="checkbox"
          className="size-4 accent-violet-500"
          checked={status?.closeToTray ?? false}
          disabled={!status || busy}
          onChange={(event) => void change(event.target.checked)}
        />
        Close to system tray during simulation
      </label>
      {status?.closeToTray && !status.trayAvailable && (
        <p role="status" className="mt-3 text-sm text-amber-300">
          This desktop does not provide a usable system tray. Closing the main window will quit
          instead.
        </p>
      )}
      <p className="mt-3 text-xs text-zinc-500">
        With this option off, closing the main window quits Lonely Chat and its managed workers. The
        option is saved across launches.
      </p>
      {error && (
        <p role="alert" className="mt-3 text-sm text-rose-300">
          {error}
        </p>
      )}
    </div>
  );
}
