import { useCallback, useEffect, useRef, useState } from 'react';
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
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ChatView } from '@/components/chat-view';
import { FloatingChatControls } from '@/components/floating-chat-controls';
import { BackgroundControls } from '@/components/background-controls';
import {
  DesktopSidebar,
  DESKTOP_SECTIONS,
  type DesktopSection,
} from '@/components/desktop-sidebar';
import { ModelManager } from '@/components/model-manager';
import { NumericSettingCombobox } from '@/components/numeric-setting-combobox';
import { VideoInput } from '@/components/video-input';
import { RecordedVideoInput, type RecordedVideoHandle } from '@/components/recorded-video-input';
import { RecordedAudioInput, type RecordedAudioHandle } from '@/components/recorded-audio-input';
import { DiagnosticCaptureControls } from '@/components/diagnostic-capture-controls';
import { OperationalLogs } from '@/components/operational-logs';
import { InferenceRunInspector } from '@/components/inference-run-inspector';
import { useUnreadLogErrors } from '../use-unread-log-errors';
import { reportRendererFailure } from '../renderer-error-reporting';
import { FreeformPlayground } from '@/components/freeform-playground';
import { SimulationPlayground } from '@/components/simulation-playground';
import { SpeechPlayground } from '@/components/speech-playground';
import { AudioInput } from '@/components/audio-input';
import type { AudioStatus } from '../../shared/audio-contract';
import type { NativeServiceStatus } from '../../shared/native-service-contract';
import type { PromptPreset } from '../../shared/prompt-preset-contract';
import { DEFAULT_OVERLAY_PORT, type OverlayStatus } from '../../shared/overlay-contract';
import { useChat } from '../use-chat';
import { useSession } from '../use-session';
import { useAudience } from '../use-audience';
import {
  AUDIENCE_COUNT_OPTIONS,
  RAM_BUDGET_OPTIONS,
  VRAM_BUDGET_OPTIONS,
  GPU_COMPUTE_OPTIONS,
  CPU_THREAD_OPTIONS,
  CONTEXT_TOKEN_OPTIONS,
  GPU_LAYER_OPTIONS,
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
  isRecordedVideoFailure,
} from '../../shared/session-contract';

