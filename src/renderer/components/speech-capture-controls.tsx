import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { SpeechCaptureStatus } from '../../shared/speech-capture-contract';

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const mib = (bytes: number) => (bytes / (1024 * 1024)).toFixed(2);

/** Deliberate desktop-only raw PCM control, separate from all other recording modes. */
export function SpeechCaptureControls({
  onRerun,
  rerunDisabled = false,
}: {
  onRerun?: (id: string) => Promise<void>;
  rerunDisabled?: boolean;
}) {
  const [status, setStatus] = useState<SpeechCaptureStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const api = window.lonelyChat;
    if (!api?.getSpeechCapture) return;
    let mounted = true;
    const unsubscribe = api.onSpeechCaptureChange((next) => {
      if (mounted) setStatus(next);
    });
    void api.getSpeechCapture().then(
      (next) => {
        if (mounted) setStatus(next);
      },
      (failure: unknown) => {
        if (mounted) setError(message(failure));
      },
    );
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const action = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(false);
    }
  };

  const api = window.lonelyChat;
  return (
    <section
      aria-label="Raw speech segment diagnostics"
      className="rounded-xl border border-border bg-card p-5 space-y-3"
    >
      <div>
        <h3 className="font-medium">Raw speech segment diagnostics</h3>
        <p className="mt-1 text-xs text-zinc-400">
          OFF by default on every launch. This separate opt-in saves actual 16 kHz mono Whisper
          segments, source labels, timestamps, transcripts and worker errors to private disk.
          Ordinary Logs and Compact/Exact recordings never enable raw PCM capture. Stored clips
          survive restart until explicitly deleted; they never reach the public overlay.
        </p>
        <p className="mt-1 text-xs text-amber-300">
          Voice recordings and transcripts may identify people. Only enable with permission.
          Exported JSON contains replayable raw PCM and text; review before sharing.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant={status?.enabled ? 'destructive' : 'secondary'}
          size="sm"
          disabled={busy || !status}
          onClick={() => void action(() => api!.configureSpeechCapture(!status?.enabled))}
        >
          {status?.enabled ? 'Stop raw audio capture' : 'Enable raw audio capture'}
        </Button>
        <span role="status" className="text-xs text-zinc-400">
          {status?.enabled ? 'Capturing new segments' : 'Not capturing'}
          {status
            ? ` · ${mib(status.bytes)} / ${mib(status.maxBytes)} MiB · ${status.records.length} saved`
            : ''}
          {status?.pending ? ` · ${status.pending} finishing` : ''}
        </span>
      </div>
      {status?.warning && (
        <p role="alert" className="text-sm text-amber-300">
          {status.warning}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-amber-300">
          {error}
        </p>
      )}
      {(!!status?.records.length || !!status?.pending || !!status?.warning) && (
        <>
          <div className="flex justify-end">
            <Button
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm('Stop capture and permanently delete all saved raw speech clips?')
                )
                  void action(() => api!.clearCapturedSpeech());
              }}
            >
              Stop and delete all clips
            </Button>
          </div>
          {!!status?.records.length && (
            <div className="max-h-80 overflow-y-auto space-y-2" aria-label="Saved raw speech clips">
              {status.records.map((record) => (
                <div
                  key={record.id}
                  className="border border-border rounded-md p-3 text-xs space-y-2"
                >
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-zinc-400">
                    <span>
                      {record.label} ({record.sourceId})
                    </span>
                    <span>
                      Segment {record.sequence} · {record.id.slice(0, 8)}
                    </span>
                    <span>
                      {record.timeBase === 'input'
                        ? `${(record.startMs / 1000).toFixed(2)}–${(record.endMs / 1000).toFixed(2)} s (input)`
                        : `${new Date(record.startMs).toLocaleTimeString()}–${new Date(record.endMs).toLocaleTimeString()}`}
                    </span>
                    <span>
                      {record.result} · {record.durationMs} ms · {mib(record.bytes)} MiB
                    </span>
                  </div>
                  {record.text && <p className="whitespace-pre-wrap">{record.text}</p>}
                  {record.error && <p className="text-amber-300">{record.error}</p>}
                  <div className="flex flex-wrap gap-2">
                    {onRerun && (
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busy || rerunDisabled}
                        onClick={() => void action(() => onRerun(record.id))}
                      >
                        Rerun in Speech Playground
                      </Button>
                    )}
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      onClick={() => void action(() => api!.exportCapturedSpeech(record.id))}
                    >
                      Export clip
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm('Permanently delete this raw speech segment?'))
                          void action(() => api!.deleteCapturedSpeech(record.id));
                      }}
                    >
                      Delete clip
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
