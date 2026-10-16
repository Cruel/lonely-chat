import { describe, expect, it } from 'vitest';
import { VideoFrameBuffer } from './video-frame-buffer';

const frame = (at: number, sourceId = 'camera:123') => ({
  sourceId,
  observedAt: at,
  width: 2,
  height: 2,
  dataUrl: 'data:image/jpeg;base64,/9j/',
});

describe('video frame buffer', () => {
  it('retains only recent bounded images and samples full short and long intervals', () => {
    const ring = new VideoFrameBuffer();
    ring.selectSource('camera:123');
    for (let at = 0; at <= 60_000; at += 500) ring.push(frame(at), at);
    expect(ring.size).toBeLessThanOrEqual(90);
    const short = ring.sample(57_000, 60_000, false);
    expect(short.map((item) => item.observedAt)).toEqual([
      57_000, 57_500, 58_000, 58_500, 59_000, 59_500, 60_000,
    ]);
    const long = ring.sample(30_000, 60_000, false);
    expect(long).toHaveLength(8);
    expect(long[0].observedAt).toBe(30_000);
    expect(long[7].observedAt).toBe(60_000);
  });

  it('supplies a preview baseline, isolates sources and refuses invalid media', () => {
    const ring = new VideoFrameBuffer();
    ring.selectSource('camera:123');
    ring.push(frame(5000), 5000);
    expect(ring.sample(5500, 5500, true).map((item) => item.observedAt)).toEqual([5000]);
    expect(ring.sample(5500, 5500, false)).toEqual([]);
    ring.selectSource('screen:1');
    expect(ring.size).toBe(0);
    expect(() => ring.push(frame(5500), 5500)).toThrow(/inactive/);
    expect(() =>
      ring.push({ ...frame(5500, 'screen:1'), dataUrl: 'data:text/html;base64,AA' }, 5500),
    ).toThrow();
    expect(() =>
      ring.push(
        { ...frame(5500, 'screen:1'), dataUrl: 'data:image/jpeg;base64,' + 'A'.repeat(130_000) },
        5500,
      ),
    ).toThrow();
    ring.push(frame(6000, 'screen:1'), 6000);
    ring.selectSource(null);
    expect(ring.size).toBe(0);
  });
});
