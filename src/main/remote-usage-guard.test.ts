import { describe, expect, it, vi } from 'vitest';
import { RemoteUsageGuard } from './remote-usage-guard';
import type { RemoteModelConfiguration } from '../shared/remote-inference-contract';
import type { UnifiedInferenceAdapter } from './inference-coordinator';
import type { UnifiedInferenceRequest } from './unified-inference-request';
import { validateRemoteModel } from '../shared/remote-inference-contract';

const model: RemoteModelConfiguration = {
  id: 'guard', name: 'Guard', connectionId: 'conn', model: 'example',
  images: false, allowRemoteImages: false, outputFormat: 'prompt-json',
  maxRequestsPerMinute: 2, maxRequestsPerRun: 3, maxTokensPerRun: 1000,
  inputUsdPerMillion: 1, outputUsdPerMillion: 2,
};
const request = {
  role: 'unified',
  instructions: 'Summarize.',
  content: [{ type: 'text', text: 'recent scene and chat' }],
  sampling: { maxTokens: 50, temperature: 0.5 },
  response: { kind: 'json', schema: {} },
  evidenceWindow: null,
} as unknown as UnifiedInferenceRequest;

describe('remote usage guard', () => {
  it('shares rate and volume reservations across Memory and Chat adapters', async () => {
    let clock = 0;
    const guard = new RemoteUsageGuard(() => clock);
    const complete = vi.fn(async () => ({ raw: {}, normalized: {}, usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 } }));
    const adapter: UnifiedInferenceAdapter = { capabilities: { images: false }, complete };
    const memory = guard.wrap(model, adapter);
    const chat = guard.wrap(model, adapter);
    await memory.complete(request, new AbortController().signal);
    await chat.complete(request, new AbortController().signal);
    await expect(memory.complete(request, new AbortController().signal)).rejects.toThrow(/rate/);
    clock += 60_001;
    await memory.complete(request, new AbortController().signal);
    await expect(chat.complete(request, new AbortController().signal)).rejects.toThrow(/count/);
    expect(complete).toHaveBeenCalledTimes(3);
    expect(guard.snapshot(model)).toEqual({ requests: 3, providerPromptTokens: 60, providerCompletionTokens: 30, estimatedTokens: 90, hasEstimatedUsage: false, estimatedCostUsd: 0.00012 });
  });

  it('rejects estimated token volume before transport, and validates limits', async () => {
    const complete = vi.fn();
    const guard = new RemoteUsageGuard();
    await expect(guard.wrap({ ...model, maxTokensPerRun: 1 }, { capabilities: { images: false }, complete }).complete(request, new AbortController().signal)).rejects.toThrow(/token-volume/);
    expect(complete).not.toHaveBeenCalled();
    expect(() => validateRemoteModel({ ...model, maxRequestsPerMinute: -1 })).toThrow(/limit/);
    expect(() => validateRemoteModel({ ...model, outputUsdPerMillion: Infinity })).toThrow(/price estimate/);
  });

  it('charges conservative estimated token volume for each dispatched broken completion', async () => {
    const guard = new RemoteUsageGuard();
    const broken = vi.fn(async () => { throw new Error('JSON normalization failed after tokens were generated'); });
    const entry = { ...model, maxTokensPerRun: 70, maxRequestsPerMinute: undefined, maxRequestsPerRun: undefined };
    const wrapped = guard.wrap(entry, { capabilities: { images: false }, complete: broken });
    await expect(wrapped.complete(request, new AbortController().signal)).rejects.toThrow(/normalization/);
    expect(guard.snapshot(entry)).toMatchObject({
      requests: 1, hasEstimatedUsage: true, providerPromptTokens: 0, providerCompletionTokens: 0,
    });
    expect(guard.snapshot(entry).estimatedTokens).toBeGreaterThan(50);
    await expect(wrapped.complete(request, new AbortController().signal)).rejects.toThrow(/token-volume/);
    expect(broken).toHaveBeenCalledTimes(1);
  });

  it('counts failed requests and releases reservations after a broken stream', async () => {
    const guard = new RemoteUsageGuard();
    const complete = vi.fn().mockRejectedValue(new Error('interrupted'));
    const wrapped = guard.wrap({ ...model, maxRequestsPerRun: 1 }, { capabilities: { images: false }, complete });
    await expect(wrapped.complete(request, new AbortController().signal)).rejects.toThrow('interrupted');
    await expect(wrapped.complete(request, new AbortController().signal)).rejects.toThrow(/count/);
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
