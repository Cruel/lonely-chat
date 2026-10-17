import { useEffect, useState } from 'react';
import {
  Activity,
  ExternalLink,
  MessageSquareText,
  Monitor,
  Play,
  Radio,
  Sparkles,
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
import {
  DesktopSidebar,
  DESKTOP_SECTIONS,
  type DesktopSection,
} from '@/components/desktop-sidebar';
import { ModelManager } from '@/components/model-manager';
import { NumericSettingCombobox } from '@/components/numeric-setting-combobox';
import { VideoInput } from '@/components/video-input';
import { AudioInput } from '@/components/audio-input';
import type { AudioStatus } from '../../shared/audio-contract';
import { useChat } from '../use-chat';
import { useSession } from '../use-session';
import {
  BASELINE_OPTIONS,
  CYCLE_INTERVAL_OPTIONS,
  HISTORY_AGE_OPTIONS,
  HISTORY_COUNT_OPTIONS,
  INFERENCE_TIMEOUT_OPTIONS,
  VIDEO_CAPTURE_INTERVAL_OPTIONS,
  VIDEO_COVERAGE_OPTIONS,
  VIDEO_FRAME_COUNT_OPTIONS,
  type InferenceMode,
  type SessionPreferences,
} from '../../shared/session-contract';

export function OverlayPage() {
  const { snapshot } = useChat();
  return (
    <main className="h-dvh bg-transparent">
      <ChatView compact messages={snapshot.messages} />
    </main>
  );
}

function SectionHeading({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-5">
      <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
      <p className="mt-1 text-sm text-zinc-400">{description}</p>
    </div>
  );
}

function Panel({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-border bg-card p-5 ${className}`}>{children}</div>
  );
}

/** The desktop shell owns its controls across category changes, not the browser overlay. */
export function DesktopPage() {
  const { snapshot, connected } = useChat();
  const session = useSession();
  const [section, setSection] = useState<DesktopSection>('simulation');
  const [overlayUrl, setOverlayUrl] = useState('');
  const [manualContext, setManualContext] = useState('');
  const [inferenceMode, setInferenceMode] = useState<InferenceMode>('fake');
  const [sampleBusy, setSampleBusy] = useState(false);
  const [audioStatus, setAudioStatus] = useState<AudioStatus | null>(null);
  useEffect(() => {
    let live = true;
    const unsubscribe = window.lonelyChat?.onAudioChange((next) => {
      if (live) setAudioStatus(next);
    });
    void window.lonelyChat?.getAudioStatus().then((next) => {
      if (live) setAudioStatus(next);
    });
    return () => {
      live = false;
      unsubscribe?.();
    };
  }, []);

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
  const current = DESKTOP_SECTIONS.find((item) => item.id === section)!;
  const update = (changes: Partial<SessionPreferences>) =>
    void session.updatePreferences({ ...session.preferences, ...changes });

  return (
    <div className="min-h-dvh bg-background text-foreground sm:flex">
      <DesktopSidebar
        selected={section}
        onSelect={setSection}
        simulationPhase={session.status.phase}
      />
      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-10 flex min-h-14 items-center justify-between gap-3 border-b border-border bg-[#181820] px-5 py-3 sm:px-7">
          <div className="flex items-center gap-2">
            <MessageSquareText className="size-5 text-violet-300 sm:hidden" aria-hidden="true" />
            <h1 className="text-sm font-semibold">{current.title}</h1>
          </div>
          <div className="flex items-center gap-2 text-xs text-zinc-400">
            <span
              aria-hidden="true"
              className={
                connected
                  ? 'size-2 rounded-full bg-emerald-400'
                  : 'size-2 rounded-full bg-amber-400'
              }
            />
            {connected ? 'Chat connected' : 'Connecting'}
          </div>
        </header>
        <main id="desktop-content" className="mx-auto w-full max-w-5xl p-5 sm:p-7">
          {section === 'simulation' && (
            <section aria-label="Simulation">
              <SectionHeading
                title="Simulation"
                description="Simulate an audience from manual context, with or without a local model."
              />
              <Panel>
                <h3 className="flex items-center gap-2 font-medium text-violet-300">
                  <Sparkles size={18} aria-hidden="true" /> Manual-context inference
                </h3>
                <p className="mt-3 text-sm leading-6 text-zinc-300">
                  Describe what is happening on your stream. Use deterministic fixture replies or
                  generate chat using an active, installed GGUF model via local llama.cpp.
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
                  <SelectTrigger
                    id="inference-mode"
                    disabled={running}
                    className="mt-2 w-full text-sm"
                  >
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
                <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-border pt-4 text-xs text-zinc-500">
                  <Activity size={15} aria-hidden="true" />
                  <span>
                    Cycle {session.status.cycle} · {session.status.pendingMessages} queued messages
                  </span>
                  <span>·</span>
                  <span>
                    Inference{' '}
                    {session.status.latestInferenceMs === null
                      ? '—'
                      : `${Math.round(session.status.latestInferenceMs)} ms`}
                  </span>
                  <Button variant="link" size="sm" onClick={() => setSection('settings')}>
                    Configure timing
                  </Button>
                </div>
              </Panel>
            </section>
          )}

          {section === 'models' && (
            <section aria-label="Models">
              <SectionHeading
                title="Models"
                description="Discover, install, activate, and remove local inference models."
              />
              <ModelManager />
            </section>
          )}

          {section === 'chat' && (
            <section aria-label="Chat & Overlay">
              <SectionHeading
                title="Chat & Overlay"
                description="Preview scheduled chat and use it in a browser source or capture window."
              />
              <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(260px,0.8fr)]">
                <div className="flex h-[550px] min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card">
                  <div className="flex items-center justify-between border-b border-border px-5 py-4">
                    <h3 className="font-medium">Live chat preview</h3>
                    <span className="text-xs text-zinc-500">
                      {snapshot.messages.length} messages
                    </span>
                  </div>
                  <div className="min-h-0 flex-1">
                    <ChatView messages={snapshot.messages} />
                  </div>
                  <div className="border-t border-border px-5 py-3 text-xs text-zinc-500">
                    Application-owned scheduling · Local only
                  </div>
                </div>
                <div className="space-y-5">
                  <Panel>
                    <h3 className="flex items-center gap-2 font-medium">
                      <Radio size={18} className="text-zinc-400" aria-hidden="true" /> Overlay
                      source
                    </h3>
                    <p className="mt-2 text-sm text-zinc-400">
                      Add this local URL as a browser source in OBS or another capture tool.
                    </p>
                    <code className="mt-3 block overflow-hidden text-ellipsis rounded-md bg-[#111116] px-3 py-2 text-xs text-violet-200">
                      {overlayUrl || 'Starting local server…'}
                    </code>
                    {overlayUrl && (
                      <Button
                        variant="secondary"
                        className="mt-3"
                        aria-label="Open overlay"
                        onClick={() => window.open(overlayUrl, '_blank')}
                      >
                        <ExternalLink size={16} /> Open overlay
                      </Button>
                    )}
                  </Panel>
                  <Panel>
                    <h3 className="flex items-center gap-2 font-medium">
                      <Monitor size={18} className="text-zinc-400" aria-hidden="true" /> Individual
                      test message
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
                  </Panel>
                </div>
              </div>
            </section>
          )}

          {section === 'audience' && (
            <section aria-label="Audience">
              <SectionHeading
                title="Audience"
                description="Configure your simulated viewers and their activity."
              />
              <Panel>
                <h3 className="font-medium">Audience controls are coming next</h3>
                <p className="mt-2 text-sm text-zinc-400">
                  Persistent viewer identities, audience size, and activity controls will be added
                  with the chatter roster feature (#9).
                </p>
              </Panel>
            </section>
          )}

          <div hidden={section !== 'inputs'}>
            <section aria-label="Inputs">
              <SectionHeading
                title="Inputs"
                description="Configure what the simulation can see and hear."
              />
              <div className="grid gap-5 lg:grid-cols-2">
                <Panel>
                  <VideoInput
                    visible={section === 'inputs'}
                    captureIntervalMs={session.preferences.videoCaptureIntervalMs}
                  />
                </Panel>
                <Panel>
                  <AudioInput visible={section === 'inputs'} />
                </Panel>
              </div>
            </section>
          </div>

          {section === 'logs' && (
            <section aria-label="Logs">
              <SectionHeading title="Logs" description="Runtime status and diagnostics." />
              <Panel>
                <h3 className="font-medium">Session diagnostics</h3>
                <p className="mt-2 text-sm text-zinc-400">
                  A timestamped log viewer and native worker output will be added separately. Only
                  the currently available session status is shown here for now.
                </p>
                <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-zinc-400">Status</dt>
                    <dd className="mt-1">{session.status.phase}</dd>
                  </div>
                  <div>
                    <dt className="text-zinc-400">Inference cycle</dt>
                    <dd className="mt-1">{session.status.cycle}</dd>
                  </div>
                  <div>
                    <dt className="text-zinc-400">Pending messages</dt>
                    <dd className="mt-1">{session.status.pendingMessages}</dd>
                  </div>
                  <div>
                    <dt className="text-zinc-400">Retry attempts</dt>
                    <dd className="mt-1">{session.status.retryAttempt}</dd>
                  </div>
                  <div>
                    <dt className="text-zinc-400">Latest inference</dt>
                    <dd className="mt-1">
                      {session.status.latestInferenceMs === null
                        ? '—'
                        : `${Math.round(session.status.latestInferenceMs)} ms`}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-zinc-400">Smoothed inference</dt>
                    <dd className="mt-1">
                      {session.status.smoothedInferenceMs === null
                        ? '—'
                        : `${session.status.smoothedInferenceMs} ms`}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-zinc-400">Playback window</dt>
                    <dd className="mt-1">{session.status.playbackWindowMs} ms</dd>
                  </div>
                  <div>
                    <dt className="text-zinc-400">Dropped observations</dt>
                    <dd className="mt-1">{session.status.droppedObservations}</dd>
                  </div>
                </dl>
                {audioStatus && (
                  <div className="mt-5 border-t border-border pt-4" aria-label="Audio diagnostics">
                    <h4 className="text-sm font-medium">Speech transcription</h4>
                    <p className="mt-2 text-xs text-zinc-400">
                      {audioStatus.sources.length} configured ·{' '}
                      {audioStatus.sources.filter((item) => item.phase === 'ready').length} ready
                    </p>
                    {audioStatus.sources.map((source) => (
                      <p key={source.id} className="mt-2 text-xs text-zinc-300">
                        {source.label} ({source.sourceId}) · {source.phase} ·{' '}
                        {source.pendingSegments} pending
                        {source.error && <span className="text-amber-300"> · {source.error}</span>}
                      </p>
                    ))}
                    {audioStatus.transcripts.slice(-8).map((item, index) => (
                      <p key={`${item.observedAt}-${index}`} className="mt-2 text-xs text-zinc-300">
                        {new Date(item.observedAt).toLocaleTimeString()} · {item.source}:{' '}
                        {item.text}
                      </p>
                    ))}
                  </div>
                )}
                {session.status.warning && (
                  <p className="mt-4 text-sm text-amber-300">{session.status.warning}</p>
                )}
                {(session.actionError || session.status.error) && (
                  <p role="alert" className="mt-4 whitespace-pre-wrap text-sm text-rose-300">
                    {session.actionError || session.status.error}
                  </p>
                )}
              </Panel>
            </section>
          )}

          {section === 'settings' && (
            <section aria-label="Settings">
              <SectionHeading
                title="Settings"
                description="Control inference timing and how much recent context is retained."
              />
              <Panel>
                <h3 className="font-medium">Inference scheduling</h3>
                <p className="mt-2 text-sm text-zinc-400">
                  These preferences are stored on this computer. Manual context and observation
                  history are not saved.
                </p>
                <div className="mt-5 grid gap-5 sm:grid-cols-2">
                  <NumericSettingCombobox
                    id="simulation-pace"
                    title="Inference cycle"
                    name="cycleIntervalMs"
                    value={session.preferences.cycleIntervalMs}
                    options={CYCLE_INTERVAL_OPTIONS}
                    unit="seconds"
                    disabled={!session.ready || session.busy}
                    onChange={(cycleIntervalMs) => update({ cycleIntervalMs })}
                  />
                  <NumericSettingCombobox
                    id="baseline-duration"
                    title="Initial baseline"
                    name="baselineMs"
                    value={session.preferences.baselineMs}
                    options={BASELINE_OPTIONS}
                    unit="seconds"
                    disabled={!session.ready || session.busy}
                    onChange={(baselineMs) => update({ baselineMs })}
                  />
                  <NumericSettingCombobox
                    id="history-max-count"
                    title="History entry limit"
                    name="historyMaxCount"
                    value={session.preferences.historyMaxCount}
                    options={HISTORY_COUNT_OPTIONS}
                    unit="entries"
                    disabled={!session.ready || session.busy}
                    onChange={(historyMaxCount) => update({ historyMaxCount })}
                  />
                  <NumericSettingCombobox
                    id="history-max-age"
                    title="History time horizon"
                    name="historyMaxAgeMs"
                    value={session.preferences.historyMaxAgeMs}
                    options={HISTORY_AGE_OPTIONS}
                    unit="seconds"
                    disabled={!session.ready || session.busy}
                    onChange={(historyMaxAgeMs) => update({ historyMaxAgeMs })}
                  />
                  <NumericSettingCombobox
                    id="inference-timeout"
                    title="Inference timeout"
                    name="inferenceTimeoutMs"
                    value={session.preferences.inferenceTimeoutMs}
                    options={INFERENCE_TIMEOUT_OPTIONS}
                    unit="seconds"
                    disabled={!session.ready || session.busy}
                    onChange={(inferenceTimeoutMs) => update({ inferenceTimeoutMs })}
                  />
                </div>
                <div className="mt-5 max-w-sm">
                  <Label htmlFor="native-reasoning" className="text-sm text-zinc-200">
                    Local model reasoning
                  </Label>
                  <Select
                    items={[
                      { value: 'off', label: 'Disabled (recommended)' },
                      { value: 'on', label: 'Enabled' },
                    ]}
                    value={session.preferences.reasoningEnabled ? 'on' : 'off'}
                    onValueChange={(value) => {
                      if (value === 'off' || value === 'on')
                        update({ reasoningEnabled: value === 'on' });
                    }}
                  >
                    <SelectTrigger
                      id="native-reasoning"
                      className="mt-2 w-full text-sm"
                      disabled={!session.ready || session.busy || running}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="off">Disabled (recommended)</SelectItem>
                      <SelectItem value="on">Enabled</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="mt-2 text-xs text-zinc-500">
                    Disabling thinking saves output tokens and CPU time on supported models. Changes
                    take effect when the next native session starts.
                  </p>
                </div>
                {session.actionError && (
                  <p role="alert" className="mt-4 text-sm text-rose-300">
                    {session.actionError}
                  </p>
                )}
              </Panel>
              <Panel className="mt-5">
                <h3 className="font-medium">Temporal video sampling</h3>
                <p className="mt-2 text-sm text-zinc-400">
                  Frame count adapts to the elapsed inference interval. The coverage limit is a
                  maximum look-back, not a fixed video clip duration. Missing footage cannot be
                  synthesized to meet the minimum frame count.
                </p>
                <div className="mt-5 grid gap-5 sm:grid-cols-2">
                  <NumericSettingCombobox
                    id="video-capture-interval"
                    title="Capture interval"
                    name="videoCaptureIntervalMs"
                    value={session.preferences.videoCaptureIntervalMs}
                    options={VIDEO_CAPTURE_INTERVAL_OPTIONS}
                    unit="seconds"
                    disabled={!session.ready || session.busy}
                    onChange={(videoCaptureIntervalMs) => update({ videoCaptureIntervalMs })}
                  />
                  <NumericSettingCombobox
                    id="video-coverage"
                    title="Maximum temporal coverage"
                    name="videoCoverageMs"
                    value={session.preferences.videoCoverageMs}
                    options={VIDEO_COVERAGE_OPTIONS}
                    unit="seconds"
                    disabled={!session.ready || session.busy}
                    onChange={(videoCoverageMs) => update({ videoCoverageMs })}
                  />
                  <NumericSettingCombobox
                    id="video-min-frames"
                    title="Minimum target frames"
                    name="videoMinFrames"
                    value={session.preferences.videoMinFrames}
                    options={VIDEO_FRAME_COUNT_OPTIONS}
                    unit="entries"
                    disabled={!session.ready || session.busy}
                    onChange={(videoMinFrames) => update({ videoMinFrames })}
                  />
                  <NumericSettingCombobox
                    id="video-max-frames"
                    title="Maximum target frames"
                    name="videoMaxFrames"
                    value={session.preferences.videoMaxFrames}
                    options={VIDEO_FRAME_COUNT_OPTIONS}
                    unit="entries"
                    disabled={!session.ready || session.busy}
                    onChange={(videoMaxFrames) => update({ videoMaxFrames })}
                  />
                </div>
                <p className="mt-2 text-xs text-zinc-500">
                  Minimum target must be no greater than maximum target.
                </p>
                <div className="mt-5 max-w-sm">
                  <Label htmlFor="video-sampling-strategy" className="text-sm text-zinc-200">
                    Temporal selection strategy
                  </Label>
                  <Select
                    items={[
                      { value: 'uniform', label: 'Uniform (full interval)' },
                      { value: 'recent-weighted', label: 'Recent-weighted (keeps endpoints)' },
                    ]}
                    value={session.preferences.videoSamplingStrategy}
                    onValueChange={(value) => {
                      if (value === 'uniform' || value === 'recent-weighted') {
                        update({ videoSamplingStrategy: value });
                      }
                    }}
                  >
                    <SelectTrigger
                      id="video-sampling-strategy"
                      className="mt-2 w-full text-sm"
                      disabled={!session.ready || session.busy}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="uniform">Uniform (full interval)</SelectItem>
                      <SelectItem value="recent-weighted">
                        Recent-weighted (keeps endpoints)
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </Panel>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
