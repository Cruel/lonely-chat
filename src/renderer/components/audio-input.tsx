import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { MonoResampler, SpeechSegmenter } from '../../main/audio-segmentation';
import { audioWorkletSource } from '../audio-processor';
import type { AudioSourceStatus, AudioStatus } from '../../shared/audio-contract';

const LOOPBACK = 'system-loopback';
let nextSourceSequence = 0;
let nextCaptureSequence = 0;

interface ConfiguredInput {
  readonly id: string;
  readonly sourceId: string;
  readonly label: string;
  readonly enabled: boolean;
}

function mediaError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError')
      return 'Audio permission denied. Enable capture access in system settings.';
    if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError')
      return 'Selected audio device is disconnected or unavailable.';
    if (error.name === 'NotReadableError') return 'Audio device is busy or unavailable.';
  }
  return error instanceof Error ? error.message : 'Unable to start audio capture.';
}

function recoverable(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    ['NotFoundError', 'NotReadableError', 'OverconstrainedError'].includes(error.name)
  );
}

function CaptureInput({
  config,
  available,
  status,
  loopbackRequest,
  onEdit,
}: {
  config: ConfiguredInput;
  available: boolean;
  status?: AudioSourceStatus;
  loopbackRequest?: Promise<MediaStream>;
  onEdit: (patch: Partial<ConfiguredInput>) => void;
}) {
  const { id, sourceId, enabled } = config;
  const currentLabel = useRef(config.label);
  currentLabel.current = config.label;
  const currentlyAvailable = useRef(available);
  currentlyAvailable.current = available;
  const wasReady = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    let ended = false;
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let node: AudioWorkletNode | null = null;
    let input: MediaStreamAudioSourceNode | null = null;
    let sink: GainNode | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const captureId = globalThis.crypto?.randomUUID?.() ?? `capture-${++nextCaptureSequence}`;
    const api = window.lonelyChat;

    const retry = () => {
      if (retryTimer !== null) return;
      retryTimer = setTimeout(() => {
        if (active) setAttempt((value) => value + 1);
      }, 2000);
    };
    const disconnected = () => {
      if (!active || ended) return;
      ended = true;
      setError('Audio source disconnected. Waiting to reconnect to the same device.');
      void api?.audioDisconnected(captureId).catch(() => {});
      if (sourceId === LOOPBACK) onEdit({ enabled: false });
      else retry();
    };

    if (enabled && available && sourceId && api) {
      const start = async () => {
        setError(null);
        try {
          const media = navigator.mediaDevices;
          if (!media) throw new Error('Chromium audio capture is unavailable.');
          const captured =
            sourceId === LOOPBACK
              ? await (loopbackRequest ??
                  Promise.reject(new Error('Start loopback capture from the Start button.')))
              : await media.getUserMedia({
                  audio: {
                    deviceId: { exact: sourceId },
                    echoCancellation: false,
                    autoGainControl: false,
                    noiseSuppression: false,
                  },
                  video: false,
                });
          if (!active) {
            captured.getTracks().forEach((track) => track.stop());
            return;
          }
          stream = captured;
          const track = captured.getAudioTracks()[0];
          if (!track) throw new Error('The selected source returned no audio track.');
          track.addEventListener('ended', disconnected);
          const ready = await api.startAudio(id, sourceId, currentLabel.current, captureId);
          if (!active || ended) return;
          const source = ready.sources.find((item) => item.id === id);
          if (source?.phase !== 'ready' && source?.phase !== 'starting')
            throw new Error(source?.error ?? 'Speech worker failed to become ready.');
          context = new AudioContext();
          const workletUrl = URL.createObjectURL(
            new Blob([audioWorkletSource], { type: 'text/javascript' }),
          );
          try {
            await context.audioWorklet.addModule(workletUrl);
          } finally {
            URL.revokeObjectURL(workletUrl);
          }
          if (!active || ended) return;
          const resampler = new MonoResampler(context.sampleRate);
          const segmenter = new SpeechSegmenter();
          input = context.createMediaStreamSource(captured);
          node = new AudioWorkletNode(context, 'lonely-chat-mono');
          sink = context.createGain();
          sink.gain.value = 0;
          input.connect(node);
          node.connect(sink);
          sink.connect(context.destination);
          node.port.onmessage = (event: MessageEvent<Float32Array>) => {
            if (!active || ended || !(event.data instanceof Float32Array)) return;
            for (const samples of segmenter.push(resampler.push(event.data))) {
              void api.submitAudioSegment({ samples }, captureId).catch((reason: unknown) => {
                if (active && !ended) setError(mediaError(reason));
              });
            }
          };
          await context.resume();
        } catch (failure) {
          if (!active || ended) return;
          setError(mediaError(failure));
          if (sourceId !== LOOPBACK && recoverable(failure)) retry();
          else onEdit({ enabled: false });
        }
      };
      void start();
    }

    return () => {
      active = false;
      if (retryTimer !== null) clearTimeout(retryTimer);
      node?.port.close();
      node?.disconnect();
      input?.disconnect();
      sink?.disconnect();
      stream?.getTracks().forEach((track) => track.stop());
      void context?.close();
      if (enabled && !currentlyAvailable.current) {
        void api?.audioDisconnected(captureId).catch(() => {});
      } else {
        void api?.stopAudio(captureId).catch(() => {});
      }
    };
  }, [id, sourceId, enabled, available, attempt, loopbackRequest]);

  useEffect(() => {
    if (!enabled) wasReady.current = false;
    else if (status?.phase === 'ready') {
      wasReady.current = true;
      setError(null);
    } else if (status?.phase === 'error') setError(status.error ?? 'Speech transcription failed.');
  }, [enabled, status?.phase, status?.error]);

  const phase = !enabled ? 'off' : !available ? 'disconnected' : (status?.phase ?? 'starting');
  return (
    <>
      <span role="status" className="text-xs text-zinc-400">
        Speech: {phase}
        {status?.pendingSegments ? ` · ${status.pendingSegments} pending` : ''}
      </span>
      {(error || status?.error) && (
        <p role="alert" className="mt-2 text-xs text-amber-300">
          {status?.error ?? error}
        </p>
      )}
      {enabled && status?.phase === 'error' && (
        <Button
          size="sm"
          variant="secondary"
          className="mt-2"
          onClick={() => {
            void window.lonelyChat
              ?.retryAudio(id)
              .then(() => setError(null))
              .catch((reason: unknown) => setError(mediaError(reason)));
          }}
        >
          Retry speech worker
        </Button>
      )}
    </>
  );
}

