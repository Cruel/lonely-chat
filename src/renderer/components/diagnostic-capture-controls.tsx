import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { DiagnosticStatus } from '../../shared/diagnostic-contract';

export function DiagnosticCaptureControls() {
  const [status, setStatus] = useState<DiagnosticStatus>({
    enabled: false,
    samples: 0,
    bytes: 0,
    dropped: 0,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
        context, roster, events and timings in memory (up to 10 samples / 5 MiB). Export writes a
        JSON file only where you choose. Review it before sharing. Disabling discards all samples;
        exports are not deleted.
      </p>
      <p role="status" className="mt-2 text-xs text-zinc-400">
        {status.enabled ? 'Capturing' : 'Disabled'} · {status.samples} samples · {status.bytes}{' '}
        bytes · {status.dropped} dropped
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
          disabled={busy || !status.enabled || !status.samples}
          onClick={() => void perform(() => window.lonelyChat!.exportDiagnosticCapture())}
        >
          Export private samples
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-amber-300">
          {error}
        </p>
      )}
    </section>
  );
}
