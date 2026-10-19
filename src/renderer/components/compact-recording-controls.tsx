import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { JsonInspector } from './json-inspector';
import type {
  CompactAttemptSummary,
  CompactReconstruction,
  CompactRecordingStatus,
  InferenceRecordingMode,
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
  const [savedCase, setSavedCase] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const next = await window.lonelyChat!.getCompactRecording();
        if (active) {
          setStatus(next);
          if (next.enabled) setMode(next.mode);
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
        Disabled by default. Both modes save selected transcripts, chat, events, and exact sampled
        JPEG frames in private compressed chunks. Compact rebuilds requests using the current prompt
        builder and cannot preserve old prompts. Exact additionally freezes the constructed native
        request for each attempt, including failures and retries, so old prompts and parameters
        remain rerunnable. Exact uses more storage and may contain sensitive prompts, images, and
        spoken text. Neither mode saves full video or raw audio. Stopping a recording finishes
        captured attempts; existing files remain on disk. Operational logs and temporary Run
        Inspector history remain independent.
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
      <p role="status" className="mt-2 break-all text-xs text-zinc-400">
        {status.enabled ? `Recording ${status.mode}` : 'Not recording'} · {status.attempts} attempts
        · {status.chunks} chunks · {status.bytes} bytes
        {status.recordingId ? ` · ${status.recordingId}` : ''}
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
              setStatus(await window.lonelyChat!.configureCompactRecording(!status.enabled, mode));
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
              {item.attempt} · {item.stage} · {item.mode ?? 'compact'} · seed {item.seed}
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
          <JsonInspector title="Selected recorded inputs" value={selected.input} />
          {selected.request !== null && (
            <JsonInspector
              title={
                selected.provenance === 'exact-recorded-request'
                  ? 'Verified original native request'
                  : 'Current-builder request'
              }
              value={selected.request}
            />
          )}
          {selected.provenance === 'exact-recorded-request' && (
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
              Saved Exact case {savedCase}. Open Playground → Saved cases to rerun.
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
