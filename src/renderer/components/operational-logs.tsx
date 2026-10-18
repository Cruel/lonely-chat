import { useEffect, useState } from 'react';
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

function Entry({ entry }: { entry: LogEntry }) {
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
          {entry.context && (
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-zinc-400">
              {JSON.stringify(entry.context, null, 2)}
            </pre>
          )}
        </div>
      </details>
    </li>
  );
}

export function OperationalLogs() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [retention, setRetention] = useState<LogRetention>(DEFAULT_LOG_RETENTION);
  const [draft, setDraft] = useState<LogRetention>(DEFAULT_LOG_RETENTION);
  const [severity, setSeverity] = useState<LogLevel | 'all'>('all');
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    const api = window.lonelyChat;
    // Subscribe before requesting history, then merge by ID to avoid lost/duplicated events.
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

  const filtered = entries.filter(
    (entry) =>
      (severity === 'all' || entry.level === severity) &&
      (!search ||
        (entry.text + ' ' + entry.source + ' ' + (entry.error?.message ?? ''))
          .toLowerCase()
          .includes(search.toLowerCase())),
  );
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

  return (
    <div className="mb-5 rounded-xl border border-border bg-card p-4" aria-label="Operational logs">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h3 className="font-medium">Application events</h3>
        <span className="text-xs text-zinc-400">
          Automatically saved locally · No media or prompts
        </span>
      </div>
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
      </div>
      <ul
        aria-label="Event history"
        className="max-h-96 space-y-px overflow-y-auto rounded-md border border-border"
      >
        {filtered.map((entry) => (
          <Entry key={entry.id} entry={entry} />
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
      {error && (
        <p role="alert" className="mt-2 text-sm text-rose-300">
          {error}
        </p>
      )}
    </div>
  );
}
