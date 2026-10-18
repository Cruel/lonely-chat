import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { JsonInspector } from './json-inspector';
import type { TraceAttempt, TraceList } from '../../shared/inference-trace-contract';

const EMPTY: TraceList = { attempts: [], dropped: 0, bytes: 0 };

function frameList(input: unknown, request: unknown) {
  if (!input || typeof input !== 'object' || !('frames' in input)) return [];
  const frames = input.frames;
  if (!Array.isArray(frames)) return [];
  const messages =
    request && typeof request === 'object' && 'messages' in request ? request.messages : null;
  const second = Array.isArray(messages) ? messages[1] : null;
  const parts = second && typeof second === 'object' && 'content' in second ? second.content : null;
  const imageUrls = Array.isArray(parts)
    ? parts.flatMap((part) => {
        const url =
          part &&
          typeof part === 'object' &&
          part.type === 'image_url' &&
          part.image_url &&
          typeof part.image_url === 'object'
            ? part.image_url.url
            : null;
        return typeof url === 'string' ? [url] : [];
      })
    : [];
  return frames.flatMap((frame, index) => {
    if (
      !frame ||
      typeof frame !== 'object' ||
      typeof frame.sourceId !== 'string' ||
      typeof frame.observedAt !== 'number'
    )
      return [];
    const dataUrl = typeof frame.dataUrl === 'string' ? frame.dataUrl : imageUrls[index];
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/jpeg;base64,')) return [];
    return [
      {
        sourceId: frame.sourceId,
        observedAt: frame.observedAt,
        mediaTimeMs: typeof frame.mediaTimeMs === 'number' ? frame.mediaTimeMs : undefined,
        dataUrl,
      },
    ];
  });
}

/** Fetches sensitive content only when the private desktop inspector is mounted and an entry is selected. */
export function InferenceRunInspector() {
  const [listing, setListing] = useState<TraceList>(EMPTY);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<TraceAttempt | null>(null);
  const [revision, setRevision] = useState(0);
  const [filter, setFilter] = useState('');
  const [failuresOnly, setFailuresOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const unsubscribe = window.lonelyChat?.onInferenceTraces((value) => {
      if (!live) return;
      setListing(value);
      setRevision((v) => v + 1);
    });
    void window.lonelyChat
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
    if (!selected || !listing.attempts.some((item) => item.id === selected)) {
      setDetail(null);
      return;
    }
    void window.lonelyChat
      ?.getInferenceTrace(selected)
      .then((value) => {
        if (live) setDetail(value);
      })
      .catch((reason: unknown) => {
        if (live) setError(String(reason));
      });
    return () => {
      live = false;
    };
  }, [selected, revision, listing.attempts]);

  const rows = useMemo(
    () =>
      listing.attempts
        .filter((item) => {
          if (failuresOnly && item.stage !== 'failed') return false;
          const query = filter.toLowerCase().trim();
          return (
            !query ||
            [
              item.id,
              item.modelId,
              item.error,
              item.errorStage,
              String(item.seed),
              String(item.cycle),
              String(item.attempt),
            ].some((value) => value?.toLowerCase().includes(query))
          );
        })
        .slice()
        .reverse(),
    [listing, filter, failuresOnly],
  );
  const frames = detail ? frameList(detail.input, detail.request) : [];
  const input =
    detail?.input && typeof detail.input === 'object' && !Array.isArray(detail.input)
      ? (detail.input as Record<string, unknown>)
      : null;
  const inputWithoutImages = input
    ? {
        ...input,
        frames: Array.isArray(input.frames)
          ? input.frames.map((frame: unknown) => {
              if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return frame;
              const { dataUrl, ...metadata } = frame as Record<string, unknown>;
              return {
                ...metadata,
                ...(typeof dataUrl === 'string'
                  ? { imageBytes: Math.round(dataUrl.length * 0.75) }
                  : {}),
              };
            })
          : input.frames,
      }
    : detail?.input;

  return (
    <div className="space-y-4">
      <p className="text-xs text-zinc-400">
        Recent attempts are captured in bounded volatile memory, including sensitive prompts, images
        and transcripts. Nothing here is recorded to disk or published to the overlay. Oversized
        fields are explicitly omitted when they exceed the memory budget.
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
            checked={failuresOnly}
            onChange={(event) => setFailuresOnly(event.target.checked)}
          />
          Failures only
        </label>
        <Input
          className="max-w-56"
          aria-label="Search inference attempts"
          placeholder="Find cycle, seed, error…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      </div>
      <div className="grid min-h-64 gap-4 lg:grid-cols-[minmax(220px,0.32fr)_minmax(0,1fr)]">
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
          {!detail && (
            <div className="rounded-lg border border-border p-5 text-sm text-zinc-400">
              Select an attempt to inspect its frozen inputs and execution stages.
            </div>
          )}
          {detail && (
            <>
              <div className="rounded-lg border border-border p-4 text-sm">
                <h3 className="font-medium">
                  Run {detail.runId} · cycle {detail.cycle} · attempt {detail.attempt}
                </h3>
                <p className="mt-2 text-xs text-zinc-400">
                  {new Date(detail.startedAt).toLocaleString()} · {detail.mode} · model{' '}
                  {detail.modelId ?? 'fixture'} · seed {detail.seed} · roster seed{' '}
                  {detail.rosterSeed} ·
                  {detail.durationMs === null
                    ? ' in progress'
                    : ` ${Math.round(detail.durationMs)} ms`}
                </p>
                <p className="mt-2">
                  Stage: <strong>{detail.stage}</strong>
                  {detail.errorStage ? ` · Failed at ${detail.errorStage}` : ''}
                </p>
                {detail.error && (
                  <p role="alert" className="mt-2 break-words text-rose-300">
                    {detail.error}
                  </p>
                )}
                {detail.usage && (
                  <p className="mt-2 text-xs text-zinc-400">
                    Tokens: prompt {detail.usage.promptTokens ?? '—'}, completion{' '}
                    {detail.usage.completionTokens ?? '—'}, total {detail.usage.totalTokens ?? '—'}
                  </p>
                )}
              </div>
              <JsonInspector
                title="Observation boundary and selected input IDs / records"
                value={inputWithoutImages}
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
                        <img
                          src={frame.dataUrl}
                          alt={`Selected frame ${index + 1}`}
                          className="w-full rounded object-contain"
                        />
                        <p className="mt-1 break-all">
                          {frame.sourceId} · {frame.observedAt} ms
                          {frame.mediaTimeMs === undefined
                            ? ''
                            : ` · media ${frame.mediaTimeMs} ms`}
                        </p>
                      </div>
                    ))}
                  </div>
                </section>
              )}
              <JsonInspector
                title="Frozen run settings and prompt revision"
                value={{
                  settings: detail.settings,
                  preset: detail.promptPreset,
                  adaptation: detail.adaptation,
                }}
              />
              <JsonInspector
                title={
                  detail.mode === 'native'
                    ? 'Exact submitted native request'
                    : 'Native request (not applicable to fixture)'
                }
                value={detail.request}
              />
              <JsonInspector
                title="Raw native transport response / fixture result"
                value={detail.rawResponse}
              />
              {detail.transportError !== null && (
                <JsonInspector
                  title="Private transport failure details"
                  value={detail.transportError}
                />
              )}
              <JsonInspector
                title="Normalized output (before validation)"
                value={detail.normalized}
              />
              <JsonInspector title="Parsed events and messages" value={detail.parsed} />
              <JsonInspector
                title="Validated events and roster-resolved chat"
                value={detail.accepted}
              />
              <JsonInspector title="Final scheduled chat batch" value={detail.scheduled} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
