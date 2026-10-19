import { useEffect, useRef, useState } from 'react';
import type {
  SavedCaseChild,
  SavedCaseDetail,
  SavedCaseSourceResult,
} from '../../shared/saved-case-contract';
import { JsonInspector } from './json-inspector';

type Trial = {
  id: string;
  label: string;
  modelId: string;
  seed: number;
  durationMs: number | null;
  errorStage: string | null;
  error: string | null;
  stage: string;
  frameIndices?: readonly number[];
  request: unknown;
  raw: unknown;
  normalized: unknown;
  parsed: unknown;
  accepted: unknown;
  usage: {
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
  } | null;
  omitted?: string;
  missing?: string;
  missingParsed?: boolean;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requestParts(value: unknown) {
  const request = record(value);
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  const system = record(messages[0]);
  const user = record(messages[1]);
  const content = user?.content;
  const parts = Array.isArray(content) ? content : [];
  const text =
    typeof content === 'string'
      ? content
      : parts
          .filter((item) => record(item)?.type === 'text')
          .map((item) => record(item)?.text)
          .filter((item): item is string => typeof item === 'string')
          .join('\n');
  const images = parts.flatMap((item, index) => {
    if (record(item)?.type !== 'image_url') return [];
    const ref = record(record(item)?.image_url)?.url;
    if (typeof ref !== 'string') return [];
    const preceding = index > 0 ? record(parts[index - 1])?.text : null;
    const match =
      typeof preceding === 'string' ? /^Visual frame (\d+), observedAt=/.exec(preceding) : null;
    return [{ ref, hintedIndex: match ? Number(match[1]) - 1 : null }];
  });
  const refs = images.map((image) => image.ref);
  let structured: unknown = null;
  const first = typeof content === 'string' ? content : record(parts[0])?.text;
  if (typeof first === 'string') {
    try {
      structured = JSON.parse(first) as unknown;
    } catch {
      /* The user prompt is freeform text. */
    }
  }
  return {
    system: typeof system?.content === 'string' ? system.content : null,
    userText: text,
    structured,
    refs,
    imageHints: images.map((image) => image.hintedIndex),
    settings: request
      ? Object.fromEntries(
          Object.entries(request).filter(([key]) => !['messages', 'seed', 'stream'].includes(key)),
        )
      : null,
  };
}

function trialFor(source: SavedCaseDetail, id: string): Trial {
  if (id === 'source') {
    const result: SavedCaseSourceResult | undefined = source.sourceResult;
    return {
      id,
      label: 'Immutable source attempt',
      modelId: source.summary.modelId,
      seed: source.summary.seed,
      durationMs: result?.durationMs ?? null,
      stage: result?.stage ?? 'unavailable',
      errorStage: result?.errorStage ?? null,
      error: result?.error ?? null,
      request: source.request,
      frameIndices: source.frames.map((frame) => frame.index),
      raw: result?.rawNativeOutput ?? null,
      normalized: result?.normalizedResult ?? null,
      parsed: result?.parsedResult ?? null,
      accepted: result?.accepted ?? null,
      usage: result?.usage ?? null,
      omitted: result?.omitted,
      ...(result ? {} : { missing: 'Original outcome was not recorded for this saved case.' }),
    };
  }
  const child: SavedCaseChild | undefined = source.children.find((entry) => entry.id === id);
  if (!child) throw new Error('Unknown saved case comparison trial.');
  const outcome = child.outcome;
  return {
    id,
    label: `Child ${child.id}`,
    modelId: child.modelId,
    seed: child.seed,
    durationMs: child.durationMs,
    stage: child.errorStage ? 'failed' : 'accepted',
    errorStage: child.errorStage,
    error: child.error,
    request: outcome?.submittedRequest ?? null,
    frameIndices: child.frameIndices,
    raw: outcome?.rawNativeOutput ?? null,
    normalized: outcome?.normalizedResult ?? null,
    parsed: outcome?.parsedResult ?? null,
    accepted: outcome?.accepted ?? null,
    usage: outcome?.usage ?? null,
    omitted: outcome?.omitted,
    missingParsed: !!outcome && !Object.hasOwn(outcome, 'parsedResult'),
    ...(outcome ? {} : { missing: 'Child outcome was not persisted.' }),
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const obj = record(value);
  if (obj)
    return `{${Object.keys(obj)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(obj[key])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? String(value);
}

function DetailValue({ value }: { value: unknown }) {
  if (typeof value === 'string')
    return (
      <p className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">
        {value}
      </p>
    );
  if (value === null || value === undefined)
    return <p className="text-xs text-zinc-400">Not present in this request</p>;
  return (
    <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function CompareField({ name, left, right }: { name: string; left: unknown; right: unknown }) {
  const different = stableJson(left) !== stableJson(right);
  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-sm font-medium">{name}</h4>
        <span className={different ? 'text-xs text-amber-300' : 'text-xs text-zinc-400'}>
          {different ? 'Different' : 'Same'}
        </span>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div
          className={
            different ? 'min-w-0 rounded border-l-2 border-amber-400 pl-2' : 'min-w-0 pl-2'
          }
        >
          <DetailValue value={left} />
        </div>
        <div
          className={
            different ? 'min-w-0 rounded border-l-2 border-amber-400 pl-2' : 'min-w-0 pl-2'
          }
        >
          <DetailValue value={right} />
        </div>
      </div>
    </div>
  );
}

function AcceptedChat({ value }: { value: unknown }) {
  const output = record(value);
  const messages = Array.isArray(output?.messages) ? output.messages : null;
  if (!messages)
    return (
      <p className="text-xs text-zinc-400">
        Accepted output unavailable (not validated or not captured).
      </p>
    );
  if (messages.length === 0)
    return <p className="text-xs text-zinc-400">No accepted chat messages.</p>;
  return (
    <div className="space-y-1 rounded border border-border bg-background p-2">
      {messages.map((entry, index) => {
        const message = record(entry);
        return (
          <p key={index} className="break-words text-xs">
            <span
              className="font-medium"
              style={{
                color:
                  typeof message?.color === 'string' && /^#[0-9a-f]{6}$/i.test(message.color)
                    ? message.color
                    : undefined,
              }}
            >
              {typeof message?.author === 'string' ? message.author : 'Unknown chatter'}
            </span>
            : {typeof message?.text === 'string' ? message.text : '(text unavailable)'}
            {typeof message?.offsetMs === 'number' && (
              <span className="ml-2 text-zinc-400">+{message.offsetMs} ms</span>
            )}
          </p>
        );
      })}
    </div>
  );
}

function TrialDetails({
  trial,
  source,
  side,
}: {
  trial: Trial;
  source: SavedCaseDetail;
  side: 'Left' | 'Right';
}) {
  const parts = requestParts(trial.request);
  const accepted = record(trial.accepted);
  return (
    <section
      aria-label={`${side} trial details`}
      className="min-w-0 space-y-3 rounded-lg border border-border p-3"
    >
      <h4 className="text-sm font-medium">
        {side}: {trial.label}
      </h4>
      <p className="text-xs text-zinc-400">
        {trial.modelId} · seed {trial.seed} ·{' '}
        {trial.durationMs === null ? 'Timing unavailable' : `${trial.durationMs} ms`}
        {' · '}
        {trial.stage}
        {trial.errorStage ? ` (${trial.errorStage})` : ''}
      </p>
      {trial.error && (
        <p role="alert" className="break-words text-xs text-rose-300">
          {trial.errorStage ?? 'Error'}: {trial.error}
        </p>
      )}
      {trial.missing && <p className="text-xs text-amber-300">{trial.missing}</p>}
      {trial.omitted && <p className="text-xs text-amber-300">{trial.omitted}</p>}
      {trial.missingParsed && (
        <p className="text-xs text-amber-300">
          Parsed result was not stored by this older child experiment.
        </p>
      )}
      <p className="text-xs text-zinc-400">
        Tokens:{' '}
        {trial.usage
          ? `${trial.usage.promptTokens ?? '?'} prompt / ${trial.usage.completionTokens ?? '?'} completion / ${trial.usage.totalTokens ?? '?'} total`
          : 'not reported'}
      </p>
      <section aria-label={`${side} selected frames`} className="space-y-2">
        <h5 className="text-xs font-medium">Submitted frames ({parts.refs.length})</h5>
        {parts.refs.length === 0 && (
          <p className="text-xs text-zinc-400">No images in this submitted request.</p>
        )}
        <div className="flex flex-wrap gap-2">
          {parts.refs.map((ref, index) => {
            const selectedIndex = trial.frameIndices?.[index] ?? parts.imageHints[index];
            const identified =
              selectedIndex === null || selectedIndex === undefined
                ? null
                : source.frames[selectedIndex];
            const unique = source.frames.filter((item) => item.ref === ref);
            const frame =
              identified?.ref === ref
                ? identified
                : selectedIndex === null || selectedIndex === undefined
                  ? unique.length === 1
                    ? unique[0]
                    : null
                  : null;
            return (
              <div key={index} className="w-32 text-xs text-zinc-400">
                {frame ? (
                  <img
                    src={frame.dataUrl}
                    alt={`${side} selected frame ${index + 1}`}
                    className="h-20 w-full rounded bg-background object-contain"
                  />
                ) : (
                  <p>Frame bytes unavailable</p>
                )}
                <p className="break-words">
                  {frame
                    ? `${frame.sourceId} · ${frame.observedAt} ms${frame.mediaTimeMs === undefined ? '' : ` · media ${frame.mediaTimeMs} ms`}`
                    : `Unresolved frame reference ${index + 1}`}
                </p>
              </div>
            );
          })}
        </div>
      </section>
      <JsonInspector title={`${side} native response (raw)`} value={trial.raw} />
      <JsonInspector title={`${side} normalized response`} value={trial.normalized} />
      <JsonInspector title={`${side} parsed Events and chat batch`} value={trial.parsed} />
      <JsonInspector title={`${side} validated Events`} value={accepted?.events ?? null} />
      <h5 className="text-xs font-medium">Rendered accepted Chat messages</h5>
      <AcceptedChat value={trial.accepted} />
      <JsonInspector title={`${side} validated/accepted output`} value={trial.accepted} />
    </section>
  );
}

function restoredPair(source: SavedCaseDetail): [string, string] {
  const available = new Set(['source', ...source.children.map((child) => child.id)]);
  const fallback: [string, string] = ['source', source.children[0]?.id ?? 'source'];
  try {
    const raw = localStorage.getItem(`lonely-chat:comparison:${source.summary.id}`);
    if (!raw) return fallback;
    const values: unknown = JSON.parse(raw);
    if (
      Array.isArray(values) &&
      values.length === 2 &&
      typeof values[0] === 'string' &&
      typeof values[1] === 'string' &&
      available.has(values[0]) &&
      available.has(values[1])
    )
      return [values[0], values[1]];
  } catch {
    /* Disabled storage or stale settings: fall back to a safe selection. */
  }
  return fallback;
}

/** Read-only human comparison; a trial is never executed or silently reconstructed here. */
export function SavedCaseComparison({ source }: { source: SavedCaseDetail }) {
  const [pair, setPair] = useState<[string, string]>(() => restoredPair(source));
  const previousChildCount = useRef(source.children.length);
  useEffect(() => {
    if (previousChildCount.current === 0 && source.children.length > 0) {
      setPair((current) =>
        current[1] === 'source' ? [current[0], source.children[0].id] : current,
      );
    }
    previousChildCount.current = source.children.length;
  }, [source.children]);
  const options = [
    { id: 'source', label: 'Immutable original attempt' },
    ...source.children.map((child) => ({
      id: child.id,
      label: `Child ${child.createdAt} · seed=${child.seed}, ${child.errorStage ?? 'accepted'}`,
    })),
  ];
  const available = new Set(options.map((option) => option.id));
  const leftId = available.has(pair[0]) ? pair[0] : 'source';
  const rightId = available.has(pair[1]) ? pair[1] : (source.children[0]?.id ?? 'source');
  useEffect(() => {
    try {
      localStorage.setItem(
        `lonely-chat:comparison:${source.summary.id}`,
        JSON.stringify([leftId, rightId]),
      );
    } catch {
      /* Comparisons remain usable without local storage. */
    }
  }, [source.summary.id, leftId, rightId]);
  const left = trialFor(source, leftId);
  const right = trialFor(source, rightId);
  const first = requestParts(left.request);
  const second = requestParts(right.request);
  const selections = (trial: Trial, parts: ReturnType<typeof requestParts>) =>
    parts.refs.map((ref, index) => ({
      ref,
      originalIndex: trial.frameIndices?.[index] ?? parts.imageHints[index] ?? 'unknown',
    }));
  return (
    <section
      aria-label="Compare inference trials"
      className="space-y-3 rounded-lg border border-border bg-card p-4"
    >
      <h3 className="font-medium">Compare inference experiments</h3>
      <p className="text-xs text-zinc-400">
        Compare immutable saved evidence. Differences are descriptive, not model-quality scores. The
        chosen pair is restored when this case is reopened. Missing output is marked explicitly.
      </p>
      {source.children.length === 0 && (
        <p className="text-xs text-zinc-400">
          Run a child experiment to compare its outcome with the saved case.
        </p>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        {(['Left', 'Right'] as const).map((side, index) => (
          <label key={side} className="space-y-1 text-xs">
            <span>{side} trial</span>
            <select
              aria-label={`Compare ${side.toLowerCase()} trial`}
              className="w-full rounded border border-border bg-background px-2 py-2"
              value={index === 0 ? leftId : rightId}
              onChange={(event) =>
                setPair((current) =>
                  index === 0 ? [event.target.value, current[1]] : [current[0], event.target.value],
                )
              }
            >
              {options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <CompareField name="Model identity" left={left.modelId} right={right.modelId} />
      <CompareField name="Effective seed" left={left.seed} right={right.seed} />
      <CompareField name="System prompt" left={first.system} right={second.system} />
      <CompareField
        name="User prompt and labeled input"
        left={first.userText}
        right={second.userText}
      />
      <CompareField
        name="Structured user input"
        left={first.structured}
        right={second.structured}
      />
      <CompareField
        name="Model sampling settings and response schema"
        left={first.settings}
        right={second.settings}
      />
      <CompareField
        name="Selected frame references (submission order)"
        left={selections(left, first)}
        right={selections(right, second)}
      />
      <div className="grid gap-3 md:grid-cols-2">
        <TrialDetails trial={left} source={source} side="Left" />
        <TrialDetails trial={right} source={source} side="Right" />
      </div>
    </section>
  );
}
