import type { SessionController } from './session-controller';
import type { AudioService } from './audio-service';
import {
  allowsRecordedSessionMedia,
  isRecordedVideoFailure,
  type LabeledTranscript,
} from '../shared/session-contract';
import type { VideoFrame } from '../shared/video-contract';

/** Desktop/tray integration seam: session Stop owns all producers, whereas
 * switching only pauses VLM work and must continue accepting observations.
 */
export class SessionMedia {
  constructor(
    private readonly session: SessionController,
    private readonly audio: AudioService,
    private readonly stopRendererCapture: () => void,
  ) {}

  stop() {
    this.session.selectVideoSource(null);
    this.audio.stop();
    this.stopRendererCapture();
    return this.session.stop();
  }

  failRecordedVideo(message: string) {
    const state = this.session.failRecordedVideo(message);
    this.session.selectVideoSource(null);
    this.audio.stop();
    this.stopRendererCapture();
    return state;
  }

  /** Same validation seam used by video:frame IPC for live and recorded producers. */
  recordVideoFrame(frame: VideoFrame): void {
    const state = this.session.snapshot();
    if (
      state.inputMode === 'recorded' &&
      ['starting', 'running', 'switching', 'error'].includes(state.phase)
    ) {
      // A recoverable inference error does not stop the media clock; Retry
      // consumes frames captured while the worker was unavailable.
      if (frame.sourceId !== 'recorded:video') return;
      if (isRecordedVideoFailure(state)) {
        throw new Error('Recorded video decoder has failed.');
      }
    } else if (frame.sourceId === 'recorded:video') {
      throw new Error('Recorded frames require an active recorded simulation.');
    }
    this.session.recordVideoFrame(frame);
  }

  recordTranscript(entry: LabeledTranscript): void {
    const state = this.session.snapshot();
    if (allowsRecordedSessionMedia(state)) this.session.recordTranscript(entry);
  }
}
