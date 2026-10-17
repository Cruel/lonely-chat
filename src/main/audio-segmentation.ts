/**
 * 16 kHz mono energy-based segmentation. Cheap deterministic VAD gate; whisper.cpp itself
 * handles transcription. Input is never recorded or retained after a segment is consumed.
 */
export class SpeechSegmenter {
  private buffer: number[] = [];
  private voiced = false;
  private quiet = 0;
  private readonly preRoll: number[] = [];
  private readonly chunks: number[] = [];

  constructor(private readonly sampleRate = 16000) {}

  push(input: Float32Array): Float32Array[] {
    const completed: Float32Array[] = [];
    const block = Math.max(1, Math.round(this.sampleRate / 10)); // 100 ms
    for (const sample of input) this.chunks.push(sample);
    while (this.chunks.length >= block) {
      const samples = this.chunks.splice(0, block);
      let energy = 0;
      for (const sample of samples) energy += sample * sample;
      const talking = Math.sqrt(energy / samples.length) >= 0.012;
      if (talking && !this.voiced) {
        this.voiced = true;
        this.buffer.push(...this.preRoll);
        this.preRoll.length = 0;
      }
      if (this.voiced) {
        this.buffer.push(...samples);
        this.quiet = talking ? 0 : this.quiet + block;
        if (this.quiet >= this.sampleRate * 0.7 || this.buffer.length >= this.sampleRate * 8) {
          const segment = this.flush();
          if (segment) completed.push(segment);
        }
      } else {
        this.preRoll.push(...samples);
        if (this.preRoll.length > this.sampleRate * 0.2) {
          this.preRoll.splice(0, this.preRoll.length - this.sampleRate * 0.2);
        }
      }
    }
    return completed;
  }

  flush(): Float32Array | null {
    const segment =
      this.voiced && this.buffer.length >= this.sampleRate * 0.5
        ? Float32Array.from(
            this.buffer.slice(
              0,
              Math.max(0, this.buffer.length - Math.max(0, this.quiet - this.sampleRate * 0.2)),
            ),
          )
        : null;
    this.buffer = [];
    this.quiet = 0;
    this.voiced = false;
    return segment;
  }

  reset(): void {
    this.buffer = [];
    this.preRoll.length = 0;
    this.chunks.length = 0;
    this.voiced = false;
    this.quiet = 0;
  }
}

/** Stateful sample-rate conversion across arbitrary AudioWorklet chunks. */
export class MonoResampler {
  private buffer: number[] = [];
  private position = 0;

  constructor(
    private readonly inputRate: number,
    private readonly outputRate = 16000,
  ) {
    if (inputRate < 8000 || inputRate > 192000) throw new Error('Invalid audio sample rate.');
  }

  push(input: Float32Array): Float32Array {
    for (const sample of input) this.buffer.push(sample);
    const result: number[] = [];
    const step = this.inputRate / this.outputRate;
    while (this.position + 1 < this.buffer.length) {
      const index = Math.floor(this.position);
      const fraction = this.position - index;
      result.push(this.buffer[index] * (1 - fraction) + this.buffer[index + 1] * fraction);
      this.position += step;
    }
    const consumed = Math.min(Math.floor(this.position), this.buffer.length - 1);
    this.buffer.splice(0, consumed);
    this.position -= consumed;
    return Float32Array.from(result);
  }
}
