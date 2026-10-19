import { useEffect, useState } from 'react';
import { Play, RefreshCw, Lock, LockOpen } from 'lucide-react';
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
import {
  DEFAULT_FREEFORM_SAMPLING,
  validateFreeformSchema,
  type FreeformRequest,
  type FreeformResult,
} from '../../shared/playground-contract';
import type { ModelManagerSnapshot } from '../../shared/model-install-contract';
import type { PlaygroundFrame } from '../../shared/playground-media-contract';
import { PlaygroundMediaPicker } from './playground-media-picker';

function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff;
}
type HistoryItem = { readonly id: string; readonly result: FreeformResult };

export function FreeformPlayground({
  simulationActive,
  onViewLogs,
}: {
  readonly simulationActive: boolean;
  readonly onViewLogs?: () => void;
}) {
  const [models, setModels] = useState<ModelManagerSnapshot | null>(null);
  const [modelId, setModelId] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('You are a helpful assistant.');
  const [frames, setFrames] = useState<PlaygroundFrame[]>([]);
  const [userPrompt, setUserPrompt] = useState('');
  const [temperature, setTemperature] = useState(String(DEFAULT_FREEFORM_SAMPLING.temperature));
  const [topP, setTopP] = useState(String(DEFAULT_FREEFORM_SAMPLING.topP));
  const [topK, setTopK] = useState(String(DEFAULT_FREEFORM_SAMPLING.topK));
  const [maxTokens, setMaxTokens] = useState(String(DEFAULT_FREEFORM_SAMPLING.maxTokens));
  const [structured, setStructured] = useState(false);
  const [schemaText, setSchemaText] = useState(
    '{"type":"object","properties":{"answer":{"type":"string"}}}',
  );
  const [seedText, setSeedText] = useState(() => String(randomSeed()));
  const [seedLocked, setSeedLocked] = useState(false);
  const [serverBusy, setServerBusy] = useState(false);
  const [localBusy, setLocalBusy] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [selectedResult, setSelectedResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastFailure, setLastFailure] = useState<{
    request: FreeformRequest;
    startedAt: string;
    durationMs: number;
  } | null>(null);
  const installed =
    models?.installations.filter(
      (entry) => entry.role === 'vision-language' && !entry.projectorOnly,
    ) ?? [];
  const active = models?.active['vision-language'];
  const selectedModelId = installed.some((entry) => entry.id === modelId)
    ? modelId
    : active && installed.some((entry) => entry.id === active)
      ? active
      : (installed[0]?.id ?? '');
  const busy = serverBusy || localBusy;
  const blocked = simulationActive || busy;
  const selected = history.find((item) => item.id === selectedResult) ?? history[0];

  useEffect(() => {
    let live = true;
    const api = window.lonelyChat;
    const stopModels = api?.onModelsChange((snapshot) => {
      if (live) setModels(snapshot);
    });
    let receivedStatusEvent = false;
    const stopPlayground = api?.onPlaygroundStatus((status) => {
      receivedStatusEvent = true;
      if (live) setServerBusy(status.busy);
    });
    void api
      ?.getModelsSnapshot()
      .then((snapshot) => {
        if (live) setModels(snapshot);
      })
      .catch((failure: unknown) => {
        if (live) setError(String(failure));
      });
    void api
      ?.getPlaygroundStatus()
      .then((status) => {
        if (live && !receivedStatusEvent) setServerBusy(status.busy);
      })
      .catch((failure: unknown) => {
        if (live) setError(String(failure));
      });
    return () => {
      live = false;
      stopModels?.();
      stopPlayground?.();
    };
  }, []);

  const submit = async () => {
    if (!window.lonelyChat || blocked) return;
    setLocalBusy(true);
    setError(null);
    const seed = seedLocked ? Number(seedText) : randomSeed();
    if (!seedLocked) setSeedText(String(seed));
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const request: FreeformRequest = {
      modelId: selectedModelId,
      systemPrompt,
      userPrompt,
      temperature: Number(temperature),
      topP: Number(topP),
      topK: Number(topK),
      maxTokens: Number(maxTokens),
      seed,
      ...(frames.length ? { frames } : {}),
    };
    try {
      const prepared: FreeformRequest = structured
        ? { ...request, responseSchema: validateFreeformSchema(JSON.parse(schemaText)) }
        : request;
      const result = await window.lonelyChat.runFreeform(prepared);
      setLastFailure(null);
      const id = crypto.randomUUID();
      setHistory((previous) => [{ id, result }, ...previous].slice(0, 10));
      setSelectedResult(id);
    } catch (failure) {
      setLastFailure({ request, startedAt, durationMs: Math.round(performance.now() - started) });
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setLocalBusy(false);
    }
  };

  return (
    <section aria-label="Playground" className="space-y-5">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Playground</h2>
        <p className="mt-1 text-sm text-zinc-400">
          Real local llama.cpp text completions, independent of Simulation and chat. Requests and
          responses remain in this window only.
        </p>
      </div>
      <div className="rounded-xl border border-border bg-card p-5">
        <h3 className="mb-4 font-medium">Freeform request</h3>
        <Label htmlFor="playground-model">Installed model</Label>
        <Select
          items={installed.map((entry) => ({
            value: entry.id,
            label: `${entry.repo} · ${entry.candidateId}`,
          }))}
          value={selectedModelId}
          onValueChange={(value) => setModelId(value ?? '')}
        >
          <SelectTrigger
            id="playground-model"
            className="mt-2 w-full"
            disabled={installed.length === 0}
          >
            <SelectValue placeholder="Install a vision/language GGUF model first" />
          </SelectTrigger>
          <SelectContent>
            {installed.map((entry) => (
              <SelectItem key={entry.id} value={entry.id}>
                {entry.repo} · {entry.candidateId}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Label htmlFor="playground-system" className="mt-4">
          System prompt
        </Label>
        <Textarea
          id="playground-system"
          className="mt-2 min-h-20"
          maxLength={8000}
          value={systemPrompt}
          onChange={(event) => setSystemPrompt(event.target.value)}
        />
        <Label htmlFor="playground-user" className="mt-4">
          User prompt
        </Label>
        <Textarea
          id="playground-user"
          className="mt-2 min-h-32"
          maxLength={16000}
          value={userPrompt}
          placeholder="Ask the installed model something…"
          onChange={(event) => setUserPrompt(event.target.value)}
        />
        <div className="mt-5">
          <PlaygroundMediaPicker frames={frames} onChange={setFrames} />
        </div>
        <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {(
            [
              ['Temperature', temperature, setTemperature, 0, 2, 0.05],
              ['Top P', topP, setTopP, 0, 1, 0.05],
              ['Top K', topK, setTopK, 1, 200, 1],
              ['Maximum tokens', maxTokens, setMaxTokens, 1, 8192, 1],
            ] as const
          ).map(([label, value, setter, min, max, step]) => (
            <label key={label} className="text-xs text-zinc-400">
              {label}
              <Input
                className="mt-2"
                aria-label={label}
                type="number"
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={(event) => setter(event.target.value)}
              />
            </label>
          ))}
        </div>
        <div className="mt-5 flex flex-wrap items-end gap-2">
          <label className="min-w-36 flex-1 text-xs text-zinc-400">
            Seed (0–2,147,483,647)
            <Input
              className="mt-2"
              aria-label="Seed"
              type="number"
              min={0}
              max={2147483647}
              step={1}
              value={seedText}
              onChange={(event) => {
                setSeedText(event.target.value);
                setSeedLocked(true);
              }}
            />
          </label>
          <Button
            variant="secondary"
            onClick={() => {
              setSeedText(String(randomSeed()));
              setSeedLocked(true);
            }}
          >
            Generate seed
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setSeedText(String(randomSeed()));
            }}
          >
            <RefreshCw size={15} /> Regenerate
          </Button>
          <Button
            variant="secondary"
            aria-pressed={seedLocked}
            onClick={() => setSeedLocked(!seedLocked)}
          >
            {seedLocked ? <Lock size={15} /> : <LockOpen size={15} />}
            {seedLocked ? 'Locked' : 'Unlocked'}
          </Button>
        </div>
        <p className="mt-2 text-xs text-zinc-400">
          {seedLocked
            ? 'Every request uses this exact seed.'
            : 'A new seed is generated for each request unless locked.'}
        </p>
        <div className="mt-5 space-y-3">
          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <input
              type="checkbox"
              checked={structured}
              onChange={(event) => setStructured(event.target.checked)}
            />
            Constrain response to a JSON schema
          </label>
          {structured && (
            <div>
              <Label htmlFor="freeform-response-schema">Response JSON schema</Label>
              <Textarea
                id="freeform-response-schema"
                className="mt-2 min-h-28 font-mono"
                value={schemaText}
                onChange={(event) => setSchemaText(event.target.value)}
              />
            </div>
          )}
        </div>
        <div className="mt-5 flex items-center gap-3">
          <Button
            onClick={() => void submit()}
            disabled={blocked || !selectedModelId || !userPrompt.trim()}
          >
            <Play size={15} /> {busy ? 'Running inference…' : 'Run freeform'}
          </Button>
          {simulationActive && (
            <span role="status" className="text-sm text-amber-300">
              Stop Simulation to run Playground.
            </span>
          )}
        </div>
        {installed.length === 0 && (
          <p className="mt-3 text-sm text-amber-300">
            Install a GGUF language model under Models first.
          </p>
        )}
        {error && (
          <p role="alert" className="mt-3 whitespace-pre-wrap break-words text-sm text-rose-300">
            {error}
          </p>
        )}
        {error && onViewLogs && (
          <Button variant="link" size="sm" onClick={onViewLogs}>
            View inference errors in Logs
          </Button>
        )}
        {error && lastFailure && (
          <details className="mt-3 text-xs text-zinc-300">
            <summary className="cursor-pointer">
              Failed request at {new Date(lastFailure.startedAt).toLocaleTimeString()} ·{' '}
              {lastFailure.durationMs} ms · Seed {lastFailure.request.seed}
            </summary>
            <p className="mt-2 font-medium">Submitted system prompt</p>
            <pre className="mt-1 whitespace-pre-wrap break-words">
              {lastFailure.request.systemPrompt || '(none)'}
            </pre>
            <p className="mt-2 font-medium">Submitted user prompt</p>
            <pre className="mt-1 whitespace-pre-wrap break-words">
              {lastFailure.request.userPrompt}
            </pre>
          </details>
        )}
      </div>
      <div className="rounded-xl border border-border bg-card p-5" aria-label="Playground results">
        <h3 className="mb-3 font-medium">Results</h3>
        {history.length > 0 && (
          <div className="mb-4 flex flex-wrap gap-2">
            {history.map((item) => (
              <Button
                key={item.id}
                variant={item.id === selected?.id ? 'secondary' : 'ghost'}
                onClick={() => setSelectedResult(item.id)}
              >
                {new Date(item.result.startedAt).toLocaleTimeString()} · {item.result.effectiveSeed}
              </Button>
            ))}
          </div>
        )}
        {!selected ? (
          <p className="text-sm text-zinc-400">No completions yet.</p>
        ) : (
          <div className="space-y-4 text-sm">
            <p className="text-xs text-zinc-400">
              {selected.result.modelId} · {selected.result.durationMs} ms · Seed{' '}
              {selected.result.effectiveSeed} · Finish: {selected.result.finishReason ?? 'unknown'}
              {selected.result.usage &&
                ` · Tokens: ${selected.result.usage.promptTokens ?? '?'} prompt /
                ${selected.result.usage.completionTokens ?? '?'} completion /
                ${selected.result.usage.totalTokens ?? '?'} total`}
            </p>
            <div>
              <h4 className="mb-1 text-xs font-medium text-zinc-400">Submitted system prompt</h4>
              <pre className="whitespace-pre-wrap break-words rounded-md bg-background p-3">
                {selected.result.request.systemPrompt || '(none)'}
              </pre>
            </div>
            <div>
              <h4 className="mb-1 text-xs font-medium text-zinc-400">Submitted user prompt</h4>
              <pre className="whitespace-pre-wrap break-words rounded-md bg-background p-3">
                {selected.result.request.userPrompt}
              </pre>
            </div>
            {!!selected.result.request.frames?.length && (
              <div className="space-y-2">
                <h4 className="text-xs font-medium text-zinc-400">
                  Submitted media (in request order)
                </h4>
                {selected.result.request.frames.map((frame, index) => (
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
            <div>
              <h4 className="mb-1 text-xs font-medium text-zinc-400">Model response</h4>
              <pre className="whitespace-pre-wrap break-words rounded-md bg-background p-3">
                {selected.result.content}
              </pre>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
