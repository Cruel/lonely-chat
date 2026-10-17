/** Self-contained worklet JavaScript: loaded as a blob with the correct JS MIME type. */
export const audioWorkletSource = `
class MonoCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channels = inputs[0];
    if (!channels || channels.length === 0) return true;
    const samples = new Float32Array(channels[0].length);
    for (const channel of channels) {
      for (let index = 0; index < samples.length; ++index) {
        samples[index] += channel[index] / channels.length;
      }
    }
    this.port.postMessage(samples, [samples.buffer]);
    return true;
  }
}
registerProcessor('lonely-chat-mono', MonoCaptureProcessor);
`;
