import { describe, expect, it, vi } from 'vitest';
import { nativeVideoStageAdapter } from './unified-inference-adapters';
import { buildUnifiedInferenceRequest } from './unified-inference-request';
import type { InferenceInput } from './fake-inference';
import type { UnifiedInferenceAdapter } from './inference-coordinator';

const input: InferenceInput = {
  context: 'Watch the scene',
  cycle: 1,
  frames: [
    { sourceId: 'camera', observedAt: 1000, width: 8, height: 8, dataUrl: 'data:image/jpeg;base64,/9j/' },
    { sourceId: 'camera', observedAt: 2000, width: 8, height: 8, dataUrl: 'data:image/jpeg;base64,/9j/' },
  ],
  videoWindow: { fromMs: 0, throughMs: 2000, truncated: false },
};
const request = buildUnifiedInferenceRequest(input);

describe('continuous native-video Vision adapter', () => {
  it('retains frame transport when loaded model capability is uncertain', async () => {
    const fallback = vi.fn(async () => ({ raw: 'frames', normalized: 'frames' }));
    const prepare = vi.fn(async () => {});
    const encode = vi.fn(async () => { throw Error('unexpected video'); });
    const base: UnifiedInferenceAdapter = { capabilities: { images: true }, complete: fallback };
    const adapter = nativeVideoStageAdapter(base, {
      prepare, supportsNativeVideo: () => false, completeSimulationVideoWindow: encode,
    }, input);
    const result = await adapter.complete(request, new AbortController().signal);
    expect(result.raw).toBe('frames');
    expect(fallback).toHaveBeenCalledOnce();
    expect(encode).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledOnce();
  });

  it('passes only request-selected frames and private placeholders to verified local transport', async () => {
    const calls: unknown[] = [];
    const fallback = vi.fn(async () => ({ raw: null, normalized: null }));
    const adapter = nativeVideoStageAdapter({
      capabilities: { images: true }, complete: fallback,
    }, {
      prepare: async () => {},
      supportsNativeVideo: () => true,
      async completeSimulationVideoWindow(_input, payload, _signal, window) {
        calls.push({ payload, window });
        throw new Error('stub decoder stop');
      },
    }, input);
    const restricted = {
      ...request,
      content: request.content.filter((part) =>
        part.type !== 'image' || part.observedAt === 2000),
    };
    await expect(adapter.complete(restricted, new AbortController().signal)).rejects.toThrow();
    const first = calls[0] as { payload: { messages: Array<{ content: unknown }> }; window: { frames: Array<{ observedAt: number }> } };
    expect(first.window.frames.map((frame) => frame.observedAt)).toEqual([2000]);
    expect(JSON.stringify(first.payload)).toContain('[video loaded only at transport]');
    expect(JSON.stringify(first.payload)).not.toContain('data:image/jpeg;base64');
    expect(fallback).not.toHaveBeenCalled();
  });
});
