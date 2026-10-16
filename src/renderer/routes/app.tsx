import { useEffect, useState } from 'react';
import {
  MessageSquareText,
  Monitor,
  Radio,
  Sparkles,
  ExternalLink,
  Play,
  Square,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ChatView } from '@/components/chat-view';
import { ModelManager } from '@/components/model-manager';
import { useChat } from '../use-chat';
import { useSession } from '../use-session';
import { CYCLE_INTERVAL_OPTIONS } from '../../shared/session-contract';

export function OverlayPage() {
  const { snapshot } = useChat();
  return (
    <main className="h-dvh bg-transparent">
      <ChatView compact messages={snapshot.messages} />
    </main>
  );
}

export function DesktopPage() {
  const { snapshot, connected } = useChat();
  const session = useSession();
  const [overlayUrl, setOverlayUrl] = useState('');
  const [manualContext, setManualContext] = useState('');
  const [sampleBusy, setSampleBusy] = useState(false);
  useEffect(() => {
    void window.lonelyChat?.getOverlayUrl().then(setOverlayUrl);
  }, []);

  const publish = async () => {
    if (!window.lonelyChat || sampleBusy) return;
    setSampleBusy(true);
    try {
      await window.lonelyChat.publishSample();
    } finally {
      setSampleBusy(false);
    }
  };

  const running = session.status.phase === 'running';

  return (
    <div className="min-h-dvh bg-[#101015] text-zinc-100">
      <header className="flex items-center justify-between border-b border-zinc-800 bg-[#181820] px-7 py-4">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-violet-500/20 p-2 text-violet-300">
            <MessageSquareText size={23} />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Lonely Chat</h1>
            <p className="text-xs text-zinc-400">Local simulated audience</p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs text-zinc-400">
          <span
            className={
              connected
                ? 'h-2 w-2 rounded-full bg-emerald-400'
                : 'h-2 w-2 rounded-full bg-amber-400'
            }
          />
          {connected ? 'Chat connected' : 'Connecting'}
        </div>
      </header>
      <main className="mx-auto grid max-w-6xl gap-6 p-7 lg:grid-cols-[minmax(0,1fr)_380px]">
        <section className="space-y-5">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">Simulation</h2>
            <p className="mt-1 text-sm text-zinc-400">
              Try continuous chat without a model, camera or microphone.
            </p>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-[#1b1b24] p-5">
            <div className="flex items-center gap-2 text-violet-300">
              <Sparkles size={18} />
              <h3 className="font-medium">Manual-context test mode</h3>
            </div>
            <p className="mt-3 text-sm leading-6 text-zinc-300">
              Describe what is happening on your stream. Deterministic fake inference creates
              scheduled viewer comments. Real inference and media input arrive in later milestones.
            </p>
            <label
              htmlFor="simulation-context"
              className="mt-4 block text-sm font-medium text-zinc-200"
            >
              Stream context
            </label>
            <textarea
              id="simulation-context"
              className="mt-2 min-h-24 w-full resize-y rounded-lg border border-zinc-700 bg-[#111116] p-3 text-sm text-zinc-100 outline-none focus-visible:border-violet-400 focus-visible:ring-2 focus-visible:ring-violet-400/30 disabled:opacity-60"
              maxLength={2000}
              value={manualContext}
              disabled={running}
              onChange={(event) => setManualContext(event.target.value)}
              placeholder="For example: I'm exploring a haunted castle in a fantasy game…"
            />
            <div className="mt-4 flex flex-wrap items-center gap-3">
              {running ? (
                <Button
                  disabled={!session.ready || session.busy}
                  onClick={() => void session.stop()}
                >
                  <Square size={15} /> Stop simulation
                </Button>
              ) : (
                <Button
                  disabled={!session.ready || session.busy}
                  onClick={() => void session.start(manualContext)}
                >
                  <Play size={15} /> Start simulation
                </Button>
              )}
              <span role="status" aria-live="polite" className="text-sm text-zinc-400">
                {running
                  ? `Running · cycle ${session.status.cycle} · ${session.status.pendingMessages} queued`
                  : session.status.phase === 'error'
                    ? 'Simulation error'
                    : 'Stopped'}
              </span>
            </div>
            {(session.actionError || session.status.error) && (
              <p role="alert" className="mt-3 text-sm text-rose-300">
                {session.actionError || session.status.error}
              </p>
            )}
            <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-zinc-800 pt-4">
              <label htmlFor="simulation-pace" className="text-sm text-zinc-300">
                Inference cycle
              </label>
              <select
                id="simulation-pace"
                className="rounded-md border border-zinc-700 bg-[#111116] px-3 py-2 text-sm text-zinc-100 focus-visible:outline-2 focus-visible:outline-violet-400 disabled:opacity-50"
                disabled={!session.ready || session.busy}
                value={session.preferences.cycleIntervalMs}
                onChange={(event) =>
                  void session.updatePreferences({ cycleIntervalMs: Number(event.target.value) })
                }
              >
                {CYCLE_INTERVAL_OPTIONS.map((interval) => (
                  <option key={interval} value={interval}>
                    {(interval / 1000).toFixed(1)} seconds
                  </option>
                ))}
              </select>
              <span className="text-xs text-zinc-500">
                Saved on this computer; manual context is not saved.
              </span>
            </div>
          </div>
          <ModelManager />
          <div className="rounded-xl border border-zinc-800 bg-[#1b1b24] p-5">
            <h3 className="flex items-center gap-2 font-medium">
              <Radio size={18} className="text-zinc-400" /> Overlay source
            </h3>
            <p className="mt-2 text-sm text-zinc-400">
              Add this local URL as a browser source in OBS or another capture tool.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <code className="min-w-0 flex-1 overflow-hidden text-ellipsis rounded-md bg-[#111116] px-3 py-2 text-xs text-violet-200">
                {overlayUrl || 'Starting local server…'}
              </code>
              {overlayUrl && (
                <Button
                  variant="secondary"
                  aria-label="Open overlay"
                  onClick={() => window.open(overlayUrl, '_blank')}
                >
                  <ExternalLink size={16} /> Open
                </Button>
              )}
            </div>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-[#1b1b24] p-5">
            <h3 className="flex items-center gap-2 font-medium">
              <Monitor size={18} className="text-zinc-400" /> Individual test message
            </h3>
            <p className="mt-2 text-sm text-zinc-400">
              Publish a single sample independently of simulation playback.
            </p>
            <Button
              variant="secondary"
              className="mt-4"
              disabled={!connected || sampleBusy}
              onClick={() => void publish()}
            >
              Publish sample message
            </Button>
          </div>
        </section>
        <section className="flex h-[550px] min-h-0 flex-col overflow-hidden rounded-xl border border-zinc-800 bg-[#1b1b24]">
          <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-4">
            <h2 className="font-medium">Live chat preview</h2>
            <span className="text-xs text-zinc-500">{snapshot.messages.length} messages</span>
          </div>
          <div className="min-h-0 flex-1">
            <ChatView messages={snapshot.messages} />
          </div>
          <div className="border-t border-zinc-800 px-5 py-3 text-xs text-zinc-500">
            Application-owned scheduling · Local only
          </div>
        </section>
      </main>
    </div>
  );
}
