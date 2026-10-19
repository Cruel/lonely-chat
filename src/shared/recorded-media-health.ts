/** Renderer-reported observations. Main supplies the authoritative Run correlation IDs.
 * Never send paths, transcripts, PCM, or media bytes as operational diagnostics.
 */
export interface RecordedMediaIssue {
  readonly kind: 'video' | 'audio';
  readonly sourceId: string;
  readonly code: 'decoder' | 'stall' | 'frame-drop' | 'decode-delay' | 'pcm-overflow' | 'segment';
  readonly fatal: boolean;
  /** A bounded count (frames, milliseconds, or queued PCM chunks depending on code). */
  readonly count?: number;
}

export function validateRecordedMediaIssue(value: unknown): RecordedMediaIssue {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid recorded media diagnostic.');
  const input = value as Record<string, unknown>;
  if (
    (input.kind !== 'audio' && input.kind !== 'video') ||
    typeof input.sourceId !== 'string' ||
    !/^[a-zA-Z0-9:_-]{1,100}$/.test(input.sourceId) ||
    !['decoder', 'stall', 'frame-drop', 'decode-delay', 'pcm-overflow', 'segment'].includes(
      String(input.code),
    ) ||
    typeof input.fatal !== 'boolean' ||
    (input.count !== undefined &&
      (typeof input.count !== 'number' ||
        !Number.isSafeInteger(input.count) ||
        input.count < 0 ||
        input.count > 86_400_000)) ||
    Object.keys(input).some((key) => !['kind', 'sourceId', 'code', 'fatal', 'count'].includes(key))
  )
    throw new Error('Invalid recorded media diagnostic.');
  return input as unknown as RecordedMediaIssue;
}

export function recordedMediaIssueText(issue: RecordedMediaIssue): string {
  const reason: Record<RecordedMediaIssue['code'], string> = {
    decoder: 'decoder failed or codec is unsupported',
    stall: 'decoder or playback stalled',
    'frame-drop': 'Chromium reported dropped decoded frames',
    'decode-delay': 'decoder fell behind the playback timeline',
    'pcm-overflow': 'PCM submission queue overflowed',
    segment: 'audio segment or worklet processing failed',
  };
  return reason[issue.code];
}
