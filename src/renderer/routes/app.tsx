import { useEffect, useState } from 'react';
import { MessageSquareText, Monitor, Radio, Sparkles, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ChatView } from '@/components/chat-view';
import { useChat } from '../use-chat';

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
  const [overlayUrl, setOverlayUrl] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void window.lonelyChat?.getOverlayUrl().then(setOverlayUrl);
  }, []);

  const publish = async () => {
    if (!window.lonelyChat || busy) return;
    setBusy(true);
    try {
      await window.lonelyChat.publishSample();
    } finally {
      setBusy(false);
    }
  };

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
            <h2 className="text-2xl font-semibold tracking-tight">Overview</h2>
            <p className="mt-1 text-sm text-zinc-400">Your audience, entirely on your machine.</p>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-[#1b1b24] p-5">
            <div className="flex items-center gap-2 text-violet-300">
              <Sparkles size={18} />
              <h3 className="font-medium">Ready for setup</h3>
            </div>
            <p className="mt-3 text-sm leading-6 text-zinc-300">
              No model is configured yet. The desktop preview and browser-source overlay are
              available now. Capture, models, and simulation controls will be added in later
              milestones.
            </p>
          </div>
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
              <Monitor size={18} className="text-zinc-400" /> Test messages
            </h3>
            <p className="mt-2 text-sm text-zinc-400">
              Publish a sample from the app service to every connected view.
            </p>
            <Button className="mt-4" disabled={!connected || busy} onClick={() => void publish()}>
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
            Application-owned chat · Local only
          </div>
        </section>
      </main>
    </div>
  );
}
