import type { DiagnosticStatus } from '../shared/diagnostic-contract';
import type { InferenceInput } from './fake-inference';

/** Explicit opt-in, bounded memory capture. Only Export writes anything to disk. */
export class DiagnosticCapture {
  private enabled = false;
  private generation = 0;

  token(): number | null {
    return this.enabled ? this.generation : null;
  }
  private samples: string[] = [];
  private bytes = 0;
  private dropped = 0;

  constructor(
    private readonly maxBytes = 5 * 1024 * 1024,
    private readonly maxSamples = 10,
  ) {}

  status(): DiagnosticStatus {
    return {
      enabled: this.enabled,
      samples: this.samples.length,
      bytes: this.bytes,
      dropped: this.dropped,
    };
  }

  configure(enabled: boolean): DiagnosticStatus {
    if (typeof enabled !== 'boolean') throw new Error('Invalid diagnostic capture setting.');
    // Each opt-in starts a new capture; disabling discards private samples immediately.
    ++this.generation;
    this.enabled = enabled;
    this.samples = [];
    this.bytes = 0;
    this.dropped = 0;
    return this.status();
  }

  record(input: InferenceInput, durationMs: number, result: unknown, token = this.token()): void {
    if (!this.enabled || token === null || token !== this.generation) return;
    const sample = JSON.stringify({ input, durationMs, result });
    const size = Buffer.byteLength(sample);
    if (size > this.maxBytes) {
      this.dropped++;
      return;
    }
    while (this.samples.length >= this.maxSamples || this.bytes + size > this.maxBytes) {
      this.bytes -= Buffer.byteLength(this.samples.shift()!);
      this.dropped++;
    }
    this.samples.push(sample);
    this.bytes += size;
  }

  export(): string {
    if (!this.enabled) throw new Error('Enable diagnostic capture before exporting.');
    return `{"version":1,"dropped":${this.dropped},"samples":[${this.samples.join(',')}]}\n`;
  }
}