export function OverlayPage() {
  const { snapshot } = useChat();
  return (
    <main
      className={
        new URLSearchParams(window.location.search).get('background') === 'opaque'
          ? 'h-dvh bg-background'
          : 'h-dvh bg-transparent'
      }
    >
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
  const audience = useAudience();
  const [section, setSection] = useState<DesktopSection>('simulation');
  const [logFocus, setLogFocus] = useState<{ source: string; nonce: number } | null>(null);
  const unreadErrors = useUnreadLogErrors(section === 'logs');
  const selectSection = (next: DesktopSection) => {
    if (next === 'logs') setLogFocus(null);
    setSection(next);
  };
  const openLogs = (source: string) => {
    setLogFocus({ source, nonce: Date.now() });
    setSection('logs');
  };
  const [playgroundTab, setPlaygroundTab] = useState<'freeform' | 'simulation' | 'speech'>(
    'freeform',
  );
  const [overlayStatus, setOverlayStatus] = useState<OverlayStatus>({
    port: DEFAULT_OVERLAY_PORT,
    url: null,
    error: null,
  });
  const [overlayPort, setOverlayPort] = useState(String(DEFAULT_OVERLAY_PORT));
  const [overlayBusy, setOverlayBusy] = useState(false);
  const [manualContext, setManualContext] = useState('');
  const [promptPresets, setPromptPresets] = useState<PromptPreset[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState('');
  const [presetRevisions, setPresetRevisions] = useState<PromptPreset[]>([]);
  const [selectedPresetRevision, setSelectedPresetRevision] = useState<number | null>(null);
  const [sessionSeedText, setSessionSeedText] = useState('');
  const [inferenceMode, setInferenceMode] = useState<InferenceMode>('fake');
  const [inputMode, setInputMode] = useState<'live' | 'recorded'>('live');
  const [publishRecorded, setPublishRecorded] = useState(false);
  const [recordedSelection, setRecordedSelection] = useState({ hasFile: false, ready: true });
  const [mediaError, setMediaError] = useState<string | null>(null);
  const recordedPlayer = useRef<RecordedVideoHandle>(null);
  const recordedAudio = useRef<RecordedAudioHandle>(null);
  const mediaStartGeneration = useRef(0);
  const [recordedAudioSelection, setRecordedAudioSelection] = useState({ ready: true, count: 0 });
  const updateRecordedAudioSelection = useCallback(setRecordedAudioSelection, []);
  const updateRecordedSelection = useCallback(setRecordedSelection, []);
  const [sampleBusy, setSampleBusy] = useState(false);
  const [audioStatus, setAudioStatus] = useState<AudioStatus | null>(null);
  const [nativeStatus, setNativeStatus] = useState<NativeServiceStatus | null>(null);
  useEffect(() => {
    if (section !== 'simulation') return;
    let active = true;
    void window.lonelyChat
      ?.listPromptPresets()
      .then((items) => {
        if (active) setPromptPresets(items);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [section]);

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
    let live = true;
    const stopOverlay = window.lonelyChat?.onOverlayChange((next) => {
      if (live) setOverlayStatus(next);
    });
    void window.lonelyChat?.getOverlayStatus().then((next) => {
      if (live) setOverlayStatus(next);
    });
    const unsubscribe = window.lonelyChat?.onNativeChange((next) => {
      if (live) setNativeStatus(next);
    });
    void window.lonelyChat?.getNativeStatus().then((next) => {
      if (live) setNativeStatus(next);
    });
    return () => {
      live = false;
      unsubscribe?.();
      stopOverlay?.();
    };
  }, []);

  useEffect(() => {
    setOverlayPort(String(overlayStatus.port));
  }, [overlayStatus.port]);

  const applyOverlayPort = async () => {
    if (!window.lonelyChat || overlayBusy) return;
    setOverlayBusy(true);
    try {
      setOverlayStatus(await window.lonelyChat.configureOverlayPort(Number(overlayPort)));
    } catch (error) {
      reportRendererFailure('overlay', 'operation', error);
      setOverlayStatus((previous) => ({
        ...previous,
        error: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setOverlayBusy(false);
    }
  };

  const publish = async () => {
    if (!window.lonelyChat || sampleBusy) return;
    setSampleBusy(true);
    try {
      await window.lonelyChat.publishSample();
    } finally {
      setSampleBusy(false);
    }
  };

  const running = ['running', 'starting', 'switching'].includes(session.status.phase);
  const mediaActive =
    running || (session.status.phase === 'error' && !isRecordedVideoFailure(session.status));
  const current = DESKTOP_SECTIONS.find((item) => item.id === section)!;
  const seedValid =
    sessionSeedText === '' ||
    (/^[0-9]+$/.test(sessionSeedText) && Number(sessionSeedText) <= 2147483647);
  const configuredSeed = sessionSeedText === '' ? undefined : Number(sessionSeedText);
  const update = (changes: Partial<SessionPreferences>) =>
    void session.updatePreferences({ ...session.preferences, ...changes });

  const startSimulation = async () => {
    const generation = ++mediaStartGeneration.current;
    setMediaError(null);
    const started = await session.start(manualContext, inferenceMode, {
      inputMode,
      publishToOverlay: inputMode === 'live' || publishRecorded,
      hasVideoFile: inputMode === 'recorded' && recordedSelection.hasFile,
      hasAudioFiles: inputMode === 'recorded' && recordedAudioSelection.count > 0,
      ...(configuredSeed === undefined ? {} : { seed: configuredSeed }),
      ...(selectedPresetId ? { presetId: selectedPresetId } : {}),
      ...(selectedPresetId && selectedPresetRevision
        ? { presetRevision: selectedPresetRevision }
        : {}),
    });
    if (!started || inputMode !== 'recorded') return;
    try {
      await recordedAudio.current?.prepare();
      if (generation !== mediaStartGeneration.current) return;
      const api = window.lonelyChat;
      if (!api) throw new Error('Desktop media integration is unavailable.');
      const observedAt = await api.getVideoClock();
      if (generation !== mediaStartGeneration.current) return;
      const origin = { observedAt, monotonicMs: performance.now() };
      // Both producers use one observation epoch; model processing never drives either clock.
      await Promise.all([
        recordedAudio.current?.begin(origin),
        recordedSelection.hasFile
          ? recordedPlayer.current?.begin(session.preferences.videoCaptureIntervalMs, origin)
          : undefined,
      ]);
    } catch (error) {
      if (generation !== mediaStartGeneration.current) return;
      const message = error instanceof Error ? error.message : String(error);
      setMediaError(message);
      reportRendererFailure('simulation', 'operation', error);
      await window.lonelyChat?.reportRecordedVideoError(message).catch(() => {});
    }
  };

  const stopSimulation = () => {
    ++mediaStartGeneration.current;
    recordedPlayer.current?.stop();
    recordedAudio.current?.stop();
    void session.stop();
  };

  return (
    <div className="min-h-dvh bg-background text-foreground sm:flex">
      <DesktopSidebar
        selected={section}
        onSelect={selectSection}
        simulationPhase={session.status.phase}
        unreadErrors={unreadErrors}
      />
      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-10 flex min-h-14 items-center justify-between gap-3 border-b border-border bg-[#181820] px-5 py-3 sm:px-7">
          <div className="flex items-center gap-2">
            <MessageSquareText className="size-5 text-violet-300 sm:hidden" aria-hidden="true" />
            <h1 className="text-sm font-semibold">{current.title}</h1>
          </div>
          <div className="flex items-center gap-2 text-xs text-zinc-400">
            {overlayStatus.error && (
              <Button
                variant="link"
                size="sm"
                className="text-amber-300"
                onClick={() => openLogs('overlay')}
              >
                Overlay port issue · View Logs
              </Button>
            )}
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
          <div hidden={section !== 'playground'}>
            <div className="mb-5 flex flex-wrap gap-2" role="group" aria-label="Playground tools">
              <Button
                variant={playgroundTab === 'freeform' ? 'default' : 'secondary'}
                onClick={() => setPlaygroundTab('freeform')}
              >
                Freeform inference
              </Button>
              <Button
                variant={playgroundTab === 'simulation' ? 'default' : 'secondary'}
                onClick={() => setPlaygroundTab('simulation')}
              >
                Simulation one-shot
              </Button>
              <Button
                variant={playgroundTab === 'speech' ? 'default' : 'secondary'}
                onClick={() => setPlaygroundTab('speech')}
              >
                Speech testing
              </Button>
            </div>
            <div hidden={playgroundTab !== 'freeform'}>
              <FreeformPlayground
                simulationActive={running || session.busy || audience.busy}
                onViewLogs={() => openLogs('ipc')}
              />
            </div>
            {playgroundTab === 'simulation' && (
              <SimulationPlayground
                simulationActive={running || session.busy || audience.busy}
                onViewLogs={(source) => openLogs(source)}
              />
            )}
            {playgroundTab === 'speech' && (
              <SpeechPlayground
                simulationActive={running || session.busy || audience.busy}
                onViewLogs={() => openLogs('whisper')}
              />
            )}
          </div>
          <div hidden={section !== 'simulation'}>
            <section aria-label="Simulation">
              <SectionHeading
                title="Simulation"
                description="Simulate an audience from manual context, with or without a local model."
              />
              <Panel>
                <h3 className="flex items-center gap-2 font-medium text-violet-300">
                  <Sparkles size={18} aria-hidden="true" /> Continuous inference
                </h3>
                <p className="mt-3 text-sm leading-6 text-zinc-300">
                  Describe what is happening on your stream. Use deterministic fixture replies or
                  generate chat using an active, installed GGUF model via local llama.cpp.
                </p>
                <Label htmlFor="simulation-input-mode" className="mt-4 text-sm text-zinc-200">
                  Media input mode
                </Label>
                <Select
                  items={[
                    { value: 'live', label: 'Live devices and screens' },
                    { value: 'recorded', label: 'Recorded video (1×)' },
                  ]}
                  value={inputMode}
                  onValueChange={(value) => {
                    if (value === 'live' || value === 'recorded') {
                      setInputMode(value);
                      setRecordedSelection({ hasFile: false, ready: true });
                    }
                  }}
                >
                  <SelectTrigger
                    id="simulation-input-mode"
                    disabled={mediaActive}
                    className="mt-2 w-full text-sm"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="live">Live devices and screens</SelectItem>
                    <SelectItem value="recorded">Recorded video (1×)</SelectItem>
                  </SelectContent>
                </Select>
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
                <Label htmlFor="session-preset" className="mt-4 text-sm text-zinc-200">
                  Prompt preset
                </Label>
                <Select
                  value={selectedPresetId || '__manual'}
                  onValueChange={(value) => {
                    setSelectedPresetId(value === '__manual' ? '' : (value ?? ''));
                    const chosen = promptPresets.find((p) => p.id === value);
                    setPresetRevisions([]);
                    setSelectedPresetRevision(chosen?.revision ?? null);
                    if (chosen) {
                      setManualContext(chosen.values.context);
                      void window.lonelyChat
                        ?.listPromptPresetRevisions(chosen.id)
                        .then(setPresetRevisions)
                        .catch(() => {});
                    }
                  }}
                  items={[
                    { value: '__manual', label: 'Manual context' },
                    ...promptPresets.map((p) => ({
                      value: p.id,
                      label: `${p.name} · revision ${p.revision}`,
                    })),
                  ]}
                >
                  <SelectTrigger id="session-preset" disabled={running} className="mt-2 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__manual">Manual context</SelectItem>
                    {promptPresets.map((p) => (
                      <SelectItem value={p.id} key={p.id}>
                        {p.name} · revision {p.revision}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedPresetId && (
                  <>
                    <Label htmlFor="session-preset-revision" className="mt-4 text-sm text-zinc-200">
                      Preset revision
                    </Label>
                    <Select
                      value={String(selectedPresetRevision ?? '')}
                      onValueChange={(value) => {
                        const chosen = presetRevisions.find((p) => String(p.revision) === value);
                        if (chosen) {
                          setSelectedPresetRevision(chosen.revision);
                          setManualContext(chosen.values.context);
                        }
                      }}
                      items={presetRevisions.map((p) => ({
                        value: String(p.revision),
                        label: `Revision ${p.revision}`,
                      }))}
                    >
                      <SelectTrigger
                        id="session-preset-revision"
                        disabled={running}
                        className="mt-2 w-full"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {presetRevisions.map((p) => (
                          <SelectItem key={p.revision} value={String(p.revision)}>
                            Revision {p.revision}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </>
                )}
                <p className="mt-2 text-xs text-zinc-500">
                  The selected preset’s context and chat activity are captured at Start. Sample
                  history stays Playground-only.
                </p>
                <Label htmlFor="simulation-context" className="mt-4 text-sm text-zinc-200">
                  Stream context
                </Label>
                <Textarea
                  id="simulation-context"
                  className="mt-2 min-h-24 resize-y text-sm"
                  maxLength={2000}
                  value={manualContext}
                  disabled={running || Boolean(selectedPresetId)}
                  onChange={(event) => setManualContext(event.target.value)}
                  placeholder="For example: I'm exploring a haunted castle in a fantasy game…"
                />
                <Label htmlFor="simulation-seed" className="mt-4 text-sm text-zinc-200">
                  Session seed (optional)
                </Label>
                <Input
                  id="simulation-seed"
                  className="mt-2 max-w-sm"
                  type="number"
                  min={0}
                  max={2147483647}
                  step={1}
                  placeholder="Generate at Start"
                  value={sessionSeedText}
                  onChange={(event) => setSessionSeedText(event.target.value)}
                  disabled={running}
                  aria-invalid={!seedValid}
                />
                <p className="mt-2 text-xs text-zinc-500">
                  Blank generates a new base seed. Each model request and retry gets its own derived
                  seed; existing viewer identities are kept until regeneration.
                </p>
                {!seedValid && (
                  <p role="alert" className="mt-2 text-sm text-rose-300">
                    Enter a whole-number seed from 0 to 2147483647.
                  </p>
                )}
                {inputMode === 'recorded' && (
                  <>
                    <RecordedVideoInput
                      ref={recordedPlayer}
                      running={mediaActive}
                      onSelectionChange={updateRecordedSelection}
                    />
                    <RecordedAudioInput
                      ref={recordedAudio}
                      running={mediaActive}
                      onSelectionChange={updateRecordedAudioSelection}
                    />
                    <label className="mt-4 flex items-center gap-2 text-sm text-zinc-300">
                      <input
                        type="checkbox"
                        checked={publishRecorded}
                        disabled={running}
                        onChange={(event) => setPublishRecorded(event.target.checked)}
                      />
                      Publish recorded chat to overlay and floating window
                    </label>
                    <p className="mt-2 text-xs text-zinc-500">
                      Otherwise recorded chat appears only in the desktop Chat preview.
                    </p>
                  </>
                )}
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  {running ? (
                    <Button disabled={!session.ready || session.busy} onClick={stopSimulation}>
                      <Square size={15} /> Stop simulation
                    </Button>
                  ) : (
                    <Button
                      disabled={
                        !session.ready ||
                        session.busy ||
                        !seedValid ||
                        (inputMode === 'recorded' &&
                          (!recordedSelection.ready || !recordedAudioSelection.ready))
                      }
                      onClick={() => void startSimulation()}
                    >
                      <Play size={15} /> Start simulation
                    </Button>
                  )}
                  {session.status.phase === 'error' && !isRecordedVideoFailure(session.status) && (
                    <Button
                      variant="secondary"
                      disabled={!session.ready || session.busy}
                      onClick={() => void session.retry()}
                    >
                      Retry inference
                    </Button>
                  )}
                  <span role="status" aria-live="polite" className="text-sm text-zinc-400">
                    {running
                      ? session.status.phase === 'switching'
                        ? 'Switching local llama.cpp model…'
                        : session.status.phase === 'starting'
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
                {(mediaError || session.actionError || session.status.error) && (
                  <p role="alert" className="mt-3 text-sm text-rose-300">
                    {mediaError || session.actionError || session.status.error}
                  </p>
                )}
                {(nativeStatus?.phase === 'failed' || session.status.phase === 'error') && (
                  <Button
                    variant="link"
                    size="sm"
                    onClick={() =>
                      openLogs(nativeStatus?.phase === 'failed' ? 'llama.cpp' : 'session')
                    }
                  >
                    View worker failure in Logs
                  </Button>
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
          </div>

          {section === 'models' && (
            <section aria-label="Models">
              <SectionHeading
                title="Models"
                description="Discover, install, activate, and remove local inference models."
              />
              <ModelManager
                sessionPhase={session.status.phase}
                sessionMode={session.status.mode}
                onViewLogs={() => openLogs('ipc')}
              />
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
                      {overlayStatus.url || 'Overlay server unavailable'}
                    </code>
                    {overlayStatus.error && (
                      <p role="alert" className="mt-3 text-sm text-rose-300">
                        {overlayStatus.error}
                      </p>
                    )}
                    {!overlayStatus.url && (
                      <>
                        <Button variant="link" size="sm" onClick={() => setSection('settings')}>
                          Configure overlay port
                        </Button>
                        {overlayStatus.error && (
                          <Button variant="link" size="sm" onClick={() => openLogs('overlay')}>
                            See overlay errors in Logs
                          </Button>
                        )}
                      </>
                    )}
                    {overlayStatus.url && (
                      <Button
                        variant="secondary"
                        className="mt-3"
                        aria-label="Open overlay"
                        onClick={() => window.open(overlayStatus.url!, '_blank')}
                      >
                        <ExternalLink size={16} /> Open overlay
                      </Button>
                    )}
                  </Panel>
                  <Panel>
                    <FloatingChatControls />
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
                <h3 className="font-medium">Persistent chatter roster</h3>
                <p className="mt-2 text-sm text-zinc-400">
                  Names are generated on first simulation start using its selected inference mode.
                  They are saved locally and remain stable across sessions. Reducing the count does
                  not change previously displayed chat authors.
                </p>
                <div className="mt-5 grid gap-5 sm:grid-cols-2">
                  <NumericSettingCombobox
                    id="audience-count"
                    title="Target viewer count"
                    name="audienceCount"
                    value={session.preferences.audienceCount}
                    options={AUDIENCE_COUNT_OPTIONS}
                    unit="entries"
                    disabled={!session.ready || session.busy || running || audience.busy}
                    onChange={(audienceCount) => update({ audienceCount })}
                  />
                  <div>
                    <Label htmlFor="chat-activity" className="text-sm text-zinc-200">
                      Chat activity
                    </Label>
                    <Select
                      items={[
                        { value: 'quiet', label: 'Quiet (up to 2 per cycle)' },
                        { value: 'normal', label: 'Normal (up to 4 per cycle)' },
                        { value: 'busy', label: 'Busy (up to 8 per cycle)' },
                      ]}
                      value={session.preferences.chatActivity}
                      onValueChange={(value) => {
                        if (value === 'quiet' || value === 'normal' || value === 'busy')
                          update({ chatActivity: value });
                      }}
                    >
                      <SelectTrigger
                        id="chat-activity"
                        className="mt-2 w-full"
                        disabled={!session.ready || session.busy}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="quiet">Quiet (up to 2 per cycle)</SelectItem>
                        <SelectItem value="normal">Normal (up to 4 per cycle)</SelectItem>
                        <SelectItem value="busy">Busy (up to 8 per cycle)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="mt-5 flex flex-wrap items-center justify-between gap-4 border-t border-border pt-4">
                  <p className="text-sm text-zinc-300" role="status">
                    {audience.status.phase === 'generating'
                      ? 'Generating usernames using the selected model…'
                      : `${audience.status.members.length} of ${session.preferences.audienceCount} viewers configured`}
                  </p>
                  <Button
                    variant="secondary"
                    disabled={
                      running ||
                      audience.busy ||
                      !session.ready ||
                      session.busy ||
                      audience.status.phase === 'generating' ||
                      !seedValid
                    }
                    onClick={() => void audience.regenerate(inferenceMode, configuredSeed)}
                  >
                    Regenerate roster ({inferenceMode === 'native' ? 'native model' : 'fixture'})
                  </Button>
                </div>
                {audience.status.attemptedGenerationSeed != null &&
                  audience.status.attemptedGenerationSeed !== audience.status.generationSeed && (
                    <p className="mt-3 text-xs text-zinc-400">
                      Last requested roster seed: {audience.status.attemptedGenerationSeed}
                    </p>
                  )}
                {audience.status.generationSeed != null && (
                  <p className="mt-3 text-xs text-zinc-400">
                    Roster generation seed: {audience.status.generationSeed}
                    {!!audience.status.generationAttemptSeeds?.length &&
                      ` · request seeds: ${audience.status.generationAttemptSeeds.join(', ')}`}
                  </p>
                )}
                {(audience.error || audience.status.error || session.actionError) && (
                  <p role="alert" className="mt-3 text-sm text-rose-300">
                    {audience.error || audience.status.error || session.actionError}
                  </p>
                )}
                {audience.status.members.length < session.preferences.audienceCount && (
                  <p className="mt-3 text-xs text-zinc-400">
                    The next simulation start will generate missing names. If generation fails, the
                    roster is retained; stop and retry from this panel.
                  </p>
                )}
                <ul className="mt-4 grid gap-2 sm:grid-cols-2">
                  {audience.status.members.map((member) => (
                    <li
                      key={member.author}
                      className="flex items-center gap-2 rounded-md border border-border p-2 text-sm"
                    >
                      <span
                        aria-hidden="true"
                        className="size-2 rounded-full"
                        style={{ backgroundColor: member.color }}
                      />
                      {member.author}
                    </li>
                  ))}
                </ul>
              </Panel>
            </section>
          )}

          <div hidden={section !== 'inputs'}>
            <section aria-label="Inputs">
              <SectionHeading
                title="Inputs"
                description="Configure what the simulation can see and hear."
              />
              {audioStatus?.sources.some((source) => source.phase === 'error') && (
                <Button variant="link" size="sm" onClick={() => openLogs('whisper')}>
                  View speech input errors in Logs
                </Button>
              )}
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

          {section === 'inspector' && (
            <section aria-label="Run Inspector">
              <SectionHeading
                title="Run Inspector"
                description="Inspect each production Simulation inference attempt, including retries, raw model responses and scheduled chat."
              />
              <InferenceRunInspector />
            </section>
          )}

          {section === 'logs' && (
            <section aria-label="Logs">
              <SectionHeading title="Logs" description="Runtime status and diagnostics." />
              <OperationalLogs focus={logFocus} />
              <DiagnosticCaptureControls />
              <Panel>
                <h3 className="font-medium">Session diagnostics</h3>
                <p className="mt-2 text-xs text-zinc-400">
                  Measured inference duration and an estimated next duration are not a guarantee of
                  future execution time.
                </p>
                <p className="mt-2 text-sm text-zinc-400" aria-label="Native inference lifecycle">
                  llama.cpp: {nativeStatus?.phase ?? 'unknown'}
                  {nativeStatus?.error ? ` · ${nativeStatus.error}` : ''}
                </p>
                <p className="mt-2 text-sm text-zinc-400">
                  Recent inference errors below include timestamps, cycle and attempt numbers, and
                  field-level validation failures. Enable private diagnostic capture before retrying
                  to export rejected model output and raw native worker text. Worker output is
                  classified into privacy-safe, source-labeled operational entries above; binary
                  Whisper transcription replies are never logged as text.
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
                    <dt className="text-zinc-400">Frozen prompt preset</dt>
                    <dd className="mt-1">
                      {session.status.promptPreset
                        ? `${session.status.promptPreset.name} · revision ${session.status.promptPreset.revision}`
                        : 'Manual context'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-zinc-400">Session seed</dt>
                    <dd className="mt-1">{session.status.sessionSeed ?? '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-zinc-400">Last submitted seed</dt>
                    <dd className="mt-1">{session.status.effectiveSeed ?? '—'}</dd>
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
                    <dt className="text-zinc-400">Estimated next inference</dt>
                    <dd className="mt-1">
                      {session.status.estimatedNextInferenceMs == null
                        ? '—'
                        : `${session.status.estimatedNextInferenceMs} ms (estimate)`}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-zinc-400">Effective cycle interval</dt>
                    <dd className="mt-1">
                      {session.status.effectiveCycleMs == null
                        ? '—'
                        : `${session.status.effectiveCycleMs} ms`}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-zinc-400">Adaptive frame ceiling</dt>
                    <dd className="mt-1">{session.status.adaptiveFrameLimit ?? '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-zinc-400">llama.cpp worker RSS</dt>
                    <dd className="mt-1">
                      {session.status.workerRamMiB == null
                        ? 'Unavailable on this platform'
                        : `${Math.round(session.status.workerRamMiB)} MiB (RSS)`}
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
                {nativeStatus?.resources && (
                  <div
                    className="mt-4 space-y-1 border-t border-border pt-4 text-xs text-zinc-300"
                    aria-label="Selected inference resources"
                  >
                    <p>
                      Selected backend: {nativeStatus.resources.backend.toUpperCase()} · available
                      in this build:{' '}
                      {nativeStatus.resources.availableBackends
                        .map((item) => item.toUpperCase())
                        .join(', ')}
                    </p>
                    <p>
                      Applied: {nativeStatus.resources.cpuThreads} CPU threads ·{' '}
                      {nativeStatus.resources.contextTokens} context tokens ·{' '}
                      {nativeStatus.resources.gpuOffloadLayers} GPU layers
                    </p>
                    <p>
                      Advisory targets: {nativeStatus.resources.ramTargetMiB} MiB RAM ·{' '}
                      {nativeStatus.resources.vramTargetMiB} MiB VRAM ·{' '}
                      {nativeStatus.resources.gpuComputeTargetPercent}% GPU compute
                    </p>
                    {nativeStatus.resources.diagnostic && (
                      <p className="text-amber-300">{nativeStatus.resources.diagnostic}</p>
                    )}
                  </div>
                )}
                {session.status.adaptationReason && (
                  <p className="mt-3 text-xs text-amber-300">{session.status.adaptationReason}</p>
                )}
                {!!session.status.recentAttemptSeeds?.length && (
                  <div className="mt-4 text-xs text-zinc-400" aria-label="Recent inference seeds">
                    <h4 className="font-medium">Recent inference attempt seeds</h4>
                    {session.status.recentAttemptSeeds.map(({ cycle, attempt, seed }, index) => (
                      <p key={index} className="mt-1">
                        Cycle {cycle} · attempt {attempt} · seed {seed}
                      </p>
                    ))}
                  </div>
                )}
                {!!session.status.recentErrors?.length && (
                  <div className="mt-4 text-xs text-zinc-400" aria-label="Recent inference errors">
                    <h4 className="font-medium">Recent inference errors</h4>
                    {session.status.recentErrors.map((error, index) => (
                      <p key={index} className="mt-1 text-amber-300">
                        {error}
                      </p>
                    ))}
                  </div>
                )}
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
                description="Control application behavior, inference timing and context retention."
              />
              <Panel className="mb-5">
                <BackgroundControls />
              </Panel>
              <Panel className="mb-5">
                <h3 className="font-medium">Browser overlay server</h3>
                <p className="mt-2 text-sm text-zinc-400">
                  The local HTTP port used by OBS browser sources and floating chat windows.
                  Changing it updates the URL and reconnects the floating window.
                </p>
                <div className="mt-4 flex max-w-sm items-end gap-3">
                  <div className="min-w-0 flex-1">
                    <Label htmlFor="overlay-port">Overlay port</Label>
                    <Input
                      id="overlay-port"
                      type="number"
                      min={1}
                      max={65535}
                      step={1}
                      className="mt-2"
                      value={overlayPort}
                      onChange={(event) => setOverlayPort(event.target.value)}
                      disabled={overlayBusy}
                    />
                  </div>
                  <Button
                    variant="secondary"
                    disabled={
                      overlayBusy ||
                      !/^\d+$/.test(overlayPort) ||
                      Number(overlayPort) < 1 ||
                      Number(overlayPort) > 65535
                    }
                    onClick={() => void applyOverlayPort()}
                  >
                    {overlayBusy ? 'Applying…' : 'Apply port'}
                  </Button>
                </div>
                <p className="mt-3 text-sm text-zinc-300">
                  {overlayStatus.url ?? 'Overlay server stopped'}
                </p>
                {overlayStatus.error && (
                  <p role="alert" className="mt-2 text-sm text-rose-300">
                    {overlayStatus.error}
                  </p>
                )}
              </Panel>
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
                <h3 className="font-medium">Resource targets and native backend</h3>
                <p className="mt-2 text-sm text-zinc-400">
                  CPU thread count, context size, and GPU offload layers are passed to llama.cpp at
                  its next launch. RAM, VRAM and GPU-compute targets are{' '}
                  <strong>best-effort guidance</strong>, not enforceable quotas. There is no hard
                  GPU partition or exact VRAM cap. The installed backend must expose a usable device
                  to enable GPU offload.
                </p>
                <div className="mt-5 max-w-sm">
                  <Label htmlFor="resource-backend" className="text-sm text-zinc-200">
                    Preferred backend (fallback to CPU)
                  </Label>
                  <Select
                    items={[
                      { value: 'auto', label: 'Auto (detected devices)' },
                      { value: 'cpu', label: 'CPU (always available)' },
                      { value: 'cuda', label: 'CUDA (requires CUDA build)' },
                      { value: 'vulkan', label: 'Vulkan (requires Vulkan build)' },
                      { value: 'metal', label: 'Metal (requires Metal build)' },
                    ]}
                    value={session.preferences.computeBackend}
                    onValueChange={(value) => {
                      if (
                        value === 'auto' ||
                        value === 'cpu' ||
                        value === 'cuda' ||
                        value === 'vulkan' ||
                        value === 'metal'
                      )
                        update({ computeBackend: value });
                    }}
                  >
                    <SelectTrigger
                      id="resource-backend"
                      className="mt-2 w-full"
                      disabled={!session.ready || session.busy || running}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">Auto (detected devices)</SelectItem>
                      <SelectItem value="cpu">CPU (always available)</SelectItem>
                      <SelectItem value="cuda">CUDA (requires CUDA build)</SelectItem>
                      <SelectItem value="vulkan">Vulkan (requires Vulkan build)</SelectItem>
                      <SelectItem value="metal">Metal (requires Metal build)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="mt-5 grid gap-5 sm:grid-cols-2">
                  <NumericSettingCombobox
                    id="ram-budget"
                    title="System RAM target (advisory)"
                    name="ramBudgetMiB"
                    value={session.preferences.ramBudgetMiB}
                    options={RAM_BUDGET_OPTIONS}
                    unit="MiB"
                    disabled={!session.ready || session.busy}
                    onChange={(ramBudgetMiB) => update({ ramBudgetMiB })}
                  />
                  <NumericSettingCombobox
                    id="vram-budget"
                    title="VRAM target (advisory; 0 = off)"
                    name="vramBudgetMiB"
                    value={session.preferences.vramBudgetMiB}
                    options={VRAM_BUDGET_OPTIONS}
                    unit="MiB"
                    disabled={!session.ready || session.busy}
                    onChange={(vramBudgetMiB) => update({ vramBudgetMiB })}
                  />
                  <NumericSettingCombobox
                    id="compute-target"
                    title="GPU-compute target (best effort; 0 = off)"
                    name="gpuComputeTargetPercent"
                    value={session.preferences.gpuComputeTargetPercent}
                    options={GPU_COMPUTE_OPTIONS}
                    unit="percent"
                    disabled={!session.ready || session.busy}
                    onChange={(gpuComputeTargetPercent) => update({ gpuComputeTargetPercent })}
                  />
                  <NumericSettingCombobox
                    id="cpu-threads"
                    title="CPU threads (at next load)"
                    name="cpuThreads"
                    value={session.preferences.cpuThreads}
                    options={CPU_THREAD_OPTIONS}
                    unit="entries"
                    disabled={!session.ready || session.busy || running}
                    onChange={(cpuThreads) => update({ cpuThreads })}
                  />
                  <NumericSettingCombobox
                    id="context-tokens"
                    title="Context tokens (at next load)"
                    name="contextTokens"
                    value={session.preferences.contextTokens}
                    options={CONTEXT_TOKEN_OPTIONS}
                    unit="entries"
                    disabled={!session.ready || session.busy || running}
                    onChange={(contextTokens) => update({ contextTokens })}
                  />
                  <NumericSettingCombobox
                    id="gpu-layers"
                    title="GPU offload layers (at next load)"
                    name="gpuOffloadLayers"
                    value={session.preferences.gpuOffloadLayers}
                    options={GPU_LAYER_OPTIONS}
                    unit="entries"
                    disabled={!session.ready || session.busy || running}
                    onChange={(gpuOffloadLayers) => update({ gpuOffloadLayers })}
                  />
                </div>
                <p className="mt-3 text-xs text-zinc-500">
                  The bundled Windows/Linux CPU-only llama.cpp builds expose no GPU device. A
                  GPU-capable build is required for CUDA or Vulkan; Metal is only possible on a
                  supported macOS build. Resource telemetry can be unavailable and inference will
                  continue.
                </p>
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
