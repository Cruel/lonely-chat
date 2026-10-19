import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DEFAULT_LOG_RETENTION,
  type LogEntry,
  type LogLevel,
  type LogRetention,
} from '../../shared/log-contract';

const BORDER: Record<LogLevel, string> = {
  debug: 'border-zinc-600',
  info: 'border-sky-500',
  warn: 'border-amber-500',
  error: 'border-rose-500',
};

function Entry({
  entry,
  onOpenAttempt,
}: {
  entry: LogEntry;
  onOpenAttempt?: (id: string) => void;
}) {
  const attemptId =
    typeof entry.context?.attemptId === 'string' && /^attempt-\d+$/.test(entry.context.attemptId)
      ? entry.context.attemptId
      : null;
  return (
    <li className={`min-w-0 border-l-[3px] bg-[#15151c] ${BORDER[entry.level]}`}>
      <details className="group">
        <summary
          className="flex min-w-0 cursor-pointer list-none items-center gap-3 px-3 py-1.5 text-xs [&::-webkit-details-marker]:hidden"
          title={entry.text}
        >
          <time className="shrink-0 font-mono text-zinc-400" dateTime={entry.timestamp}>
            {new Date(entry.timestamp).toLocaleString()}
          </time>
          <span className="w-28 shrink-0 truncate text-zinc-300" title={entry.source}>
            {entry.source}
          </span>
          <span className="min-w-0 flex-1 truncate">{entry.text}</span>
          <span className="shrink-0 text-zinc-500 group-open:rotate-90" aria-label="Expand details">
            ▸
          </span>
        </summary>
        <div className="border-t border-border/50 px-3 py-2 text-xs">
          <p className="mb-2 whitespace-pre-wrap break-words text-zinc-200">{entry.text}</p>
          {entry.error && (
            <>
              <p className="mb-2 break-words text-rose-200">{entry.error.message}</p>
              <pre className="overflow-x-auto whitespace-pre-wrap break-words text-zinc-300">
                {entry.error.stack || JSON.stringify(entry.error, null, 2)}
              </pre>
              {entry.error.cause && (
                <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words text-zinc-300">
                  {JSON.stringify(entry.error.cause, null, 2)}
                </pre>
              )}
            </>
          )}
          {attemptId && onOpenAttempt && (
            <Button size="sm" variant="link" onClick={() => onOpenAttempt(attemptId)}>
              Inspect {attemptId} in Run Inspector
            </Button>
          )}
          {entry.context && (
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words text-zinc-400">
              {JSON.stringify(entry.context, null, 2)}
            </pre>
          )}
        </div>
      </details>
    </li>
  );
}

function searchText(entry: LogEntry): string {
  return [
    entry.text,
    entry.source,
    entry.error?.message,
    entry.error?.stack,
    JSON.stringify(entry.error?.cause ?? ''),
    JSON.stringify(entry.context ?? {}),
  ]
    .join(' ')
    .toLowerCase();
}

