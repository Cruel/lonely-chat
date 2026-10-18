/** Batched, mono file audio capture. The sink is muted; monitoring is not required for inference. */
export const recordedAudioWorkletSource = `
class RecordedAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(4096);
    this.length = 0;
    this.active = false;
    this.port.onmessage = (event) => {
      if (event.data === 'start') {
        this.length = 0;
        this.active = true;
      } else if (event.data === 'flush') {
        this.active = false;
        this.emit();
        this.port.postMessage({ type: 'flushed' });
      }
    };
  }
  emit() {
    if (!this.length) return;
    const samples = this.buffer.slice(0, this.length);
    this.port.postMessage(samples, [samples.buffer]);
    this.length = 0;
  }
  process(inputs) {
    if (!this.active) return true;
    const channels = inputs[0];
    if (!channels || !channels.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[i] / channels.length;
      this.buffer[this.length++] = sample;
      if (this.length === this.buffer.length) this.emit();
    }
    return true;
  }
}
registerProcessor('lonely-chat-recorded-audio', RecordedAudioProcessor);
`;
