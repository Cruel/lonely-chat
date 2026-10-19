import { describe, expect, it } from 'vitest';
import {
  previewMediaPosition,
  previewMonitorGain,
  recordedPreviewDuration,
  resolveRecordedSegment,
  type PreviewTrack,
} from './recorded-preview-timeline';

const track = (overrides: Partial<PreviewTrack>): PreviewTrack => ({
  id: 'mic',
  url: 'blob:mic',
  label: 'Microphone',
  enabled: true,
  offsetMs: 0,
  durationMs: 10000,
  embeddedTrackIndex: null,
  ...overrides,
});

describe('pre-run timeline', () => {
  it('aligns directly to presentation timestamps, including irregular video frame times', () => {
    const timestamps = [0, 41, 53, 127, 371, 513];
    expect(timestamps.map((timestamp) => previewMediaPosition(timestamp, 75, 1000))).toEqual([
      null,
      null,
      null,
      52,
      296,
      438,
    ]);
    expect(previewMediaPosition(500, -250, 1000)).toBe(750);
    expect(previewMediaPosition(1000, -250, 1000)).toBeNull();
    expect(previewMediaPosition(25, 500, 1000)).toBeNull();
  });

  it('defaults to the longest enabled source including signed offsets, ignoring missing or disabled tracks', () => {
    const tracks = [
      track({ id: 'short', durationMs: 5000, offsetMs: -2000 }),
      track({ id: 'late', durationMs: 4000, offsetMs: 6000 }),
      track({ id: 'disabled', durationMs: 50000, enabled: false }),
      track({ id: 'undecoded', durationMs: null, offsetMs: 20000 }),
    ];
    expect(recordedPreviewDuration(8000, tracks)).toBe(10000);
    expect(recordedPreviewDuration(8000, [], 1750)).toBe(9750);
    expect(recordedPreviewDuration(8000, [], -750)).toBe(7250);
    expect(recordedPreviewDuration(null, [track({ offsetMs: -5000 })])).toBe(5000);
    expect(recordedPreviewDuration(null, [track({ enabled: false })])).toBe(0);
    expect(resolveRecordedSegment({ startMs: 2500, endMs: null }, 10000)).toEqual({
      startMs: 2500,
      endMs: 10000,
    });
  });

  it('validates millisecond-precision bounds and rejects empty, reversed and out-of-range clips', () => {
    expect(resolveRecordedSegment({ startMs: 2, endMs: 3 }, 10)).toEqual({
      startMs: 2,
      endMs: 3,
    });
    expect(resolveRecordedSegment({ startMs: -1, endMs: 5 }, 10)).toBeNull();
    expect(resolveRecordedSegment({ startMs: 7, endMs: 7 }, 10)).toBeNull();
    expect(resolveRecordedSegment({ startMs: 8, endMs: 5 }, 10)).toBeNull();
    expect(resolveRecordedSegment({ startMs: 5, endMs: 11 }, 10)).toBeNull();
    expect(resolveRecordedSegment({ startMs: 2.5, endMs: 8 }, 10)).toBeNull();
    expect(resolveRecordedSegment({ startMs: 0, endMs: null }, 0)).toBeNull();
  });

  it('keeps monitoring gain independent of track data and defaults fully muted', () => {
    expect(previewMonitorGain(true, true, true, 1)).toBe(0);
    expect(previewMonitorGain(false, false, true, 1)).toBe(0);
    expect(previewMonitorGain(false, true, true, 0.35)).toBe(0.35);
    expect(previewMonitorGain(false, false, false, 0.8)).toBe(0.8);
  });
});
