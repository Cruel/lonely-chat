import { useEffect, useState } from 'react';
import { MonitorUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  DEFAULT_FLOATING_CHAT_SETTINGS,
  FLOATING_CHAT_BOUNDS,
  type FloatingChatSettings,
  type FloatingChatSnapshot,
} from '../../shared/floating-chat-contract';

export function FloatingChatControls() {
  const [state, setState] = useState<FloatingChatSnapshot | null>(null);
  const [width, setWidth] = useState(String(DEFAULT_FLOATING_CHAT_SETTINGS.width));
  const [height, setHeight] = useState(String(DEFAULT_FLOATING_CHAT_SETTINGS.height));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const api = window.lonelyChat;
    const unsubscribe = api?.onFloatingChatChange((next) => {
      if (active) setState(next);
    });
    void api
      ?.getFloatingChat()
      .then((next) => {
        if (active) setState(next);
      })
      .catch((reason: unknown) => {
        if (active) setError(String(reason));
      });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    if (!state) return;
    setWidth(String(state.settings.width));
    setHeight(String(state.settings.height));
  }, [state?.settings.width, state?.settings.height]);

  const run = async (action: () => Promise<FloatingChatSnapshot>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setState(await action());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const update = (patch: Partial<FloatingChatSettings>) => {
    if (!state || !window.lonelyChat) return;
    void run(() => window.lonelyChat!.configureFloatingChat({ ...state.settings, ...patch }));
  };

  const sizeValid =
    Number.isInteger(Number(width)) &&
    Number(width) >= FLOATING_CHAT_BOUNDS.minWidth &&
    Number(width) <= FLOATING_CHAT_BOUNDS.maxWidth &&
    Number.isInteger(Number(height)) &&
    Number(height) >= FLOATING_CHAT_BOUNDS.minHeight &&
    Number(height) <= FLOATING_CHAT_BOUNDS.maxHeight;

  return (
    <div aria-label="Floating chat window controls">
      <h3 className="flex items-center gap-2 font-medium">
        <MonitorUp size={18} className="text-zinc-400" aria-hidden="true" /> Floating chat window
      </h3>
      <p className="mt-2 text-sm text-zinc-400">
        Capture this separate window in applications that do not support browser sources. It shows
        the same live chat, without a second simulation.
      </p>
      <Button
        variant="secondary"
        className="mt-4"
        disabled={!state || busy}
        onClick={() => {
          if (!state || !window.lonelyChat) return;
          void run(() =>
            state.open
              ? window.lonelyChat!.closeFloatingChat()
              : window.lonelyChat!.openFloatingChat(),
          );
        }}
      >
        {state?.open ? 'Close floating window' : 'Open floating window'}
      </Button>
      <div className="mt-5 grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="floating-width">Width (px)</Label>
          <Input
            id="floating-width"
            type="number"
            min={FLOATING_CHAT_BOUNDS.minWidth}
            max={FLOATING_CHAT_BOUNDS.maxWidth}
            value={width}
            onChange={(event) => setWidth(event.target.value)}
            disabled={!state || busy}
            className="mt-2"
          />
        </div>
        <div>
          <Label htmlFor="floating-height">Height (px)</Label>
          <Input
            id="floating-height"
            type="number"
            min={FLOATING_CHAT_BOUNDS.minHeight}
            max={FLOATING_CHAT_BOUNDS.maxHeight}
            value={height}
            onChange={(event) => setHeight(event.target.value)}
            disabled={!state || busy}
            className="mt-2"
          />
        </div>
      </div>
      <Button
        variant="outline"
        className="mt-3"
        disabled={!state || busy || !sizeValid}
        onClick={() => update({ width: Number(width), height: Number(height) })}
      >
        Apply size
      </Button>
      <div className="mt-4 space-y-3 text-sm">
        {(
          [
            ['transparent', 'Transparent background'],
            ['decorated', 'Window decorations'],
            ['alwaysOnTop', 'Always on top'],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="flex cursor-pointer items-center gap-3">
            <input
              type="checkbox"
              className="size-4 accent-violet-500"
              checked={state?.settings[key] ?? false}
              disabled={!state || busy}
              onChange={(event) => update({ [key]: event.target.checked })}
            />
            {label}
          </label>
        ))}
      </div>
      {state?.warning && (
        <p role="status" className="mt-3 text-xs text-amber-300">
          {state.warning}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-xs text-rose-300">
          {error}
        </p>
      )}
    </div>
  );
}
