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
import { audioWorkletSource } from '../audio-processor';
import type { SpeechTestMode, SpeechTestSnapshot } from '../../shared/speech-playground-contract';

type TestSource = 'file' | 'microphone';
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));
const seconds = (ms: number) => (ms / 1000).toFixed(2) + 's';

/** The only state crossing to main is transient mono PCM. No Simulation recording or Chat effects. */
export function SpeechPlayground({ simulationActive }: { simulationActive: boolean }) {
  const [source, setSource] = useState<TestSource>('file');
  const [mode, setMode] = useState<SpeechTestMode>('live-equivalent');
  const [file, setFile] = useState<File | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [label, setLabel] = useState('Speech test');
  const [snapshot, setSnapshot] = useState<SpeechTestSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const api = window.lonelyChat!;
  const epoch = useRef(0);
  const cleanupCapture = useRef<() => void>(() => {});

  useEffect(() => {
    let mounted = true;
    const api = window.lonelyChat;
    const unsubscribe = api?.onSpeechTestChange((next) => {
      if (mounted) setSnapshot(next);
    });
    void api
      ?.getSpeechTestStatus()
      .then((next) => {
        if (mounted) setSnapshot(next);
      })
      .catch((failure: unknown) => {
        if (mounted) setError(reason(failure));
      });
    return () => {
      mounted = false;
      ++epoch.current;
      cleanupCapture.current();
      void api?.stopSpeechTest().catch(() => {});
      unsubscribe?.();
    };
  }, []);

  const refreshDevices = useCallback(async () => {
    try {
      if (!navigator.mediaDevices) throw new Error('Microphone capture is unavailable.');
      const found = await navigator.mediaDevices.enumerateDevices();
      setDevices(found.filter((device) => device.kind === 'audioinput' && !!device.deviceId));
    } catch (failure) {
      setError(reason(failure));
    }
  }, []);

  useEffect(() => {
    if (source !== 'microphone') return;
    void refreshDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', refreshDevices);
  }, [source, refreshDevices]);

  const stop = async () => {
    ++epoch.current;
    cleanupCapture.current();
    cleanupCapture.current = () => {};
    setBusy(false);
    setProgress(null);
    try {
      setSnapshot(await api.stopSpeechTest());
    } catch (failure) {
      setError(reason(failure));
    }
  };

  const runFile = async (run: number) => {
    if (!file) return;
    let audio: AudioContext | null = null;
    let started = false;
    try {
      if (file.size > 100 * 1024 * 1024)
        throw new Error('Speech Playground files must be 100 MiB or smaller.');
      audio = new AudioContext();
      const buffer = await audio.decodeAudioData(await file.arrayBuffer());
      if (run !== epoch.current) return;
      if (buffer.duration > 300)
        throw new Error('Speech Playground files are limited to five minutes.');
      if (mode === 'whole-file' && buffer.duration > 30)
        throw new Error(
          'Whole-file Whisper accepts up to 30 seconds. Use live-equivalent segmentation for a longer recording.',
        );
      await api.startSpeechTest({
        mode,
        sourceId: 'file',
        label: label.trim() || file.name.slice(0, 80),
        sampleRate: buffer.sampleRate,
      });
      started = true;
      const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) =>
        buffer.getChannelData(i),
      );
      const block = Math.round(buffer.sampleRate / 10);
      for (let position = 0; position < buffer.length; position += block) {
        if (run !== epoch.current) return;
        const length = Math.min(block, buffer.length - position);
        const mono = new Float32Array(length);
        for (const channel of channels)
          for (let i = 0; i < length; ++i) mono[i] += channel[position + i] / channels.length;
        await api.submitSpeechTestPcm(mono, true);
        if (run === epoch.current)
          setProgress(Math.round(((position + length) / buffer.length) * 100));
      }
      if (run !== epoch.current) return;
      await api.finishSpeechTest();
      if (run === epoch.current) await api.stopSpeechTest();
    } catch (failure) {
      if (run === epoch.current) setError(reason(failure));
    } finally {
      await audio?.close().catch(() => {});
      if (run === epoch.current) {
        if (started) {
          // Also retire the worker after failed file processing.
          await api.stopSpeechTest().catch(() => {});
        }
        setBusy(false);
      }
    }
  };

  const runMicrophone = async (run: number) => {
    let stream: MediaStream | null = null;
    let audio: AudioContext | null = null;
    let node: AudioWorkletNode | null = null;
    let sourceNode: MediaStreamAudioSourceNode | null = null;
    let sink: GainNode | null = null;
    let pending: number[] = [];
    let started = false;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: deviceId },
          autoGainControl: false,
          echoCancellation: false,
          noiseSuppression: false,
        },
        video: false,
      });
      if (run !== epoch.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      cleanupCapture.current = () => {
        node?.port.close();
        node?.disconnect();
        sourceNode?.disconnect();
        sink?.disconnect();
        stream?.getTracks().forEach((track) => track.stop());
        void audio?.close().catch(() => {});
        pending = [];
      };
      audio = new AudioContext();
      const context = audio;
      await api.startSpeechTest({
        mode: 'live-equivalent',
        sourceId: 'microphone',
        label: label.trim(),
        sampleRate: context.sampleRate,
      });
      started = true;
      const workletUrl = URL.createObjectURL(
        new Blob([audioWorkletSource], { type: 'text/javascript' }),
      );
      try {
        await context.audioWorklet.addModule(workletUrl);
      } finally {
        URL.revokeObjectURL(workletUrl);
      }
      if (run !== epoch.current) return;
      sourceNode = context.createMediaStreamSource(stream);
      node = new AudioWorkletNode(context, 'lonely-chat-mono');
      sink = context.createGain();
      sink.gain.value = 0;
      sourceNode.connect(node);
      node.connect(sink);
      sink.connect(context.destination);
      const block = Math.round(context.sampleRate / 10);
      node.port.onmessage = (event: MessageEvent<Float32Array>) => {
        if (run !== epoch.current || !(event.data instanceof Float32Array)) return;
        for (const sample of event.data) pending.push(sample);
        while (pending.length >= block) {
          const chunk = Float32Array.from(pending.splice(0, block));
          void api.submitSpeechTestPcm(chunk).catch((failure: unknown) => {
            if (run === epoch.current) setError(reason(failure));
          });
        }
      };
      const captured = stream;
      captured.getAudioTracks().forEach((track) =>
        track.addEventListener(
          'ended',
          () => {
            if (run === epoch.current) void stop();
          },
          { once: true },
        ),
      );
      await context.resume();
    } catch (failure) {
      if (run === epoch.current) {
        setError(reason(failure));
        cleanupCapture.current();
        cleanupCapture.current = () => {};
        if (started) await api.stopSpeechTest().catch(() => {});
        setBusy(false);
      } else {
        // This superseded capture must not tear down a newer experiment.
        node?.port.close();
        node?.disconnect();
        sourceNode?.disconnect();
        sink?.disconnect();
        stream?.getTracks().forEach((track) => track.stop());
        await audio?.close().catch(() => {});
      }
    }
  };

  const run = () => {
    if (busy || simulationActive || !label.trim()) return;
    const run = ++epoch.current;
    setError(null);
    setProgress(null);
    setBusy(true);
    if (source === 'file') void runFile(run);
    else void runMicrophone(run);
  };

  return (
    <section aria-label="Speech Playground" className="space-y-5">
      <div>
        <h2 className="text-2xl font-semibold">Speech Playground</h2>
        <p className="mt-1 text-sm text-zinc-400">
          Standalone Whisper testing. PCM and native workers are transient; no chat messages or
          Simulation Events are created.
        </p>
      </div>
      <div className="rounded-xl border border-border bg-card p-5 space-y-4">
        <div>
          <Label htmlFor="speech-source">Audio source</Label>
          <Select
            value={source}
            onValueChange={(value) => {
              if (value === 'file' || value === 'microphone') setSource(value);
            }}
            items={[
              { value: 'file', label: 'Local audio file' },
              { value: 'microphone', label: 'Live microphone / audio device' },
            ]}
          >
            <SelectTrigger id="speech-source" className="mt-2 w-full" disabled={busy}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="file">Local audio file</SelectItem>
              <SelectItem value="microphone">Live microphone / audio device</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {source === 'file' ? (
          <>
            <div>
              <Label htmlFor="speech-file">Audio file</Label>
              <Input
                id="speech-file"
                type="file"
                accept="audio/*"
                className="mt-2"
                disabled={busy}
                onChange={(event) => {
                  const selected = event.target.files?.[0] ?? null;
                  setFile(selected);
                  if (selected) setLabel(selected.name.slice(0, 80));
                }}
              />
            </div>
            <div>
              <Label htmlFor="speech-mode">Processing mode</Label>
              <Select
                value={mode}
                onValueChange={(value) => {
                  if (value === 'live-equivalent' || value === 'whole-file') setMode(value);
                }}
                items={[
                  {
                    value: 'live-equivalent',
                    label: 'Live-equivalent segmentation and resampling',
                  },
                  { value: 'whole-file', label: 'Whole-file transcription (not live-equivalent)' },
                ]}
              >
                <SelectTrigger id="speech-mode" className="mt-2 w-full" disabled={busy}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="live-equivalent">
                    Live-equivalent segmentation and resampling
                  </SelectItem>
                  <SelectItem value="whole-file">
                    Whole-file transcription (not live-equivalent)
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="mt-2 text-xs text-zinc-400">
                {mode === 'whole-file'
                  ? 'One complete clip goes to Whisper (maximum 30 seconds). This bypasses live VAD and is not representative of live segmentation.'
                  : 'The file is split into 100 ms PCM blocks, passed through the production resampler/VAD, then each detected utterance is sent to Whisper. Feeding is faster than realtime; worker backlog is throttled.'}
              </p>
            </div>
          </>
        ) : (
          <div>
            <Label htmlFor="speech-device">Live input device</Label>
            <Select
              value={deviceId}
              onValueChange={(value) => setDeviceId(value ?? '')}
              items={devices.map((device, i) => ({
                value: device.deviceId,
                label: device.label || `Audio input ${i + 1}`,
              }))}
            >
              <SelectTrigger id="speech-device" className="mt-2 w-full" disabled={busy}>
                <SelectValue placeholder="Select a capture device" />
              </SelectTrigger>
              <SelectContent>
                {devices.map((device, i) => (
                  <SelectItem key={device.deviceId} value={device.deviceId}>
                    {device.label || `Audio input ${i + 1}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="secondary"
              size="sm"
              className="mt-2"
              disabled={busy}
              onClick={() => void refreshDevices()}
            >
              Refresh devices
            </Button>
            <p className="mt-2 text-xs text-zinc-400">
              The selected live device uses the same capture worklet and segmentation/resampling
              code as normal audio inputs.
            </p>
          </div>
        )}
        <div>
          <Label htmlFor="speech-label">Transcript source label</Label>
          <Input
            id="speech-label"
            className="mt-2"
            maxLength={80}
            disabled={busy}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
        </div>
        <div className="flex items-center gap-3">
          <Button
            disabled={
              !busy &&
              (simulationActive || !label.trim() || (source === 'file' ? !file : !deviceId))
            }
            onClick={() => {
              if (busy) void stop();
              else run();
            }}
          >
            {busy ? 'Stop speech test' : 'Start speech test'}
          </Button>
          <span role="status" className="text-xs text-zinc-400">
            {snapshot?.phase ?? 'idle'}
            {snapshot?.pending ? ` · ${snapshot.pending} pending` : ''}
            {progress !== null ? ` · ${progress}% fed` : ''}
          </span>
        </div>
        {simulationActive && (
          <p className="text-xs text-amber-300">
            Stop Simulation before starting a speech experiment.
          </p>
        )}
        {(error || snapshot?.error) && (
          <p role="alert" className="text-sm text-amber-300">
            {error || snapshot?.error}
          </p>
        )}
      </div>
      <div className="rounded-xl border border-border bg-card p-5">
        <h3 className="font-medium">Segments and transcripts</h3>
        <p className="mt-1 text-xs text-zinc-400">
          Boundaries are measured from the beginning of the input. Each row includes its source,
          timing, worker output or failure.
        </p>
        {snapshot?.segments.length ? (
          <div className="mt-4 space-y-2" aria-label="Speech test segments">
            {snapshot.segments.map((segment) => (
              <div key={segment.id} className="rounded-md border border-border p-3 text-sm">
                <div className="flex flex-wrap gap-2 text-xs text-zinc-400">
                  <span>
                    {segment.label} ({segment.sourceId})
                  </span>
                  <span>
                    {seconds(segment.startMs)}–{seconds(segment.endMs)}
                  </span>
                  <span>{segment.phase}</span>
                  {segment.durationMs !== null && <span>Whisper: {segment.durationMs} ms</span>}
                </div>
                {segment.text && <p className="mt-2 whitespace-pre-wrap">{segment.text}</p>}
                {segment.error && (
                  <p role="alert" className="mt-2 text-amber-300">
                    {segment.error}
                  </p>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-4 text-sm text-zinc-500">No speech segments yet.</p>
        )}
      </div>
    </section>
  );
}