/** User-configured, independently running standard Chromium audio inputs. */
export function AudioInput({ visible = true }: { visible?: boolean }) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [sources, setSources] = useState<ConfiguredInput[]>([]);
  const loopbackRequests = useRef(new Map<string, Promise<MediaStream>>());
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<AudioStatus | null>(null);
  const [loopback, setLoopback] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const listDevices = useCallback(async () => {
    try {
      if (!navigator.mediaDevices)
        throw new Error('Audio capture is unavailable in this environment.');
      const found = await navigator.mediaDevices.enumerateDevices();
      setDevices(found.filter((item) => item.kind === 'audioinput' && item.deviceId));
    } catch (failure) {
      setError(mediaError(failure));
    }
  }, []);

  useEffect(() => {
    let live = true;
    void window.lonelyChat
      ?.getAudioConfiguration()
      .then((saved) => {
        if (!live) return;
        setSources(saved.map((item) => ({ ...item, enabled: false })));
        setLoaded(true);
      })
      .catch((failure: unknown) => {
        if (live) setError(mediaError(failure));
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!loaded || sources.some((source) => !source.label.trim())) return;
    void window.lonelyChat
      ?.setAudioConfiguration(sources.map(({ id, sourceId, label }) => ({ id, sourceId, label })))
      .catch((failure: unknown) => setError(mediaError(failure)));
  }, [loaded, sources]);

  useEffect(() => {
    const api = window.lonelyChat;
    if (!api) return;
    let live = true;
    const unsubscribe = api.onAudioChange((next) => {
      if (live) setStatus(next);
    });
    void api.getAudioStatus().then((next) => {
      if (live) setStatus(next);
    });
    void api.getAudioCapabilities().then((capabilities) => {
      if (live) setLoopback(capabilities.windowsLoopback);
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!visible && !sources.some((source) => source.enabled)) return;
    void listDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange', listDevices);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', listDevices);
  }, [visible, sources, listDevices]);

  const update = (id: string, patch: Partial<ConfiguredInput>) => {
    setSources((items) => items.map((item) => (item.id === id ? { ...item, ...patch } : item)));
    if (
      typeof patch.label === 'string' &&
      patch.label.trim() &&
      status?.sources.some((item) => item.id === id)
    ) {
      void window.lonelyChat?.setAudioLabel(id, patch.label).catch((failure: unknown) => {
        setError(mediaError(failure));
      });
    }
  };

  return (
    <div>
      <h3 className="font-medium">Audio inputs</h3>
      <p className="mt-2 text-sm text-zinc-400">
        Add any number of ordinary microphones or virtual audio devices. Each input is transcribed
        independently with its own label. Audio is not saved.
      </p>
      {sources.map((source, index) => {
        const selected = devices.find((device) => device.deviceId === source.sourceId);
        const available = source.sourceId === LOOPBACK ? loopback : !!selected;
        return (
          <div key={source.id} className="mt-4 rounded-lg border border-border p-3">
            <div className="flex items-center justify-between gap-2">
              <h4 className="text-sm font-medium">Input {index + 1}</h4>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Remove input ${index + 1}`}
                onClick={() => {
                  loopbackRequests.current.delete(source.id);
                  setSources((items) => items.filter((item) => item.id !== source.id));
                  void window.lonelyChat?.removeAudioInput(source.id).catch(() => {});
                }}
              >
                Remove
              </Button>
            </div>
            <Label htmlFor={`audio-source-${source.id}`} className="mt-3 text-xs text-zinc-300">
              Input device
            </Label>
            <Select
              items={[
                { value: 'none', label: 'Choose an input' },
                ...devices.map((device, i) => ({
                  value: device.deviceId,
                  label: device.label || `Microphone ${i + 1}`,
                })),
                ...(loopback
                  ? [{ value: LOOPBACK, label: 'Windows system audio (loopback)' }]
                  : []),
              ]}
              value={source.sourceId || 'none'}
              onValueChange={(value) => {
                if (typeof value === 'string')
                  update(source.id, {
                    sourceId: value === 'none' ? '' : value,
                    enabled: false,
                  });
              }}
            >
              <SelectTrigger id={`audio-source-${source.id}`} className="mt-1 w-full text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Choose an input</SelectItem>
                {devices.map((device, i) => (
                  <SelectItem key={device.deviceId} value={device.deviceId}>
                    {device.label || `Microphone ${i + 1}`}
                  </SelectItem>
                ))}
                {loopback && (
                  <SelectItem value={LOOPBACK}>Windows system audio (loopback)</SelectItem>
                )}
                {!!source.sourceId && !available && (
                  <SelectItem value={source.sourceId}>Disconnected device</SelectItem>
                )}
              </SelectContent>
            </Select>
            <Label htmlFor={`audio-label-${source.id}`} className="mt-3 text-xs text-zinc-300">
              Transcript source label
            </Label>
            <Input
              id={`audio-label-${source.id}`}
              className="mt-1"
              maxLength={80}
              value={source.label}
              onChange={(event) => update(source.id, { label: event.target.value })}
            />
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button
                size="sm"
                disabled={!source.sourceId || !source.label.trim()}
                onClick={() => {
                  if (source.enabled) {
                    loopbackRequests.current.delete(source.id);
                  } else if (source.sourceId === LOOPBACK) {
                    // Chromium requires transient user activation for display capture.
                    // The promise must be created here, not in a subsequent effect.
                    const media = navigator.mediaDevices;
                    if (!media?.getDisplayMedia) {
                      setError('System playback capture is unavailable in this environment.');
                      return;
                    }
                    loopbackRequests.current.set(
                      source.id,
                      media.getDisplayMedia({ audio: true, video: true }),
                    );
                  }
                  update(source.id, { enabled: !source.enabled });
                }}
              >
                {source.enabled ? 'Stop audio' : 'Start audio'}
              </Button>
              <CaptureInput
                config={source}
                available={available}
                loopbackRequest={loopbackRequests.current.get(source.id)}
                status={status?.sources.find((item) => item.id === source.id)}
                onEdit={(patch) => update(source.id, patch)}
              />
            </div>
          </div>
        );
      })}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={!loaded}
          onClick={() => {
            const id =
              globalThis.crypto?.randomUUID?.() ?? `input-${Date.now()}-${++nextSourceSequence}`;
            setSources((items) => [
              ...items,
              { id, sourceId: '', label: `Audio ${items.length + 1}`, enabled: false },
            ]);
          }}
        >
          Add audio input
        </Button>
        <Button size="sm" variant="secondary" onClick={() => void listDevices()}>
          Refresh devices
        </Button>
      </div>
      {!loopback && (
        <p className="mt-3 text-xs text-zinc-500">
          Windows system playback loopback is available only on Windows. On other platforms, route
          application audio through a standard virtual input device.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-xs text-amber-300">
          {error}
        </p>
      )}
      {!!status?.transcripts.length && (
        <div className="mt-4 space-y-1" aria-label="Recent speech transcripts">
          <h4 className="text-xs font-medium text-zinc-300">Recent transcripts</h4>
          {status.transcripts.slice(-8).map((item, index) => (
            <p
              key={`${item.sourceId}-${item.observedAt}-${index}`}
              className="text-xs text-zinc-400"
            >
              {item.source}: {item.text}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
