import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { JsonInspector } from './json-inspector';
import { SavedCaseComparison } from './saved-case-comparison';
import type {
  SavedCaseDetail,
  SavedCaseSummary,
  SavedCaseForkResult,
} from '../../shared/saved-case-contract';
import type { ModelManagerSnapshot } from '../../shared/model-install-contract';

export function SavedCasePlayground({
  focusId,
  simulationActive,
  busy,
  onViewLogs,
}: {
  focusId?: string | null;
  simulationActive: boolean;
  busy: boolean;
  onViewLogs?: () => void;
}) {
  const [cases, setCases] = useState<SavedCaseSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(focusId ?? null);
  const selectedIdRef = useRef<string | null>(focusId ?? null);
  const chooseCase = (id: string | null) => {
    selectedIdRef.current = id;
    setSelectedId(id);
  };
  const [source, setSource] = useState<SavedCaseDetail | null>(null);
  const [modelId, setModelId] = useState('');
  const [models, setModels] = useState<ModelManagerSnapshot | null>(null);
  const [raw, setRaw] = useState('');
  const [indices, setIndices] = useState<number[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [children, setChildren] = useState<SavedCaseForkResult[]>([]);

  const refresh = async () => {
    const list = await window.lonelyChat?.listSavedCases?.();
    if (list) setCases(list);
  };
  useEffect(() => {
    if (focusId) chooseCase(focusId);
  }, [focusId]);

  useEffect(() => {
    let live = true;
    void window.lonelyChat
      ?.listSavedCases?.()
      .then((value) => {
        if (live && value) setCases(value);
      })
      .catch((reason: unknown) => {
        if (live) setError(String(reason));
      });
    void window.lonelyChat
      ?.getModelsSnapshot?.()
      .then((value) => {
        if (live) setModels(value);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    let live = true;
    setSource(null);
    setError(null);
    setChildren([]);
    if (!selectedId) return;
    void window.lonelyChat
      ?.getSavedCase?.(selectedId)
      .then((value) => {
        if (!live || !value) return;
        setSource(value);
        setModelId(value.summary.modelId);
        setRaw(JSON.stringify(value.request, null, 2));
        setIndices(value.frames.map((frame) => frame.index));
      })
      .catch((reason: unknown) => {
        if (live) setError(String(reason));
      });
    return () => {
      live = false;
    };
  }, [selectedId]);

  const run = async () => {
    if (!source || running || busy || simulationActive || !window.lonelyChat?.runSavedCase) return;
    const originatingCaseId = source.summary.id;
    setRunning(true);
    setError(null);
    try {
      const outcome = await window.lonelyChat?.runSavedCase({
        caseId: originatingCaseId,
        modelId,
        rawRequestJson: raw,
        frameIndices: indices,
      });
      // The user may inspect another saved case while the native call is in flight.
      // Persisted children already belong to originatingCaseId; never attribute
      // their temporary results or counts to whichever case is now displayed.
      setChildren((prev) =>
        selectedIdRef.current === originatingCaseId ? [outcome, ...prev] : prev,
      );
      setSource((prev) =>
        selectedIdRef.current === originatingCaseId && prev?.summary.id === originatingCaseId
          ? {
              ...prev,
              summary: { ...prev.summary, childCount: prev.summary.childCount + 1 },
              children: [outcome.child, ...prev.children],
            }
          : prev,
      );
      await refresh();
    } catch (reason) {
      if (selectedIdRef.current === originatingCaseId)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRunning(false);
    }
  };
  const importCase = async () => {
    try {
      setError(null);
      const saved = await window.lonelyChat?.importSavedCase?.();
      if (saved) {
        await refresh();
        chooseCase(saved.id);
      }
    } catch (reason) {
      setError(String(reason));
    }
  };
  const exportCase = async () => {
    if (!source) return;
    try {
      setError(null);
      await window.lonelyChat?.exportSavedCase?.(source.summary.id);
    } catch (reason) {
      setError(String(reason));
    }
  };
  const selected = source?.summary;
  const installed = models?.installations.filter((item) => item.role === 'vision-language') ?? [];
  return (
    <section
      aria-label="Saved inference cases"
      className="space-y-3 rounded-xl border border-border bg-card p-5"
    >
      <h3 className="font-medium">Saved exact inference cases</h3>
      <p className="text-xs text-zinc-400">
        Explicitly saved, immutable native requests with private JPEG copies. Cases survive
        restarts; editing and running creates a separate child result, never changes the source or
        publishes chat. Exports include prompts, transcripts and frames—review before sharing.
      </p>
      <div className="flex flex-wrap gap-2">
        <select
          aria-label="Choose saved case"
          className="min-w-48 rounded border border-border bg-background px-2 py-1.5 text-xs"
          value={selectedId ?? ''}
          onChange={(event) => chooseCase(event.target.value || null)}
        >
          <option value="">Choose a saved case</option>
          {cases.map((item) => (
            <option key={item.id} value={item.id}>
              Run {item.runId} · cycle {item.cycle} · attempt {item.attempt} · {item.savedAt}
            </option>
          ))}
        </select>
        <Button size="sm" variant="secondary" onClick={() => void importCase()}>
          Import case…
        </Button>
        {source && (
          <Button size="sm" variant="outline" onClick={() => void exportCase()}>
            Export case…
          </Button>
        )}
      </div>
      {selectedId && !source && !error && <p className="text-xs text-zinc-400">Opening case…</p>}
      {source && selected && (
        <div className="space-y-3">
          <p className="text-xs text-zinc-400">
            Saved {selected.savedAt} · source {selected.attemptId} · model {selected.modelId} · seed{' '}
            {selected.seed} · {selected.frameCount} selected frames · {selected.childCount} child
            experiments
          </p>
          <JsonInspector
            title="Immutable original native request (frame references)"
            value={source.request}
          />
          <JsonInspector
            title="Immutable captured input and selection metadata"
            value={source.input}
          />
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <label htmlFor="saved-case-model">Experiment model</label>
            <select
              id="saved-case-model"
              className="rounded border border-border bg-background px-2 py-1.5"
              value={modelId}
              onChange={(event) => setModelId(event.target.value)}
            >
              {!installed.some((item) => item.id === modelId) && (
                <option value={modelId}>{modelId} (not installed)</option>
              )}
              {installed.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.repo} · {item.candidateId}
                </option>
              ))}
            </select>
          </div>
          {source.frames.length > 0 && (
            <div aria-label="Case frame selection" className="space-y-2">
              <h4 className="text-xs font-medium">Included frames (original selection order)</h4>
              <div className="flex flex-wrap gap-3">
                {source.frames.map((frame) => (
                  <label key={frame.index} className="w-36 space-y-1 text-xs">
                    <img
                      src={frame.dataUrl}
                      alt={`Saved frame ${frame.index + 1}`}
                      className="h-20 w-full object-contain"
                    />
                    <span className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={indices.includes(frame.index)}
                        onChange={(event) =>
                          setIndices((prev) =>
                            event.target.checked
                              ? [...prev, frame.index].sort((a, b) => a - b)
                              : prev.filter((item) => item !== frame.index),
                          )
                        }
                      />
                      Frame {frame.index + 1} · {frame.sourceId}
                    </span>
                    <span className="block text-zinc-400">
                      {frame.observedAt} ms
                      {frame.mediaTimeMs === undefined ? '' : ` · media ${frame.mediaTimeMs} ms`}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}
          <label htmlFor="saved-case-raw" className="text-xs font-medium">
            Editable exact request (system/user prompts, sampling, seed, schema)
          </label>
          <Textarea
            id="saved-case-raw"
            aria-label="Saved case request JSON"
            className="min-h-52 font-mono text-xs"
            value={raw}
            onChange={(event) => setRaw(event.target.value)}
          />
          <p className="text-xs text-zinc-400">
            Frame references are placeholders resolved from saved JPEG copies on execution. Change
            included frames above; do not edit their references directly.
          </p>
          <Button
            disabled={running || busy || simulationActive || !modelId}
            onClick={() => void run()}
          >
            {running ? 'Running child experiment…' : 'Run independent child experiment'}
          </Button>
          {simulationActive && (
            <span role="status" className="text-sm text-amber-300">
              Stop Simulation to run Playground.
            </span>
          )}
          <SavedCaseComparison key={selected.id} source={source} />
          {source.children.length > 0 && (
            <div aria-label="Saved child experiments" className="space-y-1 text-xs">
              <h4 className="font-medium">Child experiments (persisted separately)</h4>
              {source.children.map((child) => (
                <details key={child.id} className="rounded border border-border p-2">
                  <summary className="cursor-pointer text-zinc-400">
                    {child.createdAt} · seed {child.seed} · {child.errorStage ?? 'accepted'} ·{' '}
                    {child.durationMs} ms
                  </summary>
                  {child.error && <p className="text-rose-300">{child.error}</p>}
                  {child.outcome && !children.some((entry) => entry.child.id === child.id) && (
                    <div className="mt-2 space-y-2">
                      <JsonInspector
                        title={`Saved child ${child.id} submitted request`}
                        value={child.outcome.submittedRequest}
                      />
                      <JsonInspector
                        title={`Saved child ${child.id} native output`}
                        value={child.outcome.rawNativeOutput}
                      />
                      <JsonInspector
                        title={`Saved child ${child.id} normalized result`}
                        value={child.outcome.normalizedResult}
                      />
                      <JsonInspector
                        title={`Saved child ${child.id} accepted output`}
                        value={child.outcome.accepted}
                      />
                      {child.outcome.omitted && (
                        <p className="text-zinc-400">{child.outcome.omitted}</p>
                      )}
                    </div>
                  )}
                </details>
              ))}
            </div>
          )}
          {children
            .filter(({ child }) => child.parentCaseId === selected.id)
            .map(({ child, result }) => (
              <div key={child.id} className="space-y-2 border-t border-border pt-3">
                <h4 className="text-sm font-medium">
                  Child {child.id} · {result.errorStage ?? 'accepted'}
                </h4>
                {result.error && (
                  <p role="alert" className="text-xs text-rose-300">
                    {result.error}
                  </p>
                )}
                {result.errorStage && onViewLogs && (
                  <Button variant="link" size="sm" onClick={onViewLogs}>
                    View failure in Logs
                  </Button>
                )}
                <JsonInspector
                  title={`Child ${child.id} submitted request`}
                  value={result.submittedRequest}
                />
                <JsonInspector
                  title={`Child ${child.id} native output`}
                  value={result.rawNativeOutput}
                />
                <JsonInspector
                  title={`Child ${child.id} accepted events and chat`}
                  value={result.accepted}
                />
              </div>
            ))}
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-rose-300">
          {error}
        </p>
      )}
    </section>
  );
}
