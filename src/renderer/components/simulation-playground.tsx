import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { JsonInspector } from './json-inspector';
import { PlaygroundMediaPicker } from './playground-media-picker';
import { SavedCasePlayground } from './saved-case-playground';
import type { PlaygroundFrame } from '../../shared/playground-media-contract';
import type {
  SimulationExperimentRequest,
  SimulationExperimentResult,
  SimulationExperimentValues,
} from '../../shared/playground-contract';
import type { ModelManagerSnapshot } from '../../shared/model-install-contract';
import type { ChatterIdentity } from '../../shared/audience-contract';
import type { PromptPreset } from '../../shared/prompt-preset-contract';

type Preview = { constructedRequest: unknown; submittedRequest: unknown };
type HistoryItem = { id: string; result: SimulationExperimentResult; sourceRevision: string };
const defaultRoster: ChatterIdentity[] = [
  { author: 'pixelpilot', color: '#bba5ff' },
  { author: 'lunar_fox', color: '#62d9b4' },
  { author: 'nightowl', color: '#ffbb78' },
];

export function SimulationPlayground({
  simulationActive,
  onViewLogs,
  caseFocus,
}: {
  readonly caseFocus?: string | null;
  readonly simulationActive: boolean;
  readonly onViewLogs?: (source: 'ipc' | 'playground') => void;
}) {
  const [models, setModels] = useState<ModelManagerSnapshot | null>(null);
  const [modelId, setModelId] = useState('');
  const [context, setContext] = useState('Playing a game on stream.');
  const [cycle, setCycle] = useState('1');
  const [windowMs, setWindowMs] = useState('3000');
  const [activity, setActivity] = useState<'quiet' | 'normal' | 'busy'>('normal');
  const [roster, setRoster] = useState(JSON.stringify(defaultRoster, null, 2));
  const [frames, setFrames] = useState<PlaygroundFrame[]>([]);
  const [events, setEvents] = useState('[]');
  const [transcripts, setTranscripts] = useState('[]');
  const [observations, setObservations] = useState('[]');
  const [recentChat, setRecentChat] = useState('[]');
  const [useRaw, setUseRaw] = useState(false);
  const [rawJson, setRawJson] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [serverBusy, setServerBusy] = useState(false);
  const [localBusy, setLocalBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorLogSource, setErrorLogSource] = useState<'ipc' | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [presets, setPresets] = useState<PromptPreset[]>([]);
  const [presetId, setPresetId] = useState('');
  const [presetName, setPresetName] = useState('');
  const [loadedRevision, setLoadedRevision] = useState<number | null>(null);
  const [revisions, setRevisions] = useState<PromptPreset[]>([]);

  const installed = models?.installations.filter((entry) => entry.role === 'vision-language') ?? [];
  const active = models?.active['vision-language'];
  const selectedModelId = installed.some((item) => item.id === modelId)
    ? modelId
    : active && installed.some((item) => item.id === active)
      ? active
      : (installed[0]?.id ?? '');
  const busy = serverBusy || localBusy;
  const selected = history.find((item) => item.id === selectedId) ?? history[0];

  useEffect(() => {
    const api = window.lonelyChat;
    let mounted = true;
    let observedStatus = false;
    void api
      ?.listPromptPresets()
      .then((value) => {
        if (mounted) setPresets(value);
      })
      .catch(() => {});
    const stopModels = api?.onModelsChange((value) => {
      if (mounted) setModels(value);
    });
    const stopStatus = api?.onPlaygroundStatus((value) => {
      observedStatus = true;
      if (mounted) setServerBusy(value.busy);
    });
    void api
      ?.getModelsSnapshot()
      .then((value) => {
        if (mounted) setModels(value);
      })
      .catch(() => {});
    void api
      ?.getPlaygroundStatus()
      .then((value) => {
        if (mounted && !observedStatus) setServerBusy(value.busy);
      })
      .catch(() => {});
    void api
      ?.getAudience()
      .then((value) => {
        if (mounted && value.members.length) setRoster(JSON.stringify(value.members, null, 2));
      })
      .catch(() => {});
    return () => {
      mounted = false;
      stopModels?.();
      stopStatus?.();
    };
  }, []);

  function request(): SimulationExperimentRequest {
    const readArray = (label: string, value: string): unknown[] => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        throw new Error(`${label} is not valid JSON.`);
      }
      if (!Array.isArray(parsed)) throw new Error(`${label} must be a JSON array.`);
      return parsed;
    };
    const values: SimulationExperimentValues = {
      context,
      cycle: Number(cycle),
      playbackWindowMs: Number(windowMs),
      chatActivity: activity,
      roster: readArray('Roster', roster) as unknown as ChatterIdentity[],
      events: readArray('Events', events) as unknown as SimulationExperimentValues['events'],
      transcripts: readArray(
        'Transcripts',
        transcripts,
      ) as unknown as SimulationExperimentValues['transcripts'],
      observations: readArray(
        'Observations',
        observations,
      ) as unknown as SimulationExperimentValues['observations'],
      recentChat: readArray(
        'Recent chat',
        recentChat,
      ) as unknown as SimulationExperimentValues['recentChat'],
    };
    return {
      modelId: selectedModelId,
      values,
      ...(frames.length ? { frames } : {}),
      ...(useRaw ? { rawRequestJson: rawJson } : {}),
    };
  }

  function loadPreset(id: string) {
    const preset = presets.find((item) => item.id === id);
    if (!preset) return;
    void window.lonelyChat
      ?.listPromptPresetRevisions(id)
      .then(setRevisions)
      .catch(() => {});
    loadRevision(preset);
  }

  function loadRevision(preset: PromptPreset) {
    setPresetId(preset.id);
    setPresetName(preset.name);
    setLoadedRevision(preset.revision);
    const v = preset.values;
    setContext(v.context);
    setCycle(String(v.cycle));
    setWindowMs(String(v.playbackWindowMs));
    setActivity(v.chatActivity);
    setRoster(JSON.stringify(v.roster, null, 2));
    setEvents(JSON.stringify(v.events, null, 2));
    setTranscripts(JSON.stringify(v.transcripts, null, 2));
    setObservations(JSON.stringify(v.observations, null, 2));
    setRecentChat(JSON.stringify(v.recentChat, null, 2));
    setUseRaw(false);
    setRawJson('');
    setFrames([]);
    setPreview(null);
  }

  async function savePreset() {
    try {
      if (!window.lonelyChat) return;
      const validated = selectedModelId
        ? await window.lonelyChat.previewSimulation({
            ...request(),
            rawRequestJson: undefined,
            frames: undefined,
          })
        : null;
      // Only persist structured values. Selected media and raw overrides are ephemeral.
      const preset = await window.lonelyChat.savePromptPreset({
        ...(presetId ? { id: presetId } : {}),
        name: presetName,
        values: request().values,
      });
      setPresets(await window.lonelyChat.listPromptPresets());
      setRevisions(await window.lonelyChat.listPromptPresetRevisions(preset.id));
      setPresetId(preset.id);
      setLoadedRevision(preset.revision);
      setPreview(validated);
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }

  async function deletePreset() {
    if (!presetId || !window.lonelyChat) return;
    try {
      await window.lonelyChat.deletePromptPreset(presetId);
      setPresets(await window.lonelyChat.listPromptPresets());
      setRevisions([]);
      setPresetId('');
      setLoadedRevision(null);
      setPresetName('');
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }

  const construct = async () => {
    if (!window.lonelyChat) return;
    setError(null);
    setErrorLogSource(null);
    let submittedToMain = false;
    try {
      const payload = { ...request(), rawRequestJson: undefined };
      submittedToMain = true;
      const result = await window.lonelyChat.previewSimulation(payload);
      setPreview(result);
      if (useRaw) setRawJson(JSON.stringify(result.constructedRequest, null, 2));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setErrorLogSource(submittedToMain ? 'ipc' : null);
    }
  };
  const run = async () => {
    if (!window.lonelyChat || busy || simulationActive) return;
    setLocalBusy(true);
    setError(null);
    setErrorLogSource(null);
    let submittedToMain = false;
    try {
      const payload = request();
      submittedToMain = true;
      const result = await window.lonelyChat.runSimulationExperiment(payload);
      const id = crypto.randomUUID();
      const sourceRevision =
        presetId && loadedRevision
          ? `${presetName} · based on revision ${loadedRevision} (independent draft)`
          : 'Independent draft (no saved revision)';
      setHistory((prior) => [{ id, result, sourceRevision }, ...prior].slice(0, 10));
      setSelectedId(id);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setErrorLogSource(submittedToMain ? 'ipc' : null);
    } finally {
      setLocalBusy(false);
    }
  };

  return (
    <section aria-label="Simulation Playground" className="space-y-5">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Simulation Playground</h2>
        <p className="mt-1 text-sm text-zinc-400">
          Run one real structured inference using the same prompt construction, bounded history,
          validation and chatter-author resolution as continuous Simulation. Nothing is published to
          chat.
        </p>
      </div>
      <SavedCasePlayground
        focusId={caseFocus}
        busy={busy}
        simulationActive={simulationActive}
        onViewLogs={onViewLogs ? () => onViewLogs('playground') : undefined}
      />
      <div className="space-y-4 rounded-xl border border-border bg-card p-5">
        <Label htmlFor="simulation-preset">Named prompt preset</Label>
        <Select
          value={presetId || '__new'}
          onValueChange={(value) => {
            if (value === '__new') {
              setPresetId('');
              setPresetName('');
              setLoadedRevision(null);
              setRevisions([]);
            } else if (value) loadPreset(value);
          }}
          items={[
            { value: '__new', label: 'New preset / independent experiment' },
            ...presets.map((p) => ({ value: p.id, label: `${p.name} · revision ${p.revision}` })),
          ]}
        >
          <SelectTrigger id="simulation-preset" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__new">New preset / independent experiment</SelectItem>
            {presets.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name} · revision {p.revision}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {presetId && revisions.length > 0 && (
          <>
            <Label htmlFor="playground-preset-revision">Load revision</Label>
            <Select
              value={String(loadedRevision ?? '')}
              onValueChange={(value) => {
                const revision = revisions.find((item) => String(item.revision) === value);
                if (revision) loadRevision(revision);
              }}
              items={revisions.map((item) => ({
                value: String(item.revision),
                label: `Revision ${item.revision}`,
              }))}
            >
              <SelectTrigger id="playground-preset-revision" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {revisions.map((item) => (
                  <SelectItem key={item.revision} value={String(item.revision)}>
                    Revision {item.revision}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        )}
        <Label htmlFor="preset-name">Preset name</Label>
        <Input
          id="preset-name"
          maxLength={80}
          value={presetName}
          onChange={(event) => setPresetName(event.target.value)}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            onClick={() => void savePreset()}
            disabled={!presetName.trim()}
          >
            {' '}
            {presetId ? 'Save new revision' : 'Create preset'}{' '}
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setPresetId('');
              setLoadedRevision(null);
              setRevisions([]);
              setPresetName(presetName ? presetName + ' copy' : '');
            }}
          >
            Branch as new preset
          </Button>
          {presetId && (
            <Button variant="outline" onClick={() => void deletePreset()}>
              Delete preset
            </Button>
          )}
        </div>
        <p className="text-xs text-zinc-400">
          {loadedRevision
            ? `Loaded revision ${loadedRevision}. Edits are independent until saved; experiments never update the preset.`
            : 'Unsaved independent experiment.'}
        </p>
        <Label htmlFor="simulation-model">Installed model</Label>
        <Select
          items={installed.map((item) => ({
            value: item.id,
            label: `${item.repo} · ${item.candidateId}`,
          }))}
          value={selectedModelId}
          onValueChange={(value) => setModelId(value ?? '')}
        >
          <SelectTrigger id="simulation-model" className="w-full" disabled={!installed.length}>
            <SelectValue placeholder="Install a language GGUF model first" />
          </SelectTrigger>
          <SelectContent>
            {installed.map((item) => (
              <SelectItem value={item.id} key={item.id}>
                {item.repo} · {item.candidateId}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Label htmlFor="simulation-context">Stream context</Label>
        <Textarea
          id="simulation-context"
          value={context}
          maxLength={2000}
          onChange={(event) => setContext(event.target.value)}
        />
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="text-xs text-zinc-400">
            Cycle
            <Input
              aria-label="Cycle"
              type="number"
              min={1}
              max={1000000}
              value={cycle}
              onChange={(event) => setCycle(event.target.value)}
            />
          </label>
          <label className="text-xs text-zinc-400">
            Playback window (ms)
            <Input
              aria-label="Playback window"
              type="number"
              min={500}
              max={60000}
              value={windowMs}
              onChange={(event) => setWindowMs(event.target.value)}
            />
          </label>
          <div>
            <Label htmlFor="simulation-activity">Chat activity</Label>
            <Select
              items={['quiet', 'normal', 'busy'].map((value) => ({ value, label: value }))}
              value={activity}
              onValueChange={(value) => {
                if (value === 'quiet' || value === 'normal' || value === 'busy') setActivity(value);
              }}
            >
              <SelectTrigger id="simulation-activity" className="mt-1 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(['quiet', 'normal', 'busy'] as const).map((value) => (
                  <SelectItem key={value} value={value}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <PlaygroundMediaPicker frames={frames} onChange={setFrames} />
        <p className="text-xs text-zinc-400">
          Provide JSON arrays for the roster and optional historical inputs. Each history item uses
          ageMs (milliseconds before this request). Only the bounded production history reaches the
          model.
        </p>
        {(
          [
            ['Chatter roster', roster, setRoster, '[{"author":"viewer","color":"#aabbcc"}]'],
            [
              'Previous events',
              events,
              setEvents,
              '[{"kind":"context","summary":"A match started","ageMs":1000}]',
            ],
            [
              'Source-labeled transcripts',
              transcripts,
              setTranscripts,
              '[{"source":"microphone","text":"Hello","ageMs":1000}]',
            ],
            [
              'Observations',
              observations,
              setObservations,
              '[{"source":"game","kind":"visual","description":"Menu opened","ageMs":1000}]',
            ],
            [
              'Recent displayed chat',
              recentChat,
              setRecentChat,
              '[{"author":"viewer","text":"Hi","ageMs":1000}]',
            ],
          ] as const
        ).map(([name, value, setValue, example]) => (
          <div key={name}>
            <Label htmlFor={name}>{name}</Label>
            <Textarea
              id={name}
              className="mt-1 min-h-16 font-mono"
              value={value}
              placeholder={example}
              onChange={(event) => setValue(event.target.value)}
            />
          </div>
        ))}
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => void construct()} disabled={!selectedModelId}>
            Construct request
          </Button>
          <Button
            variant="outline"
            aria-pressed={useRaw}
            onClick={() => {
              if (!useRaw && preview)
                setRawJson(JSON.stringify(preview.constructedRequest, null, 2));
              setUseRaw(!useRaw);
            }}
          >
            {useRaw ? 'Disable advanced raw JSON' : 'Edit advanced raw JSON'}
          </Button>
        </div>
        {preview && (
          <JsonInspector title="Constructed request preview" value={preview.constructedRequest} />
        )}
        {useRaw && (
          <div>
            <Label htmlFor="simulation-raw">
              Advanced raw transport request (validated before submission)
            </Label>
            <Textarea
              id="simulation-raw"
              className="mt-2 min-h-52 font-mono"
              value={rawJson}
              onChange={(event) => setRawJson(event.target.value)}
              placeholder="Use Construct request to populate the JSON editor."
            />
            <p className="mt-2 text-xs text-zinc-400">
              Only the request body changes. The production response parser and validator remain
              mandatory.
            </p>
          </div>
        )}
        <div className="flex items-center gap-3">
          <Button
            disabled={busy || simulationActive || !selectedModelId}
            onClick={() => void run()}
          >
            {busy ? 'Running inference…' : 'Run simulation one-shot'}
          </Button>
          {simulationActive && (
            <span role="status" className="text-sm text-amber-300">
              Stop Simulation to run Playground.
            </span>
          )}
        </div>
        {error && (
          <p role="alert" className="whitespace-pre-wrap break-words text-sm text-rose-300">
            {error}
          </p>
        )}
        {error && errorLogSource && onViewLogs && (
          <Button variant="link" onClick={() => onViewLogs(errorLogSource)}>
            View request error in Logs
          </Button>
        )}
      </div>
      <div
        aria-label="Simulation Playground results"
        className="space-y-4 rounded-xl border border-border bg-card p-5"
      >
        <h3 className="font-medium">One-shot results</h3>
        {history.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {history.map((item) => (
              <Button
                key={item.id}
                variant={selected?.id === item.id ? 'secondary' : 'ghost'}
                onClick={() => setSelectedId(item.id)}
              >
                {new Date(item.result.startedAt).toLocaleTimeString()} ·{' '}
                {item.result.errorStage ?? 'accepted'}
              </Button>
            ))}
          </div>
        )}
        {!selected ? (
          <p className="text-sm text-zinc-400">No simulation experiments yet.</p>
        ) : (
          <div className="space-y-4">
            <p className="text-xs text-zinc-400">{selected.sourceRevision}</p>
            <p className="text-xs text-zinc-400">
              {selected.result.modelId} · {selected.result.durationMs} ms ·{' '}
              {selected.result.errorStage ?? 'Validated'}
              {selected.result.usage &&
                ` · Tokens: ${selected.result.usage.promptTokens ?? '?'} prompt / ${selected.result.usage.completionTokens ?? '?'} completion`}
            </p>
            {selected.result.error && (
              <p role="alert" className="text-sm text-rose-300">
                {selected.result.errorStage}: {selected.result.error}
              </p>
            )}
            {selected.result.errorStage && onViewLogs && (
              <Button variant="link" onClick={() => onViewLogs('playground')}>
                View experiment failure in Logs
              </Button>
            )}
            {!!selected.result.submittedFrames?.length && (
              <div aria-label="Submitted media" className="space-y-2">
                <h4 className="text-xs font-medium">Submitted frames (request order)</h4>
                {selected.result.submittedFrames.map((frame, index) => (
                  <div key={index} className="flex items-center gap-2 text-xs">
                    <img
                      src={frame.dataUrl}
                      className="h-20 w-24 bg-black object-contain"
                      alt={`Submitted frame ${index + 1}`}
                    />
                    <span>
                      {index + 1}. {frame.sourceId}
                      {frame.mediaTimeMs === undefined
                        ? ''
                        : ` · ${(frame.mediaTimeMs / 1000).toFixed(3)} s`}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <JsonInspector title="Constructed request" value={selected.result.constructedRequest} />
            <JsonInspector title="Submitted request" value={selected.result.submittedRequest} />
            <JsonInspector
              title="Response schema"
              value={
                (selected.result.submittedRequest as { response_format?: { schema?: unknown } })
                  .response_format?.schema ?? null
              }
            />
            <JsonInspector title="Raw native output" value={selected.result.rawNativeOutput} />
            <JsonInspector title="Normalized result" value={selected.result.normalizedResult} />
            <JsonInspector title="Accepted events and chat" value={selected.result.accepted} />
            <JsonInspector
              title="Validation and error metadata"
              value={{
                stage: selected.result.errorStage,
                error: selected.result.error,
                startedAt: selected.result.startedAt,
                durationMs: selected.result.durationMs,
                modelId: selected.result.modelId,
                usage: selected.result.usage,
              }}
            />
          </div>
        )}
      </div>
    </section>
  );
}
