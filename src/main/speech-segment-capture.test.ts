import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SpeechSegmentCapture } from './speech-segment-capture';
import { AudioService } from './audio-service';
import { SpeechPlaygroundService } from './speech-playground-service';
import type { NativeSpeech } from './native-speech';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lc-speech-'));
  roots.push(root);
  const capture = new SpeechSegmentCapture(root);
  await capture.load();
  return { capture, root };
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function storeSample(
  capture: SpeechSegmentCapture,
  sourceId: string,
  pcm: Float32Array,
  captureId = sourceId,
) {
  return capture.begin(
    {
      sourceId,
      captureId,
      label: sourceId === 'caster' ? 'Caster' : 'Guest',
      timeBase: 'observation',
      startMs: 1000,
      endMs: 1000 + (pcm.length * 1000) / 16000,
      observedAt: 2000,
    },
    pcm,
  );
}

describe('private opt-in Whisper PCM evidence', () => {
  it('does not record by default, requires a separate opt-in, and never persists the enabled switch', async () => {
    const { capture, root } = await fixture();
    const pcm = new Float32Array(1600).fill(0.1);
    expect(storeSample(capture, 'caster', pcm)).toBeNull();
    await capture.complete(null, { text: 'ignored', durationMs: 1 });
    expect(capture.status().records).toHaveLength(0);
    expect(await readdir(path.join(root, 'speech-segments'))).toEqual([]);

    capture.configure(true);
    const id = storeSample(capture, 'caster', pcm)!;
    // Changing IPC source PCM after admission cannot modify evidence.
    pcm.fill(0);
    capture.configure(false);
    await capture.complete(id, { text: 'spoken', durationMs: 27 });
    expect(capture.status().records).toMatchObject([
      { id, sourceId: 'caster', result: 'transcribed', text: 'spoken', sequence: 1 },
    ]);
    const restored = (await capture.samples(id)).pcm;
    expect(restored.length).toBe(1600);
    expect(restored[0]).toBeCloseTo(0.1);
    expect(restored[1599]).toBeCloseTo(0.1);

    const readErrors: unknown[] = [];
    const reopened = new SpeechSegmentCapture(root, (error) => readErrors.push(error));
    await reopened.load();
    expect(readErrors).toEqual([]);
    expect(reopened.status().enabled).toBe(false);
    expect(reopened.status().records).toHaveLength(1);
    expect((await reopened.exportRecord(id)).toString()).toContain('pcmBase64');
    await reopened.deleteRecord(id);
    expect(reopened.status().bytes).toBe(0);
    expect(await readdir(path.join(root, 'speech-segments'))).toEqual([]);
  });

  it('keeps different Whisper sources and failures linked to their exact segment, even after Stop', async () => {
    const { capture } = await fixture();
    const responses: Array<{ resolve: (text: string) => void; reject: (error: Error) => void }> =
      [];
    const onTranscript = vi.fn();
    const worker = () =>
      ({
        start: async () => {},
        stop: () => {},
        transcribe: () =>
          new Promise<string>((resolve, reject) => responses.push({ resolve, reject })),
      }) as unknown as NativeSpeech;
    const service = new AudioService(
      worker,
      onTranscript,
      () => 20_000,
      undefined,
      undefined,
      undefined,
      undefined,
      capture,
    );
    await service.start('caster', 'mic-c', 'Caster', 'capture-c');
    await service.start('guest', 'mic-g', 'Guest', 'capture-g');
    service.submit({ samples: new Float32Array(1600).fill(0.11) }, 'capture-c');
    expect(capture.status().records).toHaveLength(0);
    capture.configure(true);
    service.submit({ samples: new Float32Array(1600).fill(0.22) }, 'capture-c');
    service.submit({ samples: new Float32Array(1600).fill(0.33) }, 'capture-g');
    capture.configure(false);
    service.submit({ samples: new Float32Array(1600).fill(0.44) }, 'capture-g');
    expect(capture.status().pending).toBe(2);
    responses[0].resolve('not saved');
    responses[1].resolve('caster speech');
    responses[2].reject(new Error('guest worker failed'));
    responses[3].resolve('not saved');
    await vi.waitFor(() => expect(capture.status().records).toHaveLength(2));
    const bySource = Object.fromEntries(
      capture.status().records.map((record) => [record.sourceId, record]),
    );
    expect(bySource.caster).toMatchObject({ text: 'caster speech', result: 'transcribed' });
    expect(bySource.guest).toMatchObject({ error: 'guest worker failed', result: 'failed' });
    expect((await capture.samples(bySource.caster.id)).pcm[0]).toBeCloseTo(0.22);
    expect((await capture.samples(bySource.guest.id)).pcm[0]).toBeCloseTo(0.33);
    expect(onTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: 'caster', speechSegmentId: bySource.caster.id }),
    );
    expect(onTranscript.mock.calls[0][0]).not.toHaveProperty('speechSegmentId');
    expect(capture.status().enabled).toBe(false);

    await capture.clear();
    expect(capture.status()).toMatchObject({ enabled: false, bytes: 0, pending: 0, records: [] });
    service.stop();
  });

  it('bounds pending PCM with an explicit non-evicting cap and cancels pending clips on clear', async () => {
    const { capture } = await fixture();
    capture.configure(true);
    const big = new Float32Array(16000 * 30).fill(0.2);
    let admitted = 0;
    for (let index = 0; index < 40; index++) {
      if (!storeSample(capture, 'caster', big)) break;
      admitted++;
    }
    expect(admitted).toBeGreaterThan(0);
    expect(admitted).toBeLessThan(40);
    expect(capture.status().enabled).toBe(false);
    expect(capture.status().bytes).toBeLessThanOrEqual(capture.status().maxBytes);
    expect(capture.status().warning).toMatch(/cap/);
    await capture.clear();
    expect(capture.status().pending).toBe(0);
    expect(capture.status().bytes).toBe(0);
  });

  it('fails closed on malformed evidence and allows explicit cleanup without retaining private PCM', async () => {
    const { root } = await fixture();
    const damaged = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa.json';
    await writeFile(path.join(root, 'speech-segments', damaged), '{invalid', { mode: 0o600 });
    const capture = new SpeechSegmentCapture(root);
    await capture.load();
    expect(capture.status().enabled).toBe(false);
    expect(capture.status().warning).toMatch(/could not be loaded/);
    expect(() => capture.configure(true)).toThrow(/invalid or excessive/);
    await capture.clear();
    expect(await readdir(path.join(root, 'speech-segments'))).toEqual([]);
    expect(capture.configure(true).enabled).toBe(true);
  });

  it('restores sequence numbers after restart and uniquely identifies independent Playground experiments', async () => {
    const { capture, root } = await fixture();
    capture.configure(true);
    const pcm = new Float32Array(3200).fill(0.35);
    const first = storeSample(capture, 'caster', pcm, 'same-capture')!;
    await capture.complete(first, { text: 'first', durationMs: 1 });
    const reopened = new SpeechSegmentCapture(root);
    await reopened.load();
    reopened.configure(true);
    const second = storeSample(reopened, 'caster', pcm, 'same-capture')!;
    await reopened.complete(second, { text: 'second', durationMs: 1 });
    expect(reopened.status().records.find((record) => record.id === second)?.sequence).toBe(2);

    const worker = () =>
      ({
        start: async () => {},
        stop: () => {},
        transcribe: async () => 'hello',
        shutdown: async () => {},
      }) as unknown as NativeSpeech;
    async function experiment() {
      const service = new SpeechPlaygroundService(worker, () => true, Date.now, reopened);
      await service.start({
        mode: 'whole-file',
        sourceId: 'caster',
        label: 'Caster',
        sampleRate: 16000,
      });
      await service.push(pcm);
      const snapshot = await service.finish();
      expect(snapshot.segments[0]?.speechSegmentId).toBeTruthy();
      await reopened.flush();
      await service.stop();
    }
    await experiment();
    await experiment();
    const experiments = reopened.status().records.filter((record) => record.timeBase === 'input');
    expect(experiments).toHaveLength(2);
    expect(new Set(experiments.map((record) => record.captureId)).size).toBe(2);
  });

  it('fails closed and reports a storage initialization failure without preventing startup', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lc-speech-'));
    roots.push(root);
    await writeFile(path.join(root, 'speech-segments'), 'not-a-directory');
    const report = vi.fn();
    const capture = new SpeechSegmentCapture(root, report);
    await expect(capture.load()).resolves.toBeUndefined();
    expect(capture.status().warning).toMatch(/unavailable|could not/i);
    expect(capture.status().enabled).toBe(false);
    expect(() => capture.configure(true)).toThrow(/invalid|unavailable|storage/i);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('reruns one saved segment with identical PCM in isolated whole-file Whisper without other sources', async () => {
    const { capture } = await fixture();
    capture.configure(true);
    const pcm = new Float32Array(3200).fill(0.35);
    const id = storeSample(capture, 'caster', pcm)!;
    await capture.complete(id, { error: new Error('initial worker failure'), durationMs: 19 });
    capture.configure(false);
    const transcribe = vi.fn(async (samples: Float32Array) => {
      expect(samples.length).toBe(pcm.length);
      expect(samples[0]).toBeCloseTo(0.35);
      return 'recovered text';
    });
    const service = new SpeechPlaygroundService(
      () =>
        ({
          start: async () => {},
          stop: () => {},
          transcribe,
          shutdown: async () => {},
          subscribe: () => () => {},
        }) as unknown as NativeSpeech,
      () => true,
      Date.now,
      capture,
    );
    const snapshot = await service.rerunCaptured(id);
    expect(snapshot.segments).toMatchObject([
      { sourceId: 'caster', label: 'Caster', text: 'recovered text', phase: 'transcribed' },
    ]);
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(capture.status().records).toHaveLength(1);
    await service.stop();
  });
});
