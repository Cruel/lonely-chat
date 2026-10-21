import type { RemoteModelConfiguration } from '../shared/remote-inference-contract';
import type { UnifiedInferenceAdapter } from './inference-coordinator';

/** Run-scoped and model-scoped. All stages, including Memory, share one ledger. */
export class RemoteUsageGuard {
  private readonly ledgers = new Map<string, { times: number[]; requests: number; tokens: number; reserved: number; prompt: number; completion: number; providerPrompt: number; providerCompletion: number; estimated: boolean }>();
  constructor(private readonly now: () => number = Date.now) {}

  wrap(model: RemoteModelConfiguration, adapter: UnifiedInferenceAdapter): UnifiedInferenceAdapter {
    const id = model.id;
    return {
      capabilities: adapter.capabilities,
      complete: async (request, signal, observe) => {
        if (signal.aborted) throw new DOMException('Remote inference cancelled.', 'AbortError');
        const state = this.ledgers.get(id) ?? { times: [], requests: 0, tokens: 0, reserved: 0, prompt: 0, completion: 0, providerPrompt: 0, providerCompletion: 0, estimated: false };
        const now = this.now();
        state.times = state.times.filter((time) => time > now - 60_000);
        if (model.maxRequestsPerMinute !== undefined && state.times.length >= model.maxRequestsPerMinute)
          throw new Error('Remote request-rate guard reached for this Model Configuration. Retry later.');
        if (model.maxRequestsPerRun !== undefined && state.requests >= model.maxRequestsPerRun)
          throw new Error('Remote request-count guard reached for this Run.');
        // Reserve the potential output and a conservative estimate of prompt volume before sending.
        // This is explicitly NOT the provider's tokenization or a guaranteed billing ceiling.
        const estimatedInput = Math.ceil((request.instructions.length + request.content.reduce((n, part) => n + (part.type === 'text' ? part.text.length : 4096), 0)) / 3);
        const reservation = estimatedInput + request.sampling.maxTokens;
        if (model.maxTokensPerRun !== undefined && state.tokens + state.reserved + reservation > model.maxTokensPerRun)
          throw new Error('Remote estimated token-volume guard reached for this Run. This is not a billing cap.');
        state.requests++;
        state.times.push(now);
        state.reserved += reservation;
        this.ledgers.set(id, state);
        try {
          const result = await adapter.complete(request, signal, observe);
          const prompt = result.usage?.promptTokens;
          const completion = result.usage?.completionTokens;
          state.tokens += result.usage?.totalTokens ?? (prompt !== null && prompt !== undefined && completion !== null && completion !== undefined ? prompt + completion : reservation);
          state.prompt += prompt ?? estimatedInput;
          state.completion += completion ?? request.sampling.maxTokens;
          state.providerPrompt += prompt ?? 0;
          state.providerCompletion += completion ?? 0;
          if (prompt === null || prompt === undefined || completion === null || completion === undefined) state.estimated = true;
          return result;
        } finally {
          state.reserved -= reservation;
        }
      },
    };
  }

  snapshot(model: RemoteModelConfiguration) {
    const state = this.ledgers.get(model.id);
    return {
      requests: state?.requests ?? 0,
      /** Mixed provider-advertised values and conservative estimates must not be labelled actual charges. */
      providerPromptTokens: state?.providerPrompt ?? 0,
      providerCompletionTokens: state?.providerCompletion ?? 0,
      estimatedTokens: state?.tokens ?? 0,
      hasEstimatedUsage: state?.estimated ?? false,
      estimatedCostUsd: ((state?.prompt ?? 0) * (model.inputUsdPerMillion ?? 0) +
        (state?.completion ?? 0) * (model.outputUsdPerMillion ?? 0)) / 1_000_000,
    };
  }
}
