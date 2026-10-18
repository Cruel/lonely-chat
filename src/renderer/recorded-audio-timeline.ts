/** One media timeline for video and arbitrarily offset file-backed audio sources. */
export function recordedAudioPosition(
  offsetMs: number,
  elapsedMs: number,
  durationMs: number,
): { mediaMs: number; delayMs: number } | null {
  if (![offsetMs, elapsedMs, durationMs].every(Number.isFinite) || durationMs <= 0) return null;
  const mediaMs = Math.max(0, elapsedMs - offsetMs);
  if (mediaMs >= durationMs) return null;
  return { mediaMs, delayMs: Math.max(0, offsetMs - elapsedMs) };
}
