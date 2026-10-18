import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { DiagnosticStatus, PrivateWorkerLine } from '../../shared/diagnostic-contract';

export function DiagnosticCaptureControls() {
  const [status, setStatus] = useState<DiagnosticStatus>({
    enabled: false,
    samples: 0,
    workerLines: 0,
    bytes: 0,
    dropped: 0,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<readonly PrivateWorkerLine[]>([]);
  useEffect(() => {
    if (!status.enabled) {
      setLines([]);
      return;
    }
    let active = true;
    const refresh = () => {
      void window.lonelyChat
        ?.getPrivateWorkerLines?.()
        .then((value) => {
          if (active) setLines(value);
        })
        .catch((reason: unknown) => {
          if (active) setError(String(reason));
        });
    };
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [status.enabled]);
  const groups = new Map<string, PrivateWorkerLine[]>();
  for (const line of lines) {
    const group = groups.get(line.worker) ?? [];
    group.push(line);
    groups.set(line.worker, group);
  }
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void window.lonelyChat
        ?.getDiagnosticCapture?.()
        .then((value) => {
          if (active) setStatus(value);
        })
        .catch((reason: unknown) => {
          if (active) setError(String(reason));
        });
    };
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-5 rounded-lg border border-border p-4" aria-label="Diagnostic capture">
      <h3 className="font-medium">Opt-in diagnostic capture</h3>
      <p className="mt-2 text-sm text-zinc-400">
        Off by default. Captures inference samples including private images, transcripts, manual
        context, roster, events and timings in memory (up to 10 samples / 5 MiB). Failed validation
        samples also include the rejected model response. It also records native worker
        stdout/stderr text, which may contain paths, prompts, transcripts and secrets (up to 200
        lines). Normal operational logs never store raw worker output. Export writes a JSON file
        only where you choose. Review it before sharing. Disabling discards all samples; exports are
        not deleted.
      </p>
      <p role="status" className="mt-2 text-xs text-zinc-400">
        {status.enabled ? 'Capturing' : 'Disabled'} · {status.samples} samples ·{' '}
        {status.workerLines} worker lines · {status.bytes} bytes · {status.dropped} dropped
      </p>
      <div className="mt-3 flex gap-3">
        <Button
          disabled={busy}
          variant="secondary"
          onClick={() =>
            void perform(async () => {
              const next = await window.lonelyChat!.configureDiagnosticCapture(!status.enabled);
              setStatus(next);
            })
          }
        >
          {status.enabled ? 'Disable and discard samples' : 'Enable private diagnostic capture'}
        </Button>
        <Button
          disabled={busy || !status.enabled || !(status.samples || status.workerLines)}
          onClick={() => void perform(() => window.lonelyChat!.exportDiagnosticCapture())}
        >
          Export private samples
        </Button>
      </div>
      {status.enabled && (
        <div className="mt-4" aria-label="Private native worker details">
          <h4 className="text-sm font-medium">
            Private worker stdout/stderr (expand for multiline details)
          </h4>
          <p className="mt-1 text-xs text-amber-300">
            Visible only while private capture is enabled. May contain transcripts, paths and
            credentials. Never included in ordinary logs.
          </p>
          {[...groups.entries()].map(([worker, captured]) => (
            <details key={worker} className="mt-2 rounded-md border border-border px-3 py-2">
              <summary className="cursor-pointer break-all text-xs">
                Worker {worker} · {captured.length} lines
              </summary>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">
                {captured.map((entry) => `${entry.stream}: ${entry.line}`).join('\n')}
              </pre>
            </details>
          ))}
          {lines.length === 0 && (
            <p className="mt-2 text-xs text-zinc-400">No private worker text captured yet.</p>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-amber-300">
          {error}
        </p>
      )}
    </section>
  );
}
