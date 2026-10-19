import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { JsonInspector } from './json-inspector';
import type {
  CompactAttemptSummary,
  CompactReconstruction,
  CompactRecordingStatus,
} from '../../shared/compact-recording-contract';

const EMPTY: CompactRecordingStatus = {
  enabled: false,
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const next = await window.lonelyChat!.getCompactRecording();
        if (active) setStatus(next);
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
    <section className="mt-5 rounded-lg border border-border p-4" aria-label="Compact recording">
      <h3 className="font-medium">Persistent compact inference recording</h3>
      <p className="mt-2 text-sm text-zinc-400">
        Disabled by default. Opt in to save selected transcripts, events, chat context, actual JPEG
        frames, seeds, settings and attempt results as private compressed chunks on disk. Full
        historical prompts, unsampled video, and raw audio are not recorded. Switching recording off
        stops new captures but completes already started attempts. Existing files remain on disk.
        Ordinary operational logs and temporary Run Inspector history are independent.
      </p>
      <p role="status" className="mt-2 break-all text-xs text-zinc-400">
        {status.enabled ? 'Recording' : 'Not recording'} · {status.attempts} attempts ·{' '}
        {status.chunks} chunks · {status.bytes} bytes
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
              setStatus(await window.lonelyChat!.configureCompactRecording(!status.enabled));
              setSelected(null);
              setAttempts([]);
            })
          }
        >
          {status.enabled ? 'Stop new recordings' : 'Enable compact recording'}
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
              {item.attempt} · {item.stage} · seed {item.seed}
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
            title="Reconstructed input (not the original request)"
            value={selected.input}
          />
          <JsonInspector title="Current-builder request" value={selected.request} />
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
