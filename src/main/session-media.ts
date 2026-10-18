import type { SessionController } from './session-controller';
import type { AudioService } from './audio-service';
import type { LabeledTranscript } from '../shared/session-contract';

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

  recordTranscript(entry: LabeledTranscript): void {
    if (['running', 'starting', 'switching'].includes(this.session.snapshot().phase)) {
      this.session.recordTranscript(entry);
    }
  }
}
