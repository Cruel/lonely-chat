import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { JsonInspector } from './json-inspector';
import { PlaygroundMediaPicker } from './playground-media-picker';
import type { InferenceProfile } from '../../shared/inference-profile-contract';
import type { PlaygroundFrame } from '../../shared/playground-media-contract';
import type { SimulationExperimentValues } from '../../shared/playground-contract';
import type {
  ProfileExperimentMode, ProfileExperimentPreview, ProfileExperimentRequest, ProfileExperimentResult,
} from '../../shared/profile-playground-contract';

const defaultRoster = [{ author: 'pixelpilot', color: '#bba5ff' }];

function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff;
}

function parseArray(label: string, content: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`${label} must contain valid JSON.`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${label} must be an array.`);
  return parsed;
}

/** Independent stage experiments; never reads or writes live Session/Chat state. */
export function ProfileStagePlayground({ simulationActive }: { readonly simulationActive: boolean }) {
  const [profiles, setProfiles] = useState<InferenceProfile[]>([]);
  const [profileId, setProfileId] = useState('');
  const [mode, setMode] = useState<ProfileExperimentMode>('pipeline');
  const [context, setContext] = useState('Playing a game on stream.');
  const [roster, setRoster] = useState(JSON.stringify(defaultRoster, null, 2));
  const [observations, setObservations] = useState('[]');
  const [events, setEvents] = useState('[]');
  const [transcripts, setTranscripts] = useState('[]');
  const [recentChat, setRecentChat] = useState('[]');
  const [frames, setFrames] = useState<PlaygroundFrame[]>([]);
  const [seed, setSeed] = useState(() => String(randomSeed()));
  const [visionReferenceId, setVisionReferenceId] = useState('');
  const [busy, setBusy] = useState(false);
  const [serverBusy, setServerBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ProfileExperimentPreview | null>(null);
  const [history, setHistory] = useState<ProfileExperimentResult[]>([]);
  const [selectedResultId, setSelectedResultId] = useState('');
  const selected = profiles.find((item) => item.id === profileId);
  const effectiveMode = selected?.values.topology === 'unified' ? 'pipeline' : mode;
  const locked = busy || serverBusy || simulationActive;
  const activeResult = history.find((item) => item.id === selectedResultId) ?? history[0];
  const references = history
    .filter((item) => item.visionReference)
    .map((item) => item.visionReference!);

  useEffect(() => {
    let mounted = true;
    const api = window.lonelyChat;
    void api?.listInferenceProfiles?.().then((items) => {
      if (!mounted) return;
      setProfiles(items);
      setProfileId((prior) => items.some((item) => item.id === prior) ? prior : (items[0]?.id ?? ''));
    }).catch((reason: unknown) => { if (mounted) setError(String(reason)); });
    const unsubscribe = api?.onPlaygroundStatus((value) => {
      if (mounted) setServerBusy(value.busy);
    });
    void api?.getPlaygroundStatus().then((value) => {
      if (mounted) setServerBusy(value.busy);
    }).catch(() => {});
    return () => { mounted = false; unsubscribe?.(); };
  }, []);

  function form(): ProfileExperimentRequest {
    if (!selected) throw new Error('Select a saved Inference Profile.');
    const values: SimulationExperimentValues = {
      context,
      cycle: 1,
      playbackWindowMs: 3000,
      chatActivity: 'normal',
      roster: parseArray('Roster', roster) as unknown as SimulationExperimentValues['roster'],
      observations: parseArray('Observations', observations) as unknown as SimulationExperimentValues['observations'],
      events: parseArray('Events', events) as unknown as SimulationExperimentValues['events'],
      transcripts: parseArray('Transcripts', transcripts) as unknown as SimulationExperimentValues['transcripts'],
      recentChat: parseArray('Recent chat', recentChat) as unknown as SimulationExperimentValues['recentChat'],
    };
    const chatRole = selected.values.roles.chat ?? selected.values.roles.unified;
    const modelId = chatRole?.modelId ?? selected.values.roles.observer?.modelId ?? '';
    return {
      profileId: selected.id,
      profileRevision: selected.revision,
      mode: effectiveMode,
      experiment: { modelId, values, seed: Number(seed), ...(frames.length ? { frames } : {}) },
      ...(effectiveMode === 'chat' && visionReferenceId
        ? { visionReferenceId } : {}),
    };
  }

  async function execute(previewOnly: boolean) {
    if (!window.lonelyChat || busy || !selected) return;
    if (!previewOnly && locked) return;
    setError(null);
    setBusy(true);
    try {
      const request = form();
      if (previewOnly) {
        if (!window.lonelyChat.previewProfileExperiment)
          throw new Error('Profile Playground is unavailable in this desktop build.');
        setPreview(await window.lonelyChat.previewProfileExperiment(request));
      } else {
        if (!window.lonelyChat.runProfileExperiment)
          throw new Error('Profile Playground is unavailable in this desktop build.');
        const result = await window.lonelyChat.runProfileExperiment(request);
        setHistory((items) => [result, ...items].slice(0, 12));
        setSelectedResultId(result.id);
        setPreview(null);
        setSeed(String(randomSeed()));
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Profile stage Playground" className="space-y-5">
      <header>
        <h2 className="text-2xl font-semibold">Profile stage experiments</h2>
        <p className="mt-2 text-sm text-zinc-400">
          Run Vision, Chat or the entire selected profile with production stage prompts,
          schema validation and frame sampling. Accepted results stay in this Playground.
          Saved Vision outputs can be reused to compare Chat prompts or provider models without another Vision call.
        </p>
      </header>
      <div className="space-y-4 rounded-xl border border-border bg-card p-5">
        <label className="block text-sm">
          Inference Profile
          <select aria-label="Inference Profile" value={selected?.id ?? ''}
            onChange={(event) => {
              setProfileId(event.target.value);
              setPreview(null);
            }}
            className="mt-1 w-full rounded border border-zinc-600 bg-zinc-900 p-2">
            {profiles.length === 0 && <option value="">No saved profiles</option>}
            {profiles.map((item) => (
              <option value={item.id} key={item.id}>{item.name} · r{item.revision} · {item.values.topology}</option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          Experiment mode
          <select aria-label="Experiment mode" value={effectiveMode}
            disabled={selected?.values.topology === 'unified'}
            onChange={(event) => { setMode(event.target.value as ProfileExperimentMode); setPreview(null); }}
            className="mt-1 w-full rounded border border-zinc-600 bg-zinc-900 p-2">
            <option value="pipeline">Full pipeline</option>
            {selected?.values.topology !== 'unified' && <option value="vision">Vision only</option>}
            {selected?.values.topology !== 'unified' && <option value="chat">Chat only</option>}
          </select>
        </label>
        {effectiveMode === 'chat' && (
          <label className="block text-sm">
            Reuse captured Vision result
            <select aria-label="Reuse captured Vision result" value={visionReferenceId}
              onChange={(event) => { setVisionReferenceId(event.target.value); setPreview(null); }}
              className="mt-1 w-full rounded border border-zinc-600 bg-zinc-900 p-2">
              <option value="">Use supplied visual observations below</option>
              {references.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>
        )}
        <label className="block text-sm">Stage experiment context
          <Textarea aria-label="Profile experiment context" value={context} onChange={(event) => setContext(event.target.value)} className="mt-1" />
        </label>
        <div className="grid gap-3 md:grid-cols-2">
          {([
            ['Roster', roster, setRoster],
            ['Visual observations (Chat-only or extra context)', observations, setObservations],
            ['Events', events, setEvents],
            ['Transcripts', transcripts, setTranscripts],
            ['Recent chat', recentChat, setRecentChat],
          ] as const).map(([label, value, onChange]) => (
            <label key={label} className="block text-sm">{label} (JSON)
              <Textarea aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}
                className="mt-1 font-mono text-xs" rows={4} />
            </label>
          ))}
          <label className="block text-sm">Seed
            <Input aria-label="Experiment seed" type="number" min={0} max={2147483647}
              value={seed} onChange={(event) => setSeed(event.target.value)} className="mt-1" />
          </label>
        </div>
        <PlaygroundMediaPicker frames={frames} onChange={setFrames} />
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" disabled={!selected || busy}
            onClick={() => void execute(true)}>Preview effective stages</Button>
          <Button disabled={!selected || locked} onClick={() => void execute(false)}>
            {busy ? 'Running experiment…' : 'Run profile experiment'}
          </Button>
          {simulationActive && <span className="text-xs text-amber-300">Stop Simulation to run experiments.</span>}
        </div>
        {error && <p role="alert" className="whitespace-pre-wrap break-words text-sm text-rose-300">{error}</p>}
      </div>
      {preview && (
        <section aria-label="Effective profile requests" className="space-y-3 rounded-xl border border-border bg-card p-5">
          <h3 className="font-semibold">Effective request preview</h3>
          <p className="text-xs text-zinc-400">
            Prompt variables are resolved, schemas and model sampling shown, and media bytes redacted.
            For a full pipeline, the Chat preview excludes future Vision observations until Vision executes.
          </p>
          {preview.stages.map((stage) => (
            <div key={stage.role}>
              <p className="text-sm">{stage.role} · {stage.model.kind}:{stage.model.modelId}</p>
              <JsonInspector title={`${stage.role} request`} value={stage.request} />
              <JsonInspector title={`${stage.role} stage model settings`} value={stage.modelSettings} />
            </div>
          ))}
        </section>
      )}
      <section aria-label="Profile stage results" className="space-y-3 rounded-xl border border-border bg-card p-5">
        <h3 className="font-semibold">Experiment comparisons</h3>
        <div className="flex flex-wrap gap-2">
          {history.map((item) => (
            <Button key={item.id} size="sm" variant={item.id === activeResult?.id ? 'secondary' : 'ghost'}
              onClick={() => setSelectedResultId(item.id)}>
              {item.mode} · {new Date(item.startedAt).toLocaleTimeString()} · {item.error ? 'error' : 'accepted'}
            </Button>
          ))}
        </div>
        {!activeResult && <p className="text-sm text-zinc-400">No experiments yet.</p>}
        {activeResult && (
          <div className="space-y-4">
            <p className="text-xs text-zinc-400">
              Profile revision {activeResult.profileRevision} · {activeResult.durationMs} ms
              {activeResult.sourceVisionReference ? ' · reused captured Vision' : ''}
            </p>
            {activeResult.error && <p role="alert" className="text-sm text-rose-300">{activeResult.error}</p>}
            {activeResult.visionReference && (
              <Button variant="secondary" size="sm" onClick={() => {
                setMode('chat');
                setVisionReferenceId(activeResult.visionReference!.id);
                setProfileId(activeResult.profileId);
                setPreview(null);
              }}>Fork Vision into Chat-only test</Button>
            )}
            {activeResult.stages.map((stage, index) => (
              <div key={index} className="space-y-2 border-t border-border pt-3">
                <h4 className="text-sm font-medium">
                  {stage.role} · {stage.model.kind}:{stage.model.modelId} · {stage.status}
                  {stage.usage && ` · ${stage.usage.promptTokens ?? '?'} + ${stage.usage.completionTokens ?? '?'} tokens`}
                </h4>
                {stage.error && <p className="text-sm text-rose-300">{stage.error}</p>}
                <JsonInspector title={`${stage.role} constructed request`} value={stage.constructedRequest} />
                <JsonInspector title={`${stage.role} submitted transport request`} value={stage.submittedRequest} />
                <JsonInspector title={`${stage.role} raw transport`} value={stage.rawResponse} />
                <JsonInspector title={`${stage.role} normalized result`} value={stage.normalized} />
                <JsonInspector title={`${stage.role} parsed result`} value={stage.parsed} />
                <JsonInspector title={`${stage.role} accepted result`} value={stage.accepted} />
              </div>
            ))}
            <JsonInspector title="Combined accepted batch" value={activeResult.accepted} />
            <JsonInspector title="Vision observations" value={activeResult.observations} />
          </div>
        )}
      </section>
    </section>
  );
}
