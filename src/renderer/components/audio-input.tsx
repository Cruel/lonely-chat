import { useCallback, useEffect, useState } from 'react';
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
import type { AudioStatus } from '../../shared/audio-contract';

let nextCaptureSequence = 0;

function mediaError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError')
      return 'Microphone permission denied. Enable microphone access in system settings and retry.';
    if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError')
      return 'Selected microphone is disconnected or no longer available.';
    if (error.name === 'NotReadableError') return 'Microphone is busy or unavailable.';
  }
  return error instanceof Error ? error.message : 'Unable to start microphone capture.';
}

/** Ordinary Chromium audioinput; native speech inference occurs in Electron main. */
export function AudioInput({ visible = true }: { visible?: boolean }) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selected, setSelected] = useState('none');
  const [label, setLabel] = useState('Microphone');
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<AudioStatus | null>(null);
  const [refreshCount, refresh] = useState(0);

  const listDevices = useCallback(async () => {
    try {
      if (!navigator.mediaDevices)
        throw new Error('Audio capture is unavailable in this environment.');
      setDevices(
        (await navigator.mediaDevices.enumerateDevices()).filter(
          (item) => item.kind === 'audioinput' && item.deviceId,
        ),
      );
    } catch (failure) {
      setError(mediaError(failure));
    }
  }, []);

  useEffect(() => {
    if (!window.lonelyChat) return;
    let valid = true;
    const unsubscribe = window.lonelyChat.onAudioChange((next) => {
      if (!valid) return;
      setStatus(next);
      if (next.phase === 'error') {
        setError(next.error ?? 'Speech transcription stopped unexpectedly.');
        setEnabled(false);
      }
    });
    void window.lonelyChat.getAudioStatus().then((next) => {
      if (valid) setStatus(next);
    });
    return () => {
      valid = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!visible && !enabled) return;
    void listDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange', listDevices);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', listDevices);
  }, [visible, enabled, listDevices, refreshCount]);

  useEffect(() => {
    let active = true;
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let node: AudioWorkletNode | null = null;
    let input: MediaStreamAudioSourceNode | null = null;
    let sink: GainNode | null = null;
    const captureId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${++nextCaptureSequence}`;
    const stop = () => {
      node?.port.close();
      node?.disconnect();
      input?.disconnect();
      sink?.disconnect();
      stream?.getTracks().forEach((track) => track.stop());
      void context?.close();
      void window.lonelyChat?.stopAudio(captureId).catch(() => {});
    };
    if (enabled && selected !== 'none' && window.lonelyChat) {
      const start = async () => {
        setError(null);
        try {
          const api = window.lonelyChat!;
          const media = navigator.mediaDevices;
          if (!media) throw new Error('Chromium audio capture is unavailable.');
          const captured = await media.getUserMedia({
            audio: {
              deviceId: { exact: selected },
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
          if (!track) throw new Error('No microphone audio track was supplied.');
          track.onended = () => {
            if (active) {
              setError('Microphone disconnected. Select or reconnect the device.');
              setEnabled(false);
            }
          };
          await listDevices();
          const ready = await api.startAudio(selected, label, captureId);
          if (!active) return;
          if (ready.phase !== 'ready')
            throw new Error(ready.error ?? 'Native speech worker did not become ready.');
          context = new AudioContext();
          const workletUrl = URL.createObjectURL(
            new Blob([audioWorkletSource], { type: 'text/javascript' }),
          );
          try {
            await context.audioWorklet.addModule(workletUrl);
          } finally {
            URL.revokeObjectURL(workletUrl);
          }
          if (!active) return;
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
            if (!active || !(event.data instanceof Float32Array)) return;
            for (const samples of segmenter.push(resampler.push(event.data))) {
              void api.submitAudioSegment({ samples }, captureId).catch((reason: unknown) => {
                if (active) setError(mediaError(reason));
              });
            }
          };
          await context.resume();
        } catch (failure) {
          if (active) {
            setError(mediaError(failure));
            setEnabled(false);
          }
        }
      };
      void start();
    }
    return () => {
      active = false;
      stop();
    };
  }, [enabled, selected, label, listDevices]);

  const unavailable =
    selected !== 'none' && !devices.some((device) => device.deviceId === selected);
  return (
    <div>
      <h3 className="font-medium">Audio source</h3>
      <p className="mt-2 text-sm text-zinc-400">
        Optionally capture an ordinary microphone or virtual audio input. Speech uses an activated
        local whisper.cpp model, independent of video and chat inference. No audio is saved.
      </p>
      <Label htmlFor="audio-source" className="mt-4 text-sm text-zinc-200">
        Input device
      </Label>
      <Select
        items={[
          { value: 'none', label: 'No audio' },
          ...devices.map((device, index) => ({
            value: device.deviceId,
            label: device.label || `Microphone ${index + 1}`,
          })),
        ]}
        value={selected}
        onValueChange={(value) => {
          if (typeof value === 'string') {
            setEnabled(false);
            setSelected(value);
          }
        }}
      >
        <SelectTrigger id="audio-source" className="mt-2 w-full text-sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">No audio</SelectItem>
          {devices.map((device, index) => (
            <SelectItem key={device.deviceId} value={device.deviceId}>
              {device.label || `Microphone ${index + 1}`}
            </SelectItem>
          ))}
          {unavailable && <SelectItem value={selected}>Disconnected device</SelectItem>}
        </SelectContent>
      </Select>
      <Label htmlFor="audio-label" className="mt-4 text-sm text-zinc-200">
        Transcript source label
      </Label>
      <Input
        id="audio-label"
        className="mt-2"
        maxLength={80}
        value={label}
        disabled={enabled}
        onChange={(event) => setLabel(event.target.value)}
      />
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            void listDevices();
            refresh((n) => n + 1);
          }}
        >
          Refresh devices
        </Button>
        <Button
          size="sm"
          disabled={selected === 'none' || !label.trim()}
          onClick={() => setEnabled((value) => !value)}
        >
          {enabled ? 'Stop audio' : 'Start audio'}
        </Button>
        <span role="status" className="text-xs text-zinc-400">
          Speech: {enabled ? (status?.phase ?? 'starting') : 'off'}
        </span>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-sm text-amber-300">
          {error}
        </p>
      )}
      {status?.error && enabled && (
        <p role="alert" className="mt-3 text-sm text-amber-300">
          {status.error}
        </p>
      )}
      {!!status?.transcripts.length && (
        <div className="mt-4 space-y-1" aria-label="Recent speech transcripts">
          <h4 className="text-xs font-medium text-zinc-300">Recent transcripts</h4>
          {status.transcripts.slice(-4).map((item, index) => (
            <p key={`${item.observedAt}-${index}`} className="text-xs text-zinc-400">
              {item.source}: {item.text}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
