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
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ChatView } from '@/components/chat-view';
import { ModelManager } from '@/components/model-manager';
import { useChat } from '../use-chat';
import { useSession } from '../use-session';
import {
  BASELINE_OPTIONS,
  CYCLE_INTERVAL_OPTIONS,
  HISTORY_AGE_OPTIONS,
  HISTORY_COUNT_OPTIONS,
  type InferenceMode,
} from '../../shared/session-contract';

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
  const [inferenceMode, setInferenceMode] = useState<InferenceMode>('fake');
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

  const running = session.status.phase === 'running' || session.status.phase === 'starting';

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
              Simulate an audience from manual context, with or without a local model.
            </p>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-[#1b1b24] p-5">
            <div className="flex items-center gap-2 text-violet-300">
              <Sparkles size={18} />
              <h3 className="font-medium">Manual-context inference</h3>
            </div>
            <p className="mt-3 text-sm leading-6 text-zinc-300">
              Describe what is happening on your stream. Use deterministic fixture replies or
              generate actual chat from an active, installed GGUF model via local llama.cpp.
            </p>
            <Label htmlFor="inference-mode" className="mt-4 text-sm text-zinc-200">
              Inference provider
            </Label>
            <Select
              items={[
                { value: 'fake', label: 'Deterministic fixture (no model)' },
                { value: 'native', label: 'Local llama.cpp (active GGUF)' },
              ]}
              value={inferenceMode}
              onValueChange={(value) => {
                if (value === 'fake' || value === 'native') setInferenceMode(value);
              }}
            >
              <SelectTrigger id="inference-mode" disabled={running} className="mt-2 w-full text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="fake">Deterministic fixture (no model)</SelectItem>
                <SelectItem value="native">Local llama.cpp (active GGUF)</SelectItem>
              </SelectContent>
            </Select>
            <Label htmlFor="simulation-context" className="mt-4 text-sm text-zinc-200">
              Stream context
            </Label>
            <Textarea
              id="simulation-context"
              className="mt-2 min-h-24 resize-y text-sm"
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
                  onClick={() => void session.start(manualContext, inferenceMode)}
                >
                  <Play size={15} /> Start simulation
                </Button>
              )}
              <span role="status" aria-live="polite" className="text-sm text-zinc-400">
                {running
                  ? session.status.phase === 'starting'
                    ? 'Loading local llama.cpp model…'
                    : `Running · cycle ${session.status.cycle} · ${session.status.pendingMessages} queued`
                  : session.status.phase === 'error'
                    ? 'Simulation error'
                    : 'Stopped'}
              </span>
            </div>
            {session.status.warning && (
              <p role="status" className="mt-3 text-sm text-amber-300">
                {session.status.warning}
              </p>
            )}
            {(session.actionError || session.status.error) && (
              <p role="alert" className="mt-3 text-sm text-rose-300">
                {session.actionError || session.status.error}
              </p>
            )}
            {session.status.events.length > 0 && (
              <div className="mt-4 space-y-1" aria-label="Recent inferred events">
                <p className="text-xs font-medium text-zinc-300">Recent inferred events</p>
                {session.status.events.slice(-3).map((event, index) => (
                  <p key={`${event.observedAt}-${index}`} className="text-xs text-zinc-400">
                    {event.kind}: {event.summary}
                  </p>
                ))}
              </div>
            )}
            <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-zinc-800 pt-4">
              <Label htmlFor="simulation-pace" className="text-sm text-zinc-300">
                Inference cycle
              </Label>
              <Select
                items={CYCLE_INTERVAL_OPTIONS.map((interval) => ({
                  value: String(interval),
                  label: `${(interval / 1000).toFixed(1)} seconds`,
                }))}
                value={String(session.preferences.cycleIntervalMs)}
                onValueChange={(interval) => {
                  if (interval)
                    void session.updatePreferences({
                      ...session.preferences,
                      cycleIntervalMs: Number(interval),
                    });
                }}
              >
                <SelectTrigger
                  id="simulation-pace"
                  disabled={!session.ready || session.busy}
                  className="h-9 min-w-32 text-sm"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CYCLE_INTERVAL_OPTIONS.map((interval) => (
                    <SelectItem key={interval} value={String(interval)}>
                      {(interval / 1000).toFixed(1)} seconds
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-xs text-zinc-500">
                Saved on this computer; manual context is not saved.
              </span>
            </div>
            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <Label htmlFor="baseline-duration" className="text-xs">
                  Initial baseline
                </Label>
                <Select
                  items={BASELINE_OPTIONS.map((value) => ({
                    value: String(value),
                    label: `${(value / 1000).toFixed(1)} s`,
                  }))}
                  value={String(session.preferences.baselineMs)}
                  onValueChange={(value) => {
                    if (value)
                      void session.updatePreferences({
                        ...session.preferences,
                        baselineMs: Number(value),
                      });
                  }}
                >
                  <SelectTrigger
                    id="baseline-duration"
                    disabled={!session.ready || session.busy}
                    className="mt-1 w-full text-sm"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {BASELINE_OPTIONS.map((value) => (
                      <SelectItem key={value} value={String(value)}>
                        {(value / 1000).toFixed(1)} s
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="history-max-count" className="text-xs">
                  History entry limit
                </Label>
                <Select
                  items={HISTORY_COUNT_OPTIONS.map((value) => ({
                    value: String(value),
                    label: String(value),
                  }))}
                  value={String(session.preferences.historyMaxCount)}
                  onValueChange={(value) => {
                    if (value)
                      void session.updatePreferences({
                        ...session.preferences,
                        historyMaxCount: Number(value),
                      });
                  }}
                >
                  <SelectTrigger
                    id="history-max-count"
                    disabled={!session.ready || session.busy}
                    className="mt-1 w-full text-sm"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {HISTORY_COUNT_OPTIONS.map((value) => (
                      <SelectItem key={value} value={String(value)}>
                        {value}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="history-max-age" className="text-xs">
                  History time horizon
                </Label>
                <Select
                  items={HISTORY_AGE_OPTIONS.map((value) => ({
                    value: String(value),
                    label: `${value / 1000} s`,
                  }))}
                  value={String(session.preferences.historyMaxAgeMs)}
                  onValueChange={(value) => {
                    if (value)
                      void session.updatePreferences({
                        ...session.preferences,
                        historyMaxAgeMs: Number(value),
                      });
                  }}
                >
                  <SelectTrigger
                    id="history-max-age"
                    disabled={!session.ready || session.busy}
                    className="mt-1 w-full text-sm"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {HISTORY_AGE_OPTIONS.map((value) => (
                      <SelectItem key={value} value={String(value)}>
                        {value / 1000} s
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <p className="mt-4 text-xs text-zinc-500" aria-label="Inference diagnostics">
              Latest inference{' '}
              {session.status.latestInferenceMs === null
                ? '—'
                : `${Math.round(session.status.latestInferenceMs)} ms`}
              {' · '}Smoothed{' '}
              {session.status.smoothedInferenceMs === null
                ? '—'
                : `${session.status.smoothedInferenceMs} ms`}
              {' · '}Playback window {session.status.playbackWindowMs} ms
              {' · '}Dropped observations {session.status.droppedObservations}
            </p>
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
