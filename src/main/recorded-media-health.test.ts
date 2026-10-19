import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PREFERENCES, type SessionSnapshot } from '../shared/session-contract';
import type { RecordedScenarioConfig } from '../shared/recorded-scenario-contract';
import { validateRecordedMediaIssue } from '../shared/recorded-media-health';
import { reportRecordedMediaIssue } from './recorded-media-health';

const config: RecordedScenarioConfig = {
  context: 'A test scene',
  mode: 'fake',
  video: { path: '/tmp/video.mp4' },
  audio: [
    {
      id: 'guest',
      kind: 'file',
      path: '/tmp/guest.wav',
      enabled: true,
      label: 'Guest',
      offsetMs: 0,
      embeddedTrackIndex: null,
    },
    {
      id: 'disabled',
      kind: 'file',
      path: '/tmp/disabled.wav',
      enabled: false,
      label: 'Disabled',
      offsetMs: 0,
      embeddedTrackIndex: null,
    },
  ],
  segment: { startMs: 0, endMs: null },
  transcriptMode: 'transcribe',
  publishToOverlay: false,
  seed: null,
  presetId: null,
  presetRevision: null,
  modelId: null,
  settingsSnapshot: DEFAULT_PREFERENCES,
  settingsPolicy: 'current',
};
const run = { id: 'run-uuid', sessionRunId: 42, config };
const state = {
  runId: 42,
  phase: 'running',
  inputMode: 'recorded',
  failureKind: null,
} as unknown as SessionSnapshot;

describe('source-safe recorded media diagnostics', () => {
  const sinks = () => ({
    media: { failRecordedMedia: vi.fn(() => ({ ...state, phase: 'error' }) as SessionSnapshot) },
    logger: { warn: vi.fn(), error: vi.fn() },
  });

  it('correlates dropped video frames and variable presentation-delay metrics with the Run and source', () => {
    const { media, logger } = sinks();
    const frames = {
      kind: 'video' as const,
      sourceId: 'recorded:video',
      code: 'frame-drop' as const,
      fatal: false,
      count: 6,
    };
    expect(reportRecordedMediaIssue(frames, run, state, media, logger)).toBe(state);
    expect(logger.warn).toHaveBeenCalledWith(
      'media',
      expect.stringContaining('dropped decoded frames'),
      undefined,
      {
        runId: 42,
        recordedRunId: 'run-uuid',
        sourceId: 'recorded:video',
        sourceKind: 'video',
        code: 'frame-drop',
        count: 6,
      },
    );
    reportRecordedMediaIssue(
      { ...frames, code: 'decode-delay', count: 1250 },
      run,
      state,
      media,
      logger,
    );
    expect(logger.warn).toHaveBeenLastCalledWith(
      'media',
      expect.stringContaining('decoder fell behind'),
      undefined,
      expect.objectContaining({
        code: 'decode-delay',
        count: 1250,
        sourceId: 'recorded:video',
      }),
    );
    expect(media.failRecordedMedia).not.toHaveBeenCalled();
  });

  it('fails only enabled sources, identifies the audio source and does not write private media content', () => {
    const { media, logger } = sinks();
    expect(
      reportRecordedMediaIssue(
        {
          kind: 'audio',
          sourceId: 'guest',
          code: 'stall',
          fatal: true,
        },
        run,
        state,
        media,
        logger,
      ).phase,
    ).toBe('error');
    expect(media.failRecordedMedia).toHaveBeenCalledWith('Guest', 'decoder or playback stalled');
    expect(logger.error).toHaveBeenCalledWith(
      'media',
      'Recorded audio decoder or playback stalled',
      undefined,
      expect.objectContaining({
        runId: 42,
        recordedRunId: 'run-uuid',
        sourceId: 'guest',
        sourceKind: 'audio',
      }),
    );
    expect(() =>
      reportRecordedMediaIssue(
        {
          kind: 'audio',
          sourceId: 'disabled',
          code: 'decoder',
          fatal: true,
        },
        run,
        state,
        media,
        logger,
      ),
    ).toThrow(/not enabled/);
    expect(() =>
      reportRecordedMediaIssue(
        {
          kind: 'video',
          sourceId: 'other',
          code: 'decoder',
          fatal: true,
        },
        run,
        state,
        media,
        logger,
      ),
    ).toThrow(/not enabled/);
    expect(media.failRecordedMedia).toHaveBeenCalledTimes(1);
  });

  it('rejects stale, completed or malicious renderer reports without misattributing a Run', () => {
    const { media, logger } = sinks();
    const diagnostic = {
      kind: 'audio' as const,
      sourceId: 'guest',
      code: 'segment' as const,
      fatal: true,
    };
    expect(() => reportRecordedMediaIssue(diagnostic, null, state, media, logger)).toThrow(
      /No active/,
    );
    expect(() =>
      reportRecordedMediaIssue(diagnostic, run, { ...state, runId: 43 }, media, logger),
    ).toThrow(/No active/);
    expect(() =>
      reportRecordedMediaIssue(diagnostic, run, { ...state, phase: 'stopped' }, media, logger),
    ).toThrow(/no longer accepting/);
    expect(() => validateRecordedMediaIssue({ ...diagnostic, sourceId: '../../secret' })).toThrow(
      /Invalid/,
    );
    expect(() => validateRecordedMediaIssue({ ...diagnostic, transcript: 'private' })).toThrow(
      /Invalid/,
    );
    expect(() => validateRecordedMediaIssue({ ...diagnostic, count: Infinity })).toThrow(/Invalid/);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
