import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { JsonInspector } from './json-inspector';
import { attemptTimeline, runTimeline } from '../run-timeline';
import type { TraceAttempt, TraceFilter, TraceList } from '../../shared/inference-trace-contract';

const EMPTY: TraceList = { attempts: [], dropped: 0, bytes: 0 };
const DEFAULT_FILTER: TraceFilter = {
  text: '',
  failuresOnly: false,
  source: '',
  chatter: '',
  eventKind: '',
};
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function options(list: TraceList, key: 'sources' | 'chatters' | 'eventKinds'): string[] {
  return [...new Set(list.attempts.flatMap((item) => item[key] ?? []))].sort();
}
function frameList(input: unknown, request: unknown) {
  const frames = record(input)?.frames;
  if (!Array.isArray(frames)) return [];
  const messages = record(request)?.messages;
  const second = Array.isArray(messages) ? messages[1] : null;
  const parts = record(second)?.content;
  const imageUrls = Array.isArray(parts)
    ? parts.flatMap((part) => {
        const value = record(part);
        const url = value?.type === 'image_url' ? record(value.image_url)?.url : null;
        return typeof url === 'string' ? [url] : [];
      })
    : [];
  return frames.flatMap((candidate, index) => {
    const frame = record(candidate);
    if (!frame || typeof frame.sourceId !== 'string' || typeof frame.observedAt !== 'number')
      return [];
    // A positional request fallback is safe only when the submitted image count exactly
    // matches selected frame count. Otherwise a different upload could be mislabeled.
    const fallback = imageUrls.length === frames.length ? imageUrls[index] : null;
    const dataUrl = typeof frame.dataUrl === 'string' ? frame.dataUrl : fallback;
    return [
      {
        sourceId: frame.sourceId,
        observedAt: frame.observedAt,
        mediaTimeMs: typeof frame.mediaTimeMs === 'number' ? frame.mediaTimeMs : null,
        dataUrl:
          typeof dataUrl === 'string' && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(dataUrl)
            ? dataUrl
            : null,
      },
    ];
  });
}
function evidenceWithoutImages(input: unknown): unknown {
  const data = record(input);
  if (!data) return input;
  return {
    ...data,
    frames: Array.isArray(data.frames)
      ? data.frames.map((candidate) => {
          const frame = record(candidate);
          if (!frame) return candidate;
          const { dataUrl, ...metadata } = frame;
          return {
            ...metadata,
            ...(typeof dataUrl === 'string'
              ? { imageBytes: Math.round(dataUrl.length * 0.75) }
              : {}),
          };
        })
      : data.frames,
  };
}
function clockTime(timestamp: number | null): string {
  return timestamp === null ? 'Unknown time' : new Date(timestamp).toISOString();
}
function FilterSelect({
  title,
  value,
  values,
  change,
}: {
  title: string;
  value: string;
  values: readonly string[];
  change(value: string): void;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-zinc-300">
      {title}
      <select
        aria-label={title}
        className="h-8 max-w-44 rounded-md border border-border bg-background px-2"
        value={value}
        onChange={(event) => change(event.target.value)}
      >
        <option value="">All</option>
        {values.map((item) => (
          <option key={item} value={item}>
            {item}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Main process holds sensitive evidence; metadata and matching IDs drive navigation. */
export function InferenceRunInspector({
  focus,
  onViewLogs,
  onOpenCase,
}: {
  focus?: { attemptId: string; nonce: number } | null;
  onViewLogs?: (attemptId: string) => void;
  onOpenCase?: (caseId: string) => void;
}) {
  const [listing, setListing] = useState<TraceList>(EMPTY);
  const [selected, setSelected] = useState<string | null>(focus?.attemptId ?? null);
  const [detail, setDetail] = useState<TraceAttempt | null>(null);
  const [runDetails, setRunDetails] = useState<readonly TraceAttempt[]>([]);
  const [filter, setFilter] = useState<TraceFilter>(DEFAULT_FILTER);
  const [matches, setMatches] = useState<readonly string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<{ attemptId: string; id: string } | null>(null);

  useEffect(() => {
    if (focus?.attemptId) setSelected(focus.attemptId);
  }, [focus]);

  useEffect(() => {
    let live = true;
    const api = window.lonelyChat;
    const unsubscribe = api?.onInferenceTraces((value) => {
      if (live) setListing(value);
    });
    void api
      ?.listInferenceTraces()
      .then((value) => {
        if (live) setListing(value);
      })
      .catch((reason: unknown) => {
        if (live) setError(String(reason));
      });
    return () => {
      live = false;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    let live = true;
    const api = window.lonelyChat;
    if (!api?.searchInferenceTraces) {
      setMatches(null);
      return;
    }
    void api
      .searchInferenceTraces(filter)
      .then((ids) => {
        if (live) setMatches(ids);
      })
      .catch((reason: unknown) => {
        if (live) setError(String(reason));
      });
    return () => {
      live = false;
    };
  }, [filter, listing]);

  useEffect(() => {
    let live = true;
    const api = window.lonelyChat;
    const chosen = listing.attempts.find((item) => item.id === selected);
    if (!selected || !chosen) {
      setDetail(null);
      setRunDetails([]);
      return;
    }
    // Content-bearing sibling records are fetched only after an explicit selection.
    const siblings = listing.attempts.filter((item) => item.runId === chosen.runId);
    void Promise.all(
      siblings.map((item) => api?.getInferenceTrace(item.id) ?? Promise.resolve(null)),
    )
      .then((values) => {
        if (!live) return;
        const retained = values.filter((item): item is TraceAttempt => item !== null);
        setRunDetails(retained);
        setDetail(retained.find((item) => item.id === selected) ?? null);
      })
      .catch((reason: unknown) => {
        if (live) setError(String(reason));
      });
    return () => {
      live = false;
    };
  }, [selected, listing]);

  const rows = useMemo(
    () =>
      listing.attempts.filter((item) => {
        if (filter.failuresOnly && item.stage !== 'failed') return false;
        if (filter.source && !item.sources?.includes(filter.source)) return false;
        if (filter.chatter && !item.chatters?.includes(filter.chatter)) return false;
        if (filter.eventKind && !item.eventKinds?.includes(filter.eventKind)) return false;
        if (matches && !matches.includes(item.id)) return false;
        if (!matches && filter.text) {
          const query = filter.text.trim().toLowerCase();
          if (
            ![
              item.id,
              item.modelId,
              item.error,
              String(item.seed),
              String(item.cycle),
              String(item.attempt),
            ].some((value) => value?.toLowerCase().includes(query))
          )
            return false;
        }
        return true;
      }),
    [listing, filter, matches],
  );
  const current = detail?.id === selected ? detail : null;
  const frames = current ? frameList(current.input, current.request) : [];
  const timeline = current ? attemptTimeline(current) : [];
  const joinedTimeline = useMemo(() => runTimeline(runDetails), [runDetails]);
  const multiStage = runDetails.some(
    (item) => item.role === 'vision' || item.role === 'chat' || item.role === 'memory',
  );

  return (
    <div className="space-y-4">
      <p className="text-xs text-zinc-400">
        Recent attempts are kept in bounded volatile memory. Summary listings contain metadata only;
        private stage details are fetched on selection, with binary media and credentials omitted
        from Split stage evidence. Legacy exact-case capture may include private prompts, images and
        transcripts. Nothing is sent to the overlay; oversized fields may be omitted.
      </p>
      {error && (
        <p role="alert" className="text-sm text-rose-300">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-400">
        <span>
          {listing.attempts.length} attempts · {listing.dropped} evicted ·{' '}
          {(listing.bytes / 1048576).toFixed(1)} MiB
        </span>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={filter.failuresOnly}
            onChange={(event) =>
              setFilter((old) => ({ ...old, failuresOnly: event.target.checked }))
            }
          />
          Failures only
        </label>
        <Input
          className="max-w-60"
          aria-label="Search inference attempts"
          placeholder="Search transcript, event, chat…"
          value={filter.text}
          onChange={(event) =>
            setFilter((old) => ({ ...old, text: event.target.value.slice(0, 200) }))
          }
        />
        <FilterSelect
          title="Speaker or source"
          value={filter.source}
          values={options(listing, 'sources')}
          change={(source) => setFilter((old) => ({ ...old, source }))}
        />
        <FilterSelect
          title="Chatter"
          value={filter.chatter}
          values={options(listing, 'chatters')}
          change={(chatter) => setFilter((old) => ({ ...old, chatter }))}
        />
        <FilterSelect
          title="Event type"
          value={filter.eventKind}
          values={options(listing, 'eventKinds')}
          change={(eventKind) => setFilter((old) => ({ ...old, eventKind }))}
        />
      </div>
      <div className="grid min-h-64 gap-4 lg:grid-cols-[minmax(240px,0.34fr)_minmax(0,1fr)]">
        <div
          className="max-h-[76vh] space-y-1 overflow-auto rounded-lg border border-border p-2"
          aria-label="Inference attempts"
        >
          {rows.length === 0 && (
            <p className="p-3 text-sm text-zinc-400">
              No matching attempts yet. Run a Simulation to capture its inference cycles.
            </p>
          )}
          {rows.map((item) => (
            <Button
              key={item.id}
              type="button"
              variant={selected === item.id ? 'secondary' : 'ghost'}
              className="h-auto w-full justify-start whitespace-normal px-3 py-2 text-left"
              onClick={() => {
                setDetail(null);
                setSelected(item.id);
              }}
            >
              <span className="block w-full text-xs">
                <span className="block font-medium">
                  Run {item.runId} · cycle {item.cycle} · attempt {item.attempt}
                </span>
                <span className="block text-zinc-300">
                  {(item.role ?? 'unified').toUpperCase()} · {item.modelId ?? 'fixture'}
                  {item.profileRevision ? ` · profile r${item.profileRevision}` : ''}
                </span>
                <span className="block text-zinc-400">
                  {clockTime(item.startedAt)} ·{' '}
                  {item.boundary
                    ? `observations ${item.boundary.fromMs}–${item.boundary.throughMs} ms`
                    : 'boundary unavailable'}
                </span>
                <span className={item.stage === 'failed' ? 'text-rose-300' : 'text-zinc-400'}>
                  {item.stage}
                  {item.errorStage ? ` (${item.errorStage})` : ''} · seed {item.seed}
                </span>
                {item.error && (
                  <span className="block break-words text-rose-300">{item.error}</span>
                )}
              </span>
            </Button>
          ))}
        </div>
        <div className="min-w-0 space-y-4">
          {!current && (
            <div className="rounded-lg border border-border p-5 text-sm text-zinc-400">
              {selected && !listing.attempts.some((item) => item.id === selected)
                ? 'This attempt is no longer in the bounded trace.'
                : 'Select an attempt to inspect its frozen inputs and execution stages.'}
            </div>
          )}
          {current && (
            <>
              <div className="rounded-lg border border-border p-4 text-sm">
                <h3 className="font-medium">
                  Run {current.runId} · cycle {current.cycle} · attempt {current.attempt} ·{' '}
                  {(current.role ?? 'unified').toUpperCase()}
                </h3>
                <p className="mt-2 text-xs text-zinc-400">
                  {clockTime(current.startedAt)} · {current.mode} · model{' '}
                  {current.modelId ?? 'fixture'} · seed {current.seed} · roster seed{' '}
                  {current.rosterSeed} ·{' '}
                  {current.durationMs === null
                    ? 'in progress'
                    : `${Math.round(current.durationMs)} ms`}
                </p>
                <p className="mt-2">
                  Stage: <strong>{current.stage}</strong>
                  {current.errorStage ? ` · Failed at ${current.errorStage}` : ''}
                </p>
                {current.error && (
                  <p role="alert" className="mt-2 break-words text-rose-300">
                    {current.error}
                  </p>
                )}
                <p className="mt-2 text-xs text-zinc-400">
                  Profile revision {current.profileRevision ?? 'unknown'} · observed{' '}
                  {clockTime(current.observedAt ?? null)} · result available{' '}
                  {clockTime(current.availableAt ?? null)}
                </p>
                {Boolean(current.dependsOn?.length) && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                    <span className="text-zinc-400">Consumed attempts:</span>
                    {current.dependsOn?.map((id) => (
                      <Button key={id} size="sm" variant="link" onClick={() => setSelected(id)}>
                        {id}
                      </Button>
                    ))}
                  </div>
                )}
                {current.usage && (
                  <p className="mt-2 text-xs text-zinc-400">
                    Tokens: prompt {current.usage.promptTokens ?? '—'}, completion{' '}
                    {current.usage.completionTokens ?? '—'}, total{' '}
                    {current.usage.totalTokens ?? '—'}
                  </p>
                )}
                {current.mode === 'native' && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={
                        saving ||
                        !current.request ||
                        !current.modelId ||
                        (current.role !== undefined && current.role !== 'unified')
                      }
                      onClick={async () => {
                        if (!window.lonelyChat?.saveInferenceCase) return;
                        setSaving(true);
                        setError(null);
                        try {
                          const caseSummary = await window.lonelyChat?.saveInferenceCase(
                            current.id,
                          );
                          setSaved({ attemptId: current.id, id: caseSummary.id });
                        } catch (failure) {
                          setError(failure instanceof Error ? failure.message : String(failure));
                        } finally {
                          setSaving(false);
                        }
                      }}
                    >
                      {saving ? 'Saving case…' : 'Save exact inference case'}
                    </Button>
                    {saved?.attemptId === current.id && (
                      <Button
                        size="sm"
                        variant="link"
                        onClick={() => onOpenCase?.(saved.id)}
                        disabled={!onOpenCase}
                      >
                        Open saved case in Playground
                      </Button>
                    )}
                  </div>
                )}
                {onViewLogs && (
                  <Button
                    size="sm"
                    variant="link"
                    className="mt-2"
                    onClick={() => onViewLogs(current.id)}
                  >
                    Find related errors in Logs
                  </Button>
                )}
              </div>
              {multiStage && (
                <section
                  className="rounded-lg border border-border p-3"
                  aria-label="Multi-stage Run timeline"
                >
                  <h4 className="mb-2 text-sm font-medium">
                    Run {current.runId} · Vision → Chat → presentation
                  </h4>
                  <p className="mb-3 text-xs text-zinc-400">
                    Events are ordered by the Run observation axis (pause-adjusted for recorded
                    playback). Physical request and result-availability times are distinct from the
                    original media observation times. Select any entry to inspect its stage request
                    and response.
                  </p>
                  <ol className="max-h-[36rem] space-y-1 overflow-y-auto">
                    {joinedTimeline.map((item) => (
                      <li key={item.key} className="border-l-2 border-zinc-600 py-2 pl-3 text-xs">
                        <button
                          type="button"
                          className="w-full text-left"
                          onClick={() => item.attemptId && setSelected(item.attemptId)}
                        >
                          <span className="font-mono text-zinc-400">
                            {clockTime(item.timestamp)} · {item.clockDomain ?? 'observation'} clock
                          </span>
                          {item.physicalTimestamp !== undefined &&
                            item.physicalTimestamp !== null &&
                            item.physicalTimestamp !== item.timestamp && (
                              <span className="ml-2 text-zinc-500">
                                Wall: {clockTime(item.physicalTimestamp)}
                              </span>
                            )}
                          <span className="mt-1 block font-medium text-zinc-200">{item.title}</span>
                          <span className="block break-words text-zinc-400">
                            {item.description}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ol>
                </section>
              )}
              <section
                className="rounded-lg border border-border p-3"
                aria-label="Observation and presentation timeline"
              >
                <h4 className="mb-2 text-sm font-medium">Observation → inference → presentation</h4>
                <p className="mb-3 text-xs text-zinc-400">
                  {record(current.scheduled)?.clockDomain === 'pause-adjusted'
                    ? 'Recorded playback uses a pause-adjusted observation and presentation clock. Physical wall times are shown separately when different.'
                    : 'Source timestamps, accepted output and publication share a chronological axis.'}{' '}
                  A pending message has not been displayed; its time is only a planned deadline on
                  that same clock.
                </p>
                {timeline.length === 0 && (
                  <p className="text-xs text-zinc-400">
                    Timeline evidence unavailable for this attempt.
                  </p>
                )}
                <ol className="max-h-[32rem] space-y-1 overflow-y-auto">
                  {timeline.map((item) => (
                    <li
                      key={item.key}
                      className="grid gap-1 border-l-2 border-zinc-600 py-2 pl-3 text-xs sm:grid-cols-[minmax(175px,0.3fr)_minmax(0,1fr)]"
                    >
                      <time
                        className="font-mono text-zinc-400"
                        title={item.timestamp === null ? '' : String(item.timestamp)}
                      >
                        {clockTime(item.timestamp)}
                        {item.physicalTimestamp !== undefined &&
                          item.physicalTimestamp !== null &&
                          item.physicalTimestamp !== item.timestamp && (
                            <span className="block text-zinc-500">
                              Wall: {clockTime(item.physicalTimestamp)}
                            </span>
                          )}
                      </time>
                      <div className="min-w-0">
                        <p
                          className={
                            item.state === 'pending'
                              ? 'text-amber-200'
                              : item.state === 'not-shown'
                                ? 'text-zinc-500'
                                : 'text-zinc-200'
                          }
                        >
                          {item.title}
                        </p>
                        <p className="break-words text-zinc-400">{item.description}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
              <JsonInspector
                title="Observation boundary and selected input IDs / records"
                value={evidenceWithoutImages(current.input)}
              />
              {frames.length > 0 && (
                <section
                  className="rounded-lg border border-border p-3"
                  aria-label="Selected visual frames"
                >
                  <h4 className="mb-3 text-sm font-medium">
                    Selected visual frames ({frames.length})
                  </h4>
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                    {frames.map((frame, index) => (
                      <div key={index} className="min-w-0 text-xs text-zinc-400">
                        {frame.dataUrl ? (
                          <img
                            src={frame.dataUrl}
                            alt={`Selected frame ${index + 1}`}
                            className="w-full rounded object-contain"
                          />
                        ) : (
                          <p className="rounded border border-border p-3">
                            Preview unavailable (image omitted)
                          </p>
                        )}
                        <p className="mt-1 break-all">
                          {frame.sourceId} · {frame.observedAt} ms
                          {frame.mediaTimeMs === null ? '' : ` · media ${frame.mediaTimeMs} ms`}
                        </p>
                      </div>
                    ))}
                  </div>
                </section>
              )}
              <JsonInspector
                title="Frozen run settings and prompt revision"
                value={{
                  settings: current.settings,
                  preset: current.promptPreset,
                  adaptation: current.adaptation,
                }}
              />
              <JsonInspector
                title={
                  current.mode === 'native'
                    ? 'Exact submitted native request'
                    : 'Native request (not applicable to fixture)'
                }
                value={current.request}
              />
              <JsonInspector
                title="Raw native transport response / fixture result"
                value={current.rawResponse}
              />
              {current.transportError !== null && (
                <JsonInspector
                  title="Private transport failure details"
                  value={current.transportError}
                />
              )}
              <JsonInspector
                title="Normalized output (before validation)"
                value={current.normalized}
              />
              <JsonInspector title="Parsed events and messages" value={current.parsed} />
              {current.role === 'vision' && (
                <JsonInspector title="Accepted scene state" value={current.sceneState} />
              )}
              <JsonInspector
                title="Validated events and roster-resolved chat"
                value={current.accepted}
              />
              <JsonInspector title="Final scheduled chat batch" value={current.scheduled} />
              <JsonInspector title="Actual published chat" value={current.presented ?? []} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
