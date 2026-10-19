import type { FreeformRequest } from '../shared/playground-contract';
import type { NativeServiceStatus } from '../shared/native-service-contract';
import type { InferenceInput } from './fake-inference';
import type { PlaygroundProvider } from './playground-service';

/** Fake workers are only constructed when a distinct, isolated package-certification mode is on.
 * Real bundled llama.cpp and whisper.cpp are checked separately by native smoke processes.
 */
export function certificationPlaygroundProvider(): PlaygroundProvider {
  return {
    async completeFreeform(request: FreeformRequest, signal: AbortSignal) {
      if (signal.aborted) throw new Error('Certification fixture cancelled.');
      if (request.modelId === 'cert-failure')
        throw new Error('Certification worker failed intentionally.');
      return {
        startedAt: new Date().toISOString(),
        durationMs: 0,
        effectiveSeed: request.seed,
        content: 'fixture-freeform:' + request.userPrompt,
        finishReason: 'stop',
        usage: { promptTokens: 5, completionTokens: 7, totalTokens: 12 },
      };
    },
    async completeSimulationRequest(input: InferenceInput, _request: unknown, signal: AbortSignal) {
      if (signal.aborted) throw new Error('Certification fixture cancelled.');
      if (input.context === 'cert-failure')
        throw new Error('Certification worker failed intentionally.');
      return {
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({
                events: [{ kind: 'context', summary: 'certified structured output', ageMs: 0 }],
                messages: [
                  {
                    author: input.roster?.[0]?.author ?? 'pixelpilot',
                    text: 'certified desktop chat',
                    offsetMs: 0,
                  },
                ],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 12, total_tokens: 20 },
      };
    },
    async stop() {},
  };
}

/** Exercises real decoded PCM, VAD, source labels and the speech-to-session bridge without
 * requiring model downloads on ordinary cross-platform release runners.
 */
export class CertificationSpeechWorker {
  private revision = 0;
  private status: NativeServiceStatus = { revision: 0, phase: 'stopped', error: null };
  private readonly listeners = new Set<(status: NativeServiceStatus) => void>();
  snapshot(): NativeServiceStatus {
    return this.status;
  }
  subscribe(listener: (status: NativeServiceStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private publish(phase: NativeServiceStatus['phase']) {
    this.status = { revision: ++this.revision, phase, error: null };
    for (const listener of this.listeners) listener(this.status);
  }
  async start(): Promise<void> {
    this.publish('ready');
  }
  async transcribe(samples: Float32Array): Promise<string> {
    if (samples.length < 1600) throw new Error('Insufficient decoded PCM in certification.');
    return 'certified speech from PCM';
  }
  stop(): void {
    this.publish('stopped');
  }
  async shutdown(): Promise<void> {
    this.stop();
  }
}