/** Dense persisted, desktop-only operational viewer. Filtering never deletes stored entries. */
export function OperationalLogs({
  focus,
  onOpenAttempt,
}: {
  focus?: { source?: string; attemptId?: string; recordedRunId?: string; nonce: number } | null;
  onOpenAttempt?: (id: string) => void;
}) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [retention, setRetention] = useState<LogRetention>(DEFAULT_LOG_RETENTION);
  const [draft, setDraft] = useState<LogRetention>(DEFAULT_LOG_RETENTION);
  const [severity, setSeverity] = useState<LogLevel | 'all'>('all');
  const [source, setSource] = useState('all');
  const [attemptFilter, setAttemptFilter] = useState<string | null>(focus?.attemptId ?? null);
  const [runFilter, setRunFilter] = useState<string | null>(focus?.recordedRunId ?? null);
  const [search, setSearch] = useState('');
  const [following, setFollowing] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    setSource(focus?.source ?? 'all');
    setAttemptFilter(focus?.attemptId ?? null);
    setRunFilter(focus?.recordedRunId ?? null);
  }, [focus]);

  useEffect(() => {
    let live = true;
    const api = window.lonelyChat;
    // Subscribe before history so concurrent entries are not lost or duplicated.
    const stop = api?.onOperationalLog((entry) => {
      if (live)
        setEntries((old) => [...old.filter((item) => item.id !== entry.id), entry].slice(-1000));
    });
    void api
      ?.getOperationalLogs()
      .then((snapshot) => {
        if (!live) return;
        setRetention(snapshot.retention);
        setDraft(snapshot.retention);
        setEntries((current) => {
          const byId = new Map([...snapshot.entries, ...current].map((entry) => [entry.id, entry]));
          return [...byId.values()]
            .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
            .slice(-1000);
        });
      })
      .catch((failure: unknown) => {
        if (live) setError(failure instanceof Error ? failure.message : String(failure));
      });
    return () => {
      live = false;
      stop?.();
    };
  }, []);

  const sources = useMemo(
    () =>
      [
        ...new Set([...entries.map((entry) => entry.source), ...(focus ? [focus.source] : [])]),
      ].sort(),
    [entries, focus],
  );
  const filtered = useMemo(
    () =>
      entries.filter(
        (entry) =>
          (severity === 'all' || entry.level === severity) &&
          (source === 'all' || entry.source === source) &&
          (!attemptFilter || entry.context?.attemptId === attemptFilter) &&
          (!runFilter || entry.context?.recordedRunId === runFilter) &&
          (!search || searchText(entry).includes(search.toLowerCase())),
      ),
    [entries, severity, source, search, attemptFilter, runFilter],
  );

  useEffect(() => {
    if (following && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [filtered, following]);

  const save = async () => {
    if (!window.lonelyChat) return;
    setSaving(true);
    setError(null);
    try {
      const next = await window.lonelyChat.configureOperationalLogs(draft);
      setRetention(next);
      setDraft(next);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  };

  const copy = async () => {
    setError(null);
    setNotice(null);
    try {
      await navigator.clipboard.writeText(
        filtered.map((entry) => JSON.stringify(entry)).join('\n'),
      );
      setNotice(`Copied ${filtered.length} filtered entries.`);
    } catch {
      setError('Unable to copy logs to the clipboard.');
    }
  };

  const exportLogs = async () => {
    if (!window.lonelyChat || saving) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await window.lonelyChat.exportOperationalLogs(
        filtered.map((entry) => entry.id),
      );
      if (saved) setNotice(`Exported ${filtered.length} filtered entries.`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mb-5 rounded-xl border border-border bg-card p-4" aria-label="Operational logs">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h3 className="font-medium">Application events</h3>
        <span className="text-xs text-zinc-400">
          Automatically saved locally · No media or prompts
        </span>
      </div>
      {runFilter && (
        <div className="mb-3 flex items-center gap-3 text-xs">
          <span>Showing media diagnostics for recorded Run {runFilter}</span>
          <Button size="sm" variant="link" onClick={() => setRunFilter(null)}>
            Show all Runs
          </Button>
        </div>
      )}
      {attemptFilter && (
        <div className="mb-3 flex items-center gap-3 text-xs">
          <span>Showing correlated errors for {attemptFilter}</span>
          <Button size="sm" variant="link" onClick={() => setAttemptFilter(null)}>
            Show all logs
          </Button>
        </div>
      )}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label htmlFor="log-search" className="sr-only">
          Search logs
        </label>
        <Input
          id="log-search"
          className="min-w-36 flex-1"
          placeholder="Search events"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <label htmlFor="log-severity" className="sr-only">
          Severity
        </label>
        <Select
          items={[
            { value: 'all', label: 'All levels' },
            { value: 'error', label: 'Errors' },
            { value: 'warn', label: 'Warnings' },
            { value: 'info', label: 'Info' },
            { value: 'debug', label: 'Debug' },
          ]}
          value={severity}
          onValueChange={(value) => setSeverity(value as LogLevel | 'all')}
        >
          <SelectTrigger id="log-severity" className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All levels</SelectItem>
            <SelectItem value="error">Errors</SelectItem>
            <SelectItem value="warn">Warnings</SelectItem>
            <SelectItem value="info">Info</SelectItem>
            <SelectItem value="debug">Debug</SelectItem>
          </SelectContent>
        </Select>
        <label htmlFor="log-source" className="sr-only">
          Source
        </label>
        <Select
          items={[
            { value: 'all', label: 'All sources' },
            ...sources.map((name) => ({ value: name, label: name })),
          ]}
          value={source}
          onValueChange={(value) => setSource(value ?? 'all')}
        >
          <SelectTrigger id="log-source" className="w-40">
            <SelectValue placeholder={source} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All sources</SelectItem>
            {sources.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-zinc-300">
          <input
            aria-label="Follow newest logs"
            type="checkbox"
            checked={following}
            onChange={(event) => setFollowing(event.target.checked)}
          />
          Follow newest
        </label>
        <Button
          variant="secondary"
          size="sm"
          disabled={!filtered.length}
          onClick={() => void copy()}
        >
          Copy filtered
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={!filtered.length || saving}
          onClick={() => void exportLogs()}
        >
          Export filtered…
        </Button>
        <span className="text-xs text-zinc-500">
          {filtered.length} of {entries.length} entries
        </span>
      </div>
      <ul
        ref={listRef}
        aria-label="Event history"
        className="max-h-96 space-y-px overflow-y-auto rounded-md border border-border"
      >
        {filtered.map((entry) => (
          <Entry key={entry.id} entry={entry} onOpenAttempt={onOpenAttempt} />
        ))}
        {filtered.length === 0 && (
          <li className="p-3 text-sm text-zinc-400">No matching application events.</li>
        )}
      </ul>
      <div className="mt-3 flex flex-wrap items-end gap-3 border-t border-border pt-3">
        <label className="text-xs text-zinc-400">
          Retain days
          <Input
            aria-label="Retain days"
            className="mt-1 w-24"
            type="number"
            min="1"
            max="90"
            value={draft.ageDays}
            onChange={(event) =>
              setDraft((old) => ({ ...old, ageDays: Number(event.target.value) }))
            }
          />
        </label>
        <label className="text-xs text-zinc-400">
          Maximum MiB
          <Input
            aria-label="Maximum MiB"
            className="mt-1 w-24"
            type="number"
            min="1"
            max="100"
            value={draft.maxMiB}
            onChange={(event) =>
              setDraft((old) => ({ ...old, maxMiB: Number(event.target.value) }))
            }
          />
        </label>
        <Button
          variant="secondary"
          onClick={() => void save()}
          disabled={
            saving || (draft.ageDays === retention.ageDays && draft.maxMiB === retention.maxMiB)
          }
        >
          {saving ? 'Saving…' : 'Save retention'}
        </Button>
        <span className="text-xs text-zinc-500">Showing up to 1,000 recent entries</span>
      </div>
      {notice && (
        <p role="status" className="mt-2 text-xs text-zinc-300">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-rose-300">
          {error}
        </p>
      )}
    </div>
  );
}
