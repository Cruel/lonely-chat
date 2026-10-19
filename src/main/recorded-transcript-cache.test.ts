import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AudioService } from './audio-service';
import type { NativeSpeech } from './native-speech';
import { RecordedTranscriptCache } from './recorded-transcript-cache';
import { FakeClock, flushMicrotasks } from './test-support/fake-clock';
import { InferenceHistory } from './inference-history';
import type { TranscriptCacheQuery } from '../shared/recorded-transcript-cache';

const directories: string[] = [];
const temporary = () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'lonely-transcripts-'));
  directories.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const query: TranscriptCacheQuery = {
  fingerprint: 'ab'.repeat(32),
  offsetMs: -250,
  startMs: 1000,
  endMs: 5000,
  embeddedTrackIndex: null,
  sampleRate: 16000,
};

describe('opt-in recorded transcript caching', () => {
  it('validates media, offsets, segments, model and configuration across app restarts without persisting PCM', async () => {
    const directory = temporary();
    const cache = new RecordedTranscriptCache(directory);
    expect(cache.check(query, 'whisper-A').reason).toBe('unavailable');
    await cache.save(query, 'whisper-A', [{ text: 'hello', observedMs: 2250, availableMs: 2500 }]);
    const fresh = new RecordedTranscriptCache(directory);
    expect(fresh.check(query, 'whisper-A')).toEqual({
      available: true,
      reason: 'ready',
      count: 1,
    });
    expect(fresh.check({ ...query, offsetMs: -249 }, 'whisper-A').reason).toBe('stale');
    expect(fresh.check({ ...query, startMs: 900 }, 'whisper-A').reason).toBe('stale');
    expect(fresh.check({ ...query, endMs: 5100 }, 'whisper-A').reason).toBe('stale');
    expect(fresh.check({ ...query, sampleRate: 48000 }, 'whisper-A').reason).toBe('stale');
    expect(fresh.check({ ...query, embeddedTrackIndex: 1 }, 'whisper-A').reason).toBe('stale');
    expect(fresh.check(query, 'whisper-B').reason).toBe('stale');
    expect(fresh.check({ ...query, fingerprint: 'cd'.repeat(32) }, 'whisper-A').reason).toBe(
      'unavailable',
    );
    expect(() => fresh.read(query, 'whisper-B')).toThrow(/stale/);
    const contents = readFileSync(path.join(directory, 'recorded-transcripts.json'), 'utf8');
    expect(contents).toContain('hello');
    expect(contents).not.toContain('samples');
    expect(contents).not.toContain('pcm');
    expect(contents).not.toContain('/home/');
  });

  it('rejects malformed or damaged persisted text caches rather than silently accepting them', () => {
    const directory = temporary();
    writeFileSync(
      path.join(directory, 'recorded-transcripts.json'),
      '{"version":1,"entries":[{"key":"broken"}]}',
    );
    const cache = new RecordedTranscriptCache(directory);
    expect(cache.check(query, 'whisper-A').reason).toBe('invalid');
    expect(() => cache.read(query, 'whisper-A')).toThrow(/unavailable/);
  });

  it('waits for late Whisper replies at EOF and plays them into production history only when available', async () => {
    const cache = new RecordedTranscriptCache(temporary());
    const clock = new FakeClock();
    const full: Array<{ sourceId?: string; source: string; text: string; observedAt: number }> = [];
    let resolveSpeech: (text: string) => void = () => {};
    const worker = {
      start: async () => {},
      stop: () => {},
      transcribe: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolveSpeech = resolve;
          }),
      ),
    };
    const spawn = vi.fn(() => worker as unknown as NativeSpeech);
    const audio = new AudioService(
      spawn,
      (entry) => full.push(entry),
      clock.wallNow,
      clock,
      undefined,
      cache,
      () => 'whisper-A',
    );
    await audio.startRecorded({
      id: 'guest',
      captureId: 'original',
      label: 'Discord guest',
      sampleRate: 16000,
      offsetMs: -250,
      seekMs: 1250,
      cache: { ...query, mode: 'save' },
    });
    const firstOrigin = clock.wallNow() - 1000;
    audio.armRecorded('original', firstOrigin, 1250);
    // Production resampling/VAD, not an invented transcript or whole-file shortcut.
    for (let n = 0; n < 18; n++) {
      clock.advance(100);
      audio.pushRecorded(new Float32Array(1600).fill(n < 9 ? 0.2 : 0), 'original');
    }
    expect(worker.transcribe).toHaveBeenCalled();
    let completed = false;
    const ending = audio.finishRecorded('original').then(() => {
      completed = true;
    });
    await flushMicrotasks();
    expect(completed).toBe(false);
    clock.advance(1000);
    resolveSpeech('Guest speaking');
    await ending;
    expect(full).toHaveLength(1);
    const originalRelative = full[0].observedAt - firstOrigin;
    const saved = cache.read(query, 'whisper-A');
    expect(saved).toEqual([
      { text: 'Guest speaking', observedMs: originalRelative, availableMs: 3800 },
    ]);
    expect(completed).toBe(true);
    audio.stop();

    const history = new InferenceHistory({ historyMaxCount: 50, historyMaxAgeMs: 20000 });
    const emitted: Array<{ sourceId?: string; source: string; text: string; observedAt: number }> =
      [];
    const cached = new AudioService(
      spawn,
      (entry) => {
        emitted.push(entry);
        history.recordTranscript(entry, clock.wallNow());
      },
      clock.wallNow,
      clock,
      undefined,
      cache,
      () => 'whisper-A',
    );
    await cached.startRecorded({
      id: 'guest',
      captureId: 'replay',
      label: 'Discord guest',
      sampleRate: 16000,
      offsetMs: -250,
      seekMs: 1250,
      cache: { ...query, mode: 'cached' },
    });
    expect(spawn).toHaveBeenCalledTimes(1); // cached playback never starts Whisper
    const origin = clock.wallNow() - 1000;
    history.reset(clock.wallNow());
    cached.armRecorded('replay', origin, 1250);
    clock.advance(2799);
    expect(emitted).toHaveLength(0);
    clock.advance(1);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toEqual({
      sourceId: 'guest',
      source: 'Discord guest',
      text: 'Guest speaking',
      observedAt: origin + originalRelative,
    });
    const input = history.snapshot('scene', 1, clock.wallNow(), 3000, []);
    expect(input.recentTranscripts).toEqual(emitted);
    expect(() => cached.pushRecorded(new Float32Array(1600), 'replay')).toThrow(/does not accept/);
    cached.stop();
    clock.advance(10000);
    expect(emitted).toHaveLength(1);
    await audio.terminate();
    await cached.terminate();
  });

  it('replays independent labeled sources at their actual availability times and orders the history by observation', async () => {
    const cache = new RecordedTranscriptCache(temporary());
    const laterObserved = { ...query, fingerprint: 'ef'.repeat(32) };
    const earlierObserved = { ...query, fingerprint: 'cd'.repeat(32), offsetMs: 0 };
    await cache.save(laterObserved, 'model', [
      { text: 'later scene', observedMs: 1700, availableMs: 2100 },
      { text: 'not yet', observedMs: 2700, availableMs: 3400 },
    ]);
    await cache.save(earlierObserved, 'model', [
      { text: 'earlier scene', observedMs: 1200, availableMs: 2400 },
    ]);
    const clock = new FakeClock();
    const history = new InferenceHistory({ historyMaxCount: 50, historyMaxAgeMs: 20000 });
    const spawn = vi.fn();
    const audio = new AudioService(
      spawn,
      (entry) => history.recordTranscript(entry, clock.wallNow()),
      clock.wallNow,
      clock,
      undefined,
      cache,
      () => 'model',
    );
    for (const [descriptor, id, label, captureId] of [
      [laterObserved, 'guest', 'Guest', 'guest-capture'],
      [earlierObserved, 'host', 'Host', 'host-capture'],
    ] as const) {
      await audio.startRecorded({
        id,
        label,
        captureId,
        offsetMs: descriptor.offsetMs,
        sampleRate: 16000,
        seekMs: descriptor.startMs - descriptor.offsetMs,
        cache: { ...descriptor, mode: 'cached' },
      });
    }
    const origin = clock.wallNow() - 1000;
    history.reset(clock.wallNow());
    audio.armRecorded('guest-capture', origin, 1250);
    audio.armRecorded('host-capture', origin, 1000);
    clock.advance(1099);
    expect(history.snapshot('', 0, clock.wallNow(), 3000, []).recentTranscripts).toEqual([]);
    clock.advance(1);
    expect(
      history
        .snapshot('', 0, clock.wallNow(), 3000, [])
        .recentTranscripts?.map((entry) => entry.source),
    ).toEqual(['Guest']);
    clock.advance(300);
    const observed = history.snapshot('', 0, clock.wallNow(), 3000, []).recentTranscripts;
    expect(observed?.map((entry) => [entry.sourceId, entry.source, entry.text])).toEqual([
      ['host', 'Host', 'earlier scene'],
      ['guest', 'Guest', 'later scene'],
    ]);
    audio.stop();
    clock.advance(2000);
    expect(history.snapshot('', 0, clock.wallNow(), 3000, []).recentTranscripts).toHaveLength(2);
    expect(spawn).not.toHaveBeenCalled();
    await audio.terminate();
  });
});
