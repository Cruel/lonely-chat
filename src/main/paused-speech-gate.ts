import type { AudioStatus } from '../shared/audio-contract';

/** Recorded Whisper may still be draining despite an idle VLM. Never start a
 * second speech worker until all active recorded speech requests have settled. */
export function canStartPausedSpeech(pausedAndInferenceIdle: boolean, audio: AudioStatus): boolean {
  return (
    pausedAndInferenceIdle &&
    audio.sources.every((source) => source.phase !== 'starting' && source.pendingSegments === 0)
  );
}
