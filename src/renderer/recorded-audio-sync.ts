import { recordedAudioPosition } from './recorded-audio-timeline';

export const AUDIO_DRIFT_TOLERANCE_MS = 180;
export const AUDIO_STALL_TIMEOUT_MS = 7_000;
const SEEK_TIMEOUT_MS = 5_000;

/** Wait for the decoder to honor the actual media seek, not just the seek assignment. */
export async function seekRecordedMedia(
  audio: HTMLMediaElement,
  milliseconds: number,
): Promise<void> {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new Error('Invalid media seek.');
  if (Math.abs(audio.currentTime * 1000 - milliseconds) > 30)
    audio.currentTime = milliseconds / 1000;
  if (!audio.seeking && audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return;
  await new Promise<void>((resolve, reject) => {
    const clear = () => {
      clearTimeout(timer);
      audio.removeEventListener('seeked', check);
      audio.removeEventListener('loadeddata', check);
      audio.removeEventListener('canplay', check);
      audio.removeEventListener('error', error);
    };
    const check = () => {
      if (audio.seeking || audio.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
      clear();
      resolve();
    };
    const error = () => {
      clear();
      reject(new Error('Recorded audio decode failed during seek.'));
    };
    const timer = setTimeout(() => {
      clear();
      reject(new Error('Recorded audio seek/readiness timed out.'));
    }, SEEK_TIMEOUT_MS);
    audio.addEventListener('seeked', check);
    audio.addEventListener('loadeddata', check);
    audio.addEventListener('canplay', check);
    audio.addEventListener('error', error);
    check();
  });
}

/** AudioContext resume can also wait indefinitely for a suspended audio device. */
export async function resumeRecordedContext(context: AudioContext): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      context.resume(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Recorded audio output context timed out.')),
          AUDIO_STALL_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Bound the wait for an actual playing decoder. A never-settling play promise is a track failure. */
export async function startRecordedMedia(audio: HTMLMediaElement): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      audio.play(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Recorded audio playback timed out.')),
          AUDIO_STALL_TIMEOUT_MS,
        );
      }),
    ]);
    if (audio.paused || audio.readyState < HTMLMediaElement.HAVE_CURRENT_DATA)
      throw new Error('Recorded audio playback did not become ready.');
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Align to the *current* shared video clock after every awaited decoder operation.
 * Delayed seeking never silently shifts the transcript timeline.
 */
export async function alignRecordedMedia(
  audio: HTMLAudioElement,
  offsetMs: number,
  durationMs: number,
  originMonotonicMs: number,
  now: () => number = () => performance.now(),
): Promise<number | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const position = recordedAudioPosition(offsetMs, now() - originMonotonicMs, durationMs);
    if (!position || position.delayMs > 0) return null;
    await seekRecordedMedia(audio, position.mediaMs);
    const updated = recordedAudioPosition(offsetMs, now() - originMonotonicMs, durationMs);
    if (!updated || updated.delayMs > 0) return null;
    const actual = audio.currentTime * 1000;
    if (Math.abs(actual - updated.mediaMs) <= AUDIO_DRIFT_TOLERANCE_MS) return actual;
  }
  throw new Error('Recorded audio could not synchronize with the shared video timeline.');
}
