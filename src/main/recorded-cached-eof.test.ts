import { expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AudioService } from './audio-service';
import { RecordedTranscriptCache } from './recorded-transcript-cache';
import { FakeClock, flushMicrotasks } from './test-support/fake-clock';

it('holds cached transcripts during pause and awaits their delayed availability at EOF', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'lonely-cache-eof-'));
  try {
    const cache = new RecordedTranscriptCache(directory);
    const query = {
      fingerprint: 'ab'.repeat(32),
      offsetMs: 0,
      startMs: 1000,
      endMs: 5000,
      embeddedTrackIndex: null,
      sampleRate: 16000,
    };
    await cache.save(query, 'speech', [
      { text: 'last words', observedMs: 2500, availableMs: 3000 },
    ]);
    const clock = new FakeClock();
    const transcript = vi.fn();
    const spawn = vi.fn();
    const audio = new AudioService(
      spawn,
      transcript,
      clock.wallNow,
      clock,
      undefined,
      cache,
      () => 'speech',
    );
    await audio.startRecorded({
      id: 'source-one',
      label: 'First recording',
      captureId: 'capture-one',
      offsetMs: 0,
      seekMs: 1000,
      sampleRate: 16000,
      cache: { ...query, mode: 'cached' },
    });
    audio.armRecorded('capture-one', clock.wallNow() - 1000, 1000);
    clock.advance(500);
    audio.pauseRecorded();
    let drained = false;
    const eof = audio.finishRecorded('capture-one').then(() => {
      drained = true;
    });
    clock.advance(5000);
    await flushMicrotasks();
    expect(transcript).not.toHaveBeenCalled();
    expect(drained).toBe(false);
    audio.resumeRecorded();
    clock.advance(1499);
    await flushMicrotasks();
    expect(transcript).not.toHaveBeenCalled();
    clock.advance(1);
    await eof;
    expect(drained).toBe(true);
    expect(transcript).toHaveBeenCalledOnce();
    expect(transcript.mock.calls[0][0].text).toBe('last words');
    expect(transcript.mock.calls[0][0].sourceId).toBe('source-one');
    expect(spawn).not.toHaveBeenCalled();
    await audio.terminate();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
