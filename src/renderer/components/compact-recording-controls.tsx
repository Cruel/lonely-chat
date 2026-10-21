import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { JsonInspector } from './json-inspector';
import type {
  CompactAttemptSummary,
  CompactReconstruction,
  CompactRecordingStatus,
  InferenceRecordingMode,
  RecordingPrivacy,
} from '../../shared/compact-recording-contract';

const EMPTY: CompactRecordingStatus = {
  enabled: false,
  mode: 'compact',
  recordingId: null,
  attempts: 0,
  chunks: 0,
  bytes: 0,
  error: null,
};

export function CompactRecordingControls() {
  const [status, setStatus] = useState<CompactRecordingStatus>(EMPTY);
  const [attempts, setAttempts] = useState<CompactAttemptSummary[]>([]);
  const [selected, setSelected] = useState<CompactReconstruction | null>(null);
  const [mode, setMode] = useState<InferenceRecordingMode>('compact');
  const [privacy, setPrivacy] = useState<RecordingPrivacy>({
    retainMedia: false,
    retainContent: false,
  });
  const [savedCase, setSavedCase] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diskMb, setDiskMb] = useState(1024);
  const [memoryMb, setMemoryMb] = useState(64);
  const [ageDays, setAgeDays] = useState(30);
  const limitsLoaded = useRef(false);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const next = await window.lonelyChat!.getCompactRecording();
        if (active) {
          setStatus(next);
          if (next.enabled) {
            setMode(next.mode);
            if (next.privacy) setPrivacy(next.privacy);
          }
          if (next.limits && !limitsLoaded.current) {
            setDiskMb(Math.round(next.limits.diskBytes / 1024 ** 2));
            setMemoryMb(Math.round(next.limits.memoryBytes / 1024 ** 2));
            setAgeDays(next.limits.maxAgeDays ?? 30);
            limitsLoaded.current = true;
          }
        }
      } catch (reason) {
        if (active) setError(String(reason));
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-5 rounded-lg border border-border p-4" aria-label="Inference recording">
      <h3 className="font-medium">Persistent inference recording</h3>
      <p className="mt-2 text-sm text-zinc-400">
        Disabled by default. Each enabled mode stores timestamped stage identities and correlations
        for Unified, Vision, Chat, and memory. Raw media frames and full prompts/results require
        separate explicit permissions below. Compact may reconstruct retained Unified requests using
        today's builder; Exact also preserves the actual submitted request when consent allows it.
        Audio and video files are never copied. Private archives respect the disk and age limits,
        and can contain sensitive material if you opt in.
      </p>
      <label className="mt-3 block text-sm text-zinc-300" htmlFor="recording-mode">
        Capture mode
      </label>
      <select
        id="recording-mode"
        className="mt-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
        value={status.enabled ? status.mode : mode}
        disabled={status.enabled || busy}
        onChange={(event) => setMode(event.target.value as InferenceRecordingMode)}
      >
        <option value="compact">Compact (default)</option>
        <option value="exact">Exact — preserve native requests</option>
      </select>
      <div className="mt-3 space-y-2 text-sm text-zinc-300">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            aria-label="Retain raw sampled image frames"
            checked={privacy.retainMedia}
            disabled={status.enabled || busy}
            onChange={(event) =>
              setPrivacy((current) => ({ ...current, retainMedia: event.target.checked }))
            }
          />
          Retain raw sampled image frames (private JPEGs)
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            aria-label="Retain full prompts and responses"
            checked={privacy.retainContent}
            disabled={status.enabled || busy}
            onChange={(event) =>
              setPrivacy((current) => ({ ...current, retainContent: event.target.checked }))
            }
          />
          Retain full prompts, transcripts, model responses, and message text
        </label>
      </div>
      <p role="status" className="mt-2 break-all text-xs text-zinc-400">
        {status.enabled
          ? `Recording ${status.mode}`
          : status.finalizing
            ? `Finishing ${status.finalizing} captured attempts`
            : 'Not recording'}{' '}
        · {status.attempts} attempts · {status.chunks} chunks ·{' '}
        {(status.bytes / 1024 ** 2).toFixed(2)} MiB this archive
        {status.totalBytes !== undefined
          ? ` · ${(status.totalBytes / 1024 ** 2).toFixed(2)} MiB all recordings`
          : ''}
        {status.limits
          ? ` / ${(status.limits.diskBytes / 1024 ** 2).toFixed(0)} MiB disk limit`
          : ''}
        {status.memoryBytes !== undefined
          ? ` · ${(status.memoryBytes / 1024 ** 2).toFixed(2)} MiB pending memory`
          : ''}
        {status.recordingId ? ` · ${status.recordingId}` : ''}
        {status.partial ? ' · Partial (started mid-session)' : ''}
      </p>
      {status.warning && (
        <p role="alert" className="mt-2 text-sm text-amber-300">
          {status.warning}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="text-xs text-zinc-300">
          Recording disk limit (MiB)
          <input
            type="number"
            min={1}
            max={1048576}
            step={1}
            value={diskMb}
            disabled={busy}
            onChange={(event) => setDiskMb(Number(event.target.value))}
            className="mt-1 block w-32 rounded-md border border-border bg-background px-2 py-1 text-sm"
          />
        </label>
        <label className="text-xs text-zinc-300">
          Pending memory limit (MiB)
          <input
            type="number"
            min={1}
            max={1048576}
            step={1}
            value={memoryMb}
            disabled={busy}
            onChange={(event) => setMemoryMb(Number(event.target.value))}
            className="mt-1 block w-32 rounded-md border border-border bg-background px-2 py-1 text-sm"
          />
        </label>
        <label className="text-xs text-zinc-300">
          Archive maximum age (days)
          <input
            type="number"
            aria-label="Archive maximum age (days)"
            min={1}
            max={3650}
            value={ageDays}
            disabled={busy}
            onChange={(event) => setAgeDays(Number(event.target.value))}
            className="mt-1 block w-32 rounded-md border border-border bg-background px-2 py-1 text-sm"
          />
        </label>
        <Button
          variant="secondary"
          disabled={
            busy ||
            !Number.isSafeInteger(diskMb) ||
            !Number.isSafeInteger(memoryMb) ||
            diskMb < 1 ||
            memoryMb < 1 ||
            !Number.isSafeInteger(ageDays) ||
            ageDays < 1 ||
            ageDays > 3650
          }
          onClick={() =>
            void perform(async () =>
              setStatus(
                await window.lonelyChat!.setCompactRecordingLimits({
                  diskBytes: diskMb * 1024 ** 2,
                  memoryBytes: memoryMb * 1024 ** 2,
                  maxAgeDays: ageDays,
                }),
              ),
            )
          }
        >
          Save limits
        </Button>
      </div>
      <p className="mt-1 text-xs text-zinc-400">
        Disk limits cover all session recording archives; memory limits cover in-flight captures.
        Expired private archives are removed when recordings or evidence are accessed. Saved
        Playground cases are excluded. Hitting a limit stops recording without stopping Simulation
        or deleting existing files.
      </p>
      {status.error && (
        <p role="alert" className="mt-2 text-sm text-amber-300">
          {status.error}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          disabled={busy}
          variant="secondary"
          onClick={() =>
            void perform(async () => {
              setStatus(
                await window.lonelyChat!.configureCompactRecording(!status.enabled, mode, privacy),
              );
              setSelected(null);
              setSavedCase(null);
              setAttempts([]);
            })
          }
        >
          {status.enabled ? 'Stop new recordings' : `Start ${mode} recording`}
        </Button>
        <Button
          disabled={busy}
          variant="secondary"
          onClick={() =>
            void perform(async () => setAttempts(await window.lonelyChat!.listCompactAttempts()))
          }
        >
          List recorded attempts
        </Button>
      </div>
      {attempts.length > 0 && (
        <div className="mt-3 max-h-48 overflow-auto rounded-md border border-border p-2">
          {attempts.map((item) => (
            <button
              type="button"
              key={`${item.recordingId}:${item.id}`}
              disabled={busy}
              className="block w-full rounded p-2 text-left text-xs hover:bg-zinc-800"
              onClick={() =>
                void perform(async () =>
                  setSelected(
                    await window.lonelyChat!.reconstructCompactAttempt(item.id, item.recordingId),
                  ),
                )
              }
            >
              {item.recordingId} / {item.id} · Run {item.runId} · cycle {item.cycle}, attempt{' '}
              {item.attempt} · {item.role ?? 'unified'} · {item.stage} · {item.mode ?? 'compact'} ·
              seed {item.seed}
              {item.profileRevision ? ` · profile r${item.profileRevision}` : ''}
              {item.dependsOn?.length ? ` · ${item.dependsOn.length} input stage(s)` : ''}
              {item.archiveStatus
                ? ` · ${item.archiveStatus === 'incomplete' ? 'Incomplete archive' : 'Complete archive'}`
                : ''}
              {item.partial ? ' · Partial' : ''}
              {item.interrupted ? ' · Interrupted attempt' : ''}
            </button>
          ))}
        </div>
      )}
      {selected && (
        <div className="mt-3 space-y-3">
          <p className="text-xs text-amber-300">{selected.warning}</p>
          <p className="text-xs text-zinc-400">
            Recorded builder: {selected.recordedBuilderVersion} · current builder:{' '}
            {selected.currentBuilderVersion}
          </p>
          <JsonInspector
            title="Stage correlation and timing"
            value={{
              role: selected.attempt.role ?? 'unified',
              profileRevision: selected.attempt.profileRevision ?? null,
              sourceFrameIds: selected.attempt.sourceFrameIds ?? [],
              dependsOn: selected.attempt.dependsOn ?? [],
              observedAt: selected.attempt.observedAt ?? null,
              availableAt: selected.attempt.availableAt ?? null,
            }}
          />
          <JsonInspector title="Selected recorded inputs" value={selected.input} />
          {selected.request !== null && (
            <JsonInspector
              title={
                selected.provenance === 'exact-recorded-request'
                  ? 'Verified original submitted request'
                  : 'Current-builder request'
              }
              value={selected.request}
            />
          )}
          <JsonInspector
            title="Recorded outcome and publication timeline"
            value={selected.outcome ?? null}
          />
          {selected.request !== null &&
            (selected.attempt.role === undefined || selected.attempt.role === 'unified') && (
              <Button
                disabled={busy}
                variant="secondary"
                onClick={() =>
                  void perform(async () => {
                    const saved = await window.lonelyChat!.saveRecordedExactCase(
                      selected.attempt.id,
                      selected.attempt.recordingId,
                    );
                    setSavedCase(saved.id);
                  })
                }
              >
                Save as rerunnable Playground case
              </Button>
            )}
          {savedCase && (
            <p role="status" className="text-sm text-zinc-300">
              Saved case {savedCase}. Open Playground → Saved cases to rerun.
            </p>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-amber-300">
          {error}
        </p>
      )}
    </section>
  );
}
