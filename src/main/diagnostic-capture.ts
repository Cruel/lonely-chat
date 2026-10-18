import type { DiagnosticStatus, PrivateWorkerLine } from '../shared/diagnostic-contract';
import type { InferenceInput } from './fake-inference';

/** Explicit opt-in, bounded memory capture. Only Export writes anything to disk. */
export class DiagnosticCapture {
  private enabled = false;
  private generation = 0;

  token(): number | null {
    return this.enabled ? this.generation : null;
  }
  private samples: string[] = [];
  private workerOutput: string[] = [];
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
      workerLines: this.workerOutput.length,
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
    this.workerOutput = [];
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
      if (this.samples.length) this.bytes -= Buffer.byteLength(this.samples.shift()!);
      else this.bytes -= Buffer.byteLength(this.workerOutput.shift()!);
      this.dropped++;
    }
    this.samples.push(sample);
    this.bytes += size;
  }

  /** Private native stderr/stdout text, never persisted until the user explicitly exports. */
  recordWorkerLine(worker: string, stream: 'stdout' | 'stderr', line: string): void {
    if (!this.enabled) return;
    const sample = JSON.stringify({ worker, stream, line: line.slice(0, 2048) });
    const size = Buffer.byteLength(sample);
    if (size > this.maxBytes) {
      this.dropped++;
      return;
    }
    // Private worker text is capped independently to prevent noisy workers from
    // crowding out inference samples, and shares the global memory budget.
    while (this.workerOutput.length >= 200 || this.bytes + size > this.maxBytes) {
      if (this.workerOutput.length) this.bytes -= Buffer.byteLength(this.workerOutput.shift()!);
      else this.bytes -= Buffer.byteLength(this.samples.shift()!);
      this.dropped++;
    }
    this.workerOutput.push(sample);
    this.bytes += size;
  }

  /** Explicitly enabled, bounded, desktop-only details for expandable multiline inspection. */
  privateWorkerLines(): readonly PrivateWorkerLine[] {
    if (!this.enabled) throw new Error('Enable private capture before viewing worker text.');
    return this.workerOutput.map((line) => JSON.parse(line) as PrivateWorkerLine);
  }

  export(): string {
    if (!this.enabled) throw new Error('Enable diagnostic capture before exporting.');
    return `{"version":2,"dropped":${this.dropped},"samples":[${this.samples.join(',')}],"workerOutput":[${this.workerOutput.join(',')}]}\n`;
  }
}
