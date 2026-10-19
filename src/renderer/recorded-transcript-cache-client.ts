import type {
  RecordedTranscriptMode,
  TranscriptCacheQuery,
} from '../shared/recorded-transcript-cache';
import { resolveRecordedSegment, type RecordedSegment } from './recorded-preview-timeline';
import { mediaFingerprint } from './media-fingerprint';

export interface CacheSource {
  readonly kind: 'file' | 'video';
  readonly file: File | null;
  readonly enabled: boolean;
  readonly durationMs: number | null;
  readonly label: string;
  readonly offsetMs: number;
  readonly embeddedTrackIndex: number | null;
}

export async function recordedCacheQuery(
  source: CacheSource,
  sampleRate: number,
  segment: RecordedSegment,
  durationMs: number,
): Promise<TranscriptCacheQuery> {
  const range = resolveRecordedSegment(segment, durationMs);
  if (!range) throw new Error('Select a valid recorded segment before using transcript caching.');
  if (!source.file) throw new Error('Recorded media file is unavailable for caching.');
  return {
    fingerprint: await mediaFingerprint(source.file),
    sampleRate,
    offsetMs: source.offsetMs,
    startMs: range.startMs,
    endMs: range.endMs,
    embeddedTrackIndex: source.kind === 'video' ? source.embeddedTrackIndex : null,
  };
}

export async function verifyRecordedCaches(
  mode: RecordedTranscriptMode,
  tracks: readonly CacheSource[],
  segment: RecordedSegment,
  durationMs: number,
  check: (query: TranscriptCacheQuery) => Promise<{ available: boolean; reason: string }>,
): Promise<void> {
  if (mode === 'transcribe') return;
  const selected = tracks.filter((track) => track.enabled && track.durationMs !== null);
  if (mode === 'cached' && selected.length === 0)
    throw new Error('Add an audio source before selecting cached transcript playback.');
  if (selected.length === 0) return;
  const context = new AudioContext();
  const sampleRate = context.sampleRate;
  await context.close();
  for (const track of selected) {
    const query = await recordedCacheQuery(track, sampleRate, segment, durationMs);
    if (mode !== 'cached') continue;
    const result = await check(query);
    if (!result.available) {
      const reason =
        result.reason === 'stale'
          ? 'stale (source offset, segment, speech model or processing settings changed)'
          : result.reason === 'invalid'
            ? 'invalid or damaged'
            : 'unavailable';
      throw new Error(
        `Saved transcripts for ${track.label} are ${reason}. Run real Whisper with “Transcribe and save” first.`,
      );
    }
  }
}
