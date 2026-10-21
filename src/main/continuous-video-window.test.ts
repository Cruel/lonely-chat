import { describe, expect, it } from 'vitest';
import { selectContinuousVideoWindow } from './continuous-video-window';
import type { VideoFrame } from '../shared/video-contract';

const frame = (observedAt: number, sourceId = 'camera', mediaTimeMs?: number): VideoFrame => ({
  observedAt,
  sourceId,
  width: 8,
  height: 8,
  dataUrl: 'data:image/jpeg;base64,/9j/',
  ...(mediaTimeMs === undefined ? {} : { mediaTimeMs }),
});

describe('native video window selection', () => {
  it('clips a live window to the selected time range without changing source identity', () => {
    const result = selectContinuousVideoWindow(
      [frame(1000), frame(3000), frame(9000), frame(11000)],
      0,
      11000,
      5000,
    );
    expect(result?.frames.map((f) => f.observedAt)).toEqual([9000, 11000]);
    expect(result?.timeline.map((f) => f.outputOffsetMs)).toEqual([0, 2000]);
    expect(result?.sourceId).toBe('camera');
  });
  it('aligns recorded frames to media time independently of wall-clock timestamps', () => {
    const result = selectContinuousVideoWindow(
      [frame(100, 'recording', 5000), frame(200, 'recording', 5200)],
      0,
      200,
    );
    expect(result?.timeline.map((f) => f.outputOffsetMs)).toEqual([0, 200]);
  });
  it('rejects a discontinuous recording or mixed sources', () => {
    expect(() => selectContinuousVideoWindow([frame(10), frame(20, 'other')], 0, 20)).toThrow(
      /mixed/,
    );
    expect(() =>
      selectContinuousVideoWindow([frame(10, 'recorded', 200), frame(20, 'recorded', 100)], 0, 20),
    ).toThrow(/discontinuous/);
  });
  it('rejects unbounded windows and oversized frame collections', () => {
    expect(() => selectContinuousVideoWindow([frame(1)], 0, 1, 61_000)).toThrow(/limits/);
    expect(() => selectContinuousVideoWindow([frame(1), frame(2)], 0, 2, 15000, 1)).toThrow(
      /frame limit/,
    );
  });
  it('returns null if the cycle has no eligible frames', () => {
    expect(selectContinuousVideoWindow([frame(10)], 20, 30)).toBeNull();
  });
});
