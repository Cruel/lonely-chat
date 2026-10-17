import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFERENCES } from '../shared/session-contract';
import { VideoFrameBuffer } from './video-frame-buffer';

const frame = (at: number, sourceId = 'camera:123') => ({
  sourceId,
  observedAt: at,
  width: 2,
  height: 2,
  dataUrl: 'data:image/jpeg;base64,/9j/',
});

describe('temporal frame sampling', () => {
  it('selects more frames for long intervals than short intervals and always covers their endpoints', () => {
    const ring = new VideoFrameBuffer();
    ring.selectSource('camera:123');
    for (let at = 0; at <= 60_000; at += 500) ring.push(frame(at), at);
    expect(ring.size).toBe(121);

    const short = ring.sample(57_000, 60_000, false);
    expect(short).toMatchObject({ fromMs: 57_000, throughMs: 60_000, truncated: false });
    expect(short.frames.map((item) => item.observedAt)).toEqual([
      57_500, 58_000, 58_500, 59_000, 59_500, 60_000,
    ]);
    const long = ring.sample(30_000, 60_000, false);
    expect(long.frames).toHaveLength(24);
    expect(long.frames[0].observedAt).toBe(30_500);
    expect(long.frames.at(-1)?.observedAt).toBe(60_000);
    expect(new Set(long.frames.map((item) => item.observedAt)).size).toBe(24);
    expect(long.frames.map((item) => item.observedAt)).toEqual(
      long.frames.map((item) => item.observedAt).sort((a, b) => a - b),
    );
  });

  it('supports changing cadence, coverage, minimum/maximum and policy without fabricating missing frames', () => {
    const ring = new VideoFrameBuffer({
      ...DEFAULT_PREFERENCES,
      videoCaptureIntervalMs: 1000,
      videoCoverageMs: 10000,
      videoMinFrames: 4,
      videoMaxFrames: 8,
    });
    ring.selectSource('camera:123');
    for (let at = 20_000; at <= 40_000; at += 500) ring.push(frame(at), at);
    const clipped = ring.sample(10_000, 40_000, false);
    expect(clipped).toMatchObject({ fromMs: 30_000, throughMs: 40_000, truncated: true });
    expect(clipped.frames).toHaveLength(8);
    expect(clipped.frames[0].observedAt).toBe(30_000);
    expect(clipped.frames.at(-1)?.observedAt).toBe(40_000);

    ring.configure(
      {
        ...DEFAULT_PREFERENCES,
        videoCaptureIntervalMs: 2000,
        videoCoverageMs: 10000,
        videoMinFrames: 2,
        videoMaxFrames: 8,
        videoSamplingStrategy: 'recent-weighted',
      },
      40_000,
    );
    const weighted = ring.sample(30_000, 40_000, false);
    expect(weighted.frames).toHaveLength(5);
    expect(weighted.frames[0].observedAt).toBe(30_500);
    expect(weighted.frames.at(-1)?.observedAt).toBe(40_000);
    expect(weighted.frames[1].observedAt).toBeGreaterThan(clipped.frames[1].observedAt);

    ring.selectSource('screen:1');
    ring.push(frame(40_000, 'screen:1'), 40_000);
    expect(ring.sample(39_000, 40_000, false).frames).toHaveLength(1);
    ring.selectSource(null);
    expect(ring.sample(40_000, 41_000, false).frames).toEqual([]);
  });

  it('does not replay a snapshot boundary, reorder timestamps or duplicate a sparse sample', () => {
    const ring = new VideoFrameBuffer({ ...DEFAULT_PREFERENCES, videoMinFrames: 16 });
    ring.selectSource('camera:123');
    ring.push(frame(5000), 5000);
    ring.push(frame(5000), 5000);
    ring.push(frame(6000), 6000);
    expect(ring.sample(5000, 6000, false).frames.map((item) => item.observedAt)).toEqual([6000]);
    expect(ring.sample(6000, 6000, false).frames).toEqual([]);
    expect(ring.sample(5500, 5500, true).frames.map((item) => item.observedAt)).toEqual([5000]);

    expect(() => ring.push(frame(5500, 'camera:wrong'), 5500)).toThrow(/inactive/);
    expect(() =>
      ring.push({ ...frame(5500), dataUrl: 'data:text/html;base64,AA' }, 5500),
    ).toThrow();
    expect(() =>
      ring.push({ ...frame(5500), dataUrl: 'data:image/jpeg;base64,' + 'A'.repeat(130_000) }, 5500),
    ).toThrow();
    expect(() => ring.sample(6000, 5000, false)).toThrow(/interval/);
  });

  it('chooses the freshest available frame when limited to a single sample', () => {
    const ring = new VideoFrameBuffer({
      ...DEFAULT_PREFERENCES,
      videoCaptureIntervalMs: 5000,
      videoMinFrames: 1,
      videoMaxFrames: 1,
    });
    ring.selectSource('camera:123');
    ring.push(frame(500), 500);
    ring.push(frame(1000), 1000);
    ring.push(frame(1500), 1500);
    expect(ring.sample(0, 1500, false).frames.map((item) => item.observedAt)).toEqual([1500]);
  });

  it('offers a replaceable sampler without changing the ring or inference call sites', () => {
    const seen: number[] = [];
    const ring = new VideoFrameBuffer(DEFAULT_PREFERENCES, {
      uniform: (frames, count) => {
        seen.push(count);
        return frames.slice(-count);
      },
      'recent-weighted': (frames) => frames.slice(-1),
    });
    ring.selectSource('camera:123');
    for (let at = 500; at <= 3000; at += 500) ring.push(frame(at), at);
    const result = ring.sample(0, 3000, false);
    expect(seen).toEqual([6]);
    expect(result.frames.map((item) => item.observedAt)).toEqual([
      500, 1000, 1500, 2000, 2500, 3000,
    ]);
  });
});
