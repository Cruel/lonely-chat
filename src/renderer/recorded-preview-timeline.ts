export interface RecordedSegment {
  startMs: number;
  /** null means run to the end of the longest enabled source. */
  endMs: number | null;
}

export interface PreviewTrack {
  id: string;
  url: string;
  label: string;
  enabled: boolean;
  offsetMs: number;
  durationMs: number | null;
  embeddedTrackIndex: number | null;
}

export function recordedPreviewDuration(
  videoDurationMs: number | null,
  tracks: readonly PreviewTrack[],
): number {
  return Math.max(
    0,
    Number.isFinite(videoDurationMs) ? (videoDurationMs ?? 0) : 0,
    ...tracks
      .filter((track) => track.enabled && track.durationMs !== null)
      .map((track) => Math.max(0, track.offsetMs + track.durationMs!)),
  );
}

export function resolveRecordedSegment(
  segment: RecordedSegment,
  durationMs: number,
): { startMs: number; endMs: number } | null {
  const { startMs } = segment;
  const endMs = segment.endMs ?? durationMs;
  if (
    !Number.isSafeInteger(startMs) ||
    !Number.isSafeInteger(endMs) ||
    startMs < 0 ||
    endMs <= startMs ||
    endMs > durationMs
  )
    return null;
  return { startMs, endMs };
}

/** A presentation timestamp is authoritative, not a frame count or nominal frame rate. */
export function previewMediaPosition(
  presentationMs: number,
  offsetMs: number,
  durationMs: number,
): number | null {
  const mediaMs = presentationMs - offsetMs;
  return Number.isFinite(mediaMs) &&
    Number.isFinite(durationMs) &&
    mediaMs >= 0 &&
    mediaMs < durationMs
    ? mediaMs
    : null;
}

export function previewMonitorGain(
  muted: boolean,
  solo: boolean,
  anySolo: boolean,
  volume: number,
): number {
  return !muted && (!anySolo || solo) ? Math.min(1, Math.max(0, volume)) : 0;
}
