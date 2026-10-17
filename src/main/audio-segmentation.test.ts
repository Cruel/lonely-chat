import { describe, expect, it } from 'vitest';
import { MonoResampler, SpeechSegmenter } from './audio-segmentation';

describe('microphone VAD and resampling', () => {
  it('recognizes speech across sub-100ms worklet chunks and emits after silence', () => {
    const vad = new SpeechSegmenter();
    const signal = Float32Array.from({ length: 24000 }, (_v, i) =>
      i < 3000 || i >= 10000 ? 0 : 0.15 * Math.sin(i * 0.1),
    );
    const parts = [];
    for (let i = 0; i < signal.length; i += 128) {
      parts.push(...vad.push(signal.subarray(i, i + 128)));
    }
    expect(parts).toHaveLength(1);
    expect(parts[0].length).toBeGreaterThan(6500);
    expect(parts[0].length).toBeLessThan(16000);
    expect(vad.flush()).toBeNull();
  });

  it('skips silence and too-short noise but flushes bounded long utterances', () => {
    const vad = new SpeechSegmenter();
    expect(vad.push(new Float32Array(32000))).toHaveLength(0);
    const tooShort = Float32Array.from({ length: 5000 }, (_value, i) => (i < 1600 ? 0.5 : 0));
    expect(vad.push(tooShort)).toHaveLength(0);
    vad.reset();
    const utterance = new Float32Array(16000 * 18).fill(0.12);
    const emitted = vad.push(utterance);
    expect(emitted).toHaveLength(2);
    expect(emitted.every((part) => part.length <= 16000 * 8)).toBe(true);
  });

  it('maintains continuous mono 48 kHz to 16 kHz sample windows', () => {
    const convert = new MonoResampler(48000);
    const all = Float32Array.from({ length: 48000 }, (_v, i) => Math.sin((i * Math.PI) / 300));
    const result: number[] = [];
    for (let index = 0; index < all.length; index += 128)
      result.push(...convert.push(all.subarray(index, index + 128)));
    expect(result.length).toBeGreaterThanOrEqual(15999);
    expect(result.length).toBeLessThanOrEqual(16000);
    expect(result[50]).toBeCloseTo(all[150], 5);
  });
});
