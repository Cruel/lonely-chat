import OpenAI from 'openai';
import type { UnifiedInferenceAdapter } from './inference-coordinator';
import type { RemoteSelection } from './remote-inference-adapter';
import { boundedJson, normalizeRemoteResult, usage } from './remote-inference-adapter';
import type { ChatGPTAuth } from './chatgpt-auth';
import type { ChatterIdentity } from '../shared/audience-contract';
import { AUDIENCE } from './fake-inference';
import { unifiedOutputSchema, type UnifiedInferenceRequest } from './unified-inference-request';

/** ChatGPT plan usage never shares transport or credentials with paid API-key Connections. */
export function chatGPTUnifiedAdapter(
  selection: RemoteSelection,
  auth: ChatGPTAuth,
  options: { timeoutMs?: number; roster: readonly ChatterIdentity[]; fetcher?: typeof fetch },
): UnifiedInferenceAdapter {
  const { connection, model } = selection;
  if (
    connection.credentialMode !== 'chatgpt' ||
    !connection.chatgptAccountId ||
    connection.protocol !== 'responses' ||
    connection.baseUrl !== 'https://api.openai.com/v1' ||
    model.connectionId !== connection.id ||
    model.outputFormat !== 'prompt-json' ||
    selection.credential !== null
  )
    throw new Error('ChatGPT account Connection is invalid. No API-key fallback is permitted.');
  const accountId = connection.chatgptAccountId;
  const timeout = options.timeoutMs ?? 45_000;
  return {
    capabilities: { images: model.images && model.allowRemoteImages, nativeVideo: false },
    async complete(request, signal, observe) {
      if (request.nativeVideo) throw new Error('ChatGPT plan usage does not support native video.');
      const images = request.content.filter((part) => part.type === 'image');
      if (images.length && (!model.images || !model.allowRemoteImages))
        throw new Error('ChatGPT image sending requires explicit Model Configuration permission.');
      if (signal.aborted) throw new DOMException('ChatGPT inference cancelled.', 'AbortError');
      const registered = auth.requestSignal(accountId, signal);
      const combined = AbortSignal.any([registered.signal, AbortSignal.timeout(timeout)]);
      try {
        // Refresh/account checks happen in main; never pass credentials through renderer or traces.
        const available = await auth.models(accountId, combined);
        if (!available.some((entry) => entry.id === model.model))
          throw new Error(
            'Selected model is not available to this ChatGPT account. Refresh its model list.',
          );
        const credential = await auth.accessToken(accountId);
        if (combined.aborted) throw new DOMException('ChatGPT inference cancelled.', 'AbortError');
        const client = new OpenAI({
          apiKey: credential,
          baseURL: 'https://api.openai.com/v1',
          maxRetries: 0,
          ...(options.fetcher ? { fetch: options.fetcher } : {}),
        });
        observe?.('request', {
          provider: 'chatgpt-plan',
          role: 'unified',
          model: model.model,
          imageCount: images.length,
          contentTypes: request.content.map((part) => part.type),
          evidenceWindow: request.evidenceWindow,
        });
        // The preview route rejects max_output_tokens, temperature, seed, and system-role inputs.
        // Use an instructions field and require application-side schema validation after the stream.
        const content: OpenAI.Responses.ResponseInputContent[] = request.content.map((part) =>
          part.type === 'text'
            ? { type: 'input_text', text: part.text }
            : { type: 'input_image', image_url: part.dataUrl, detail: 'auto' },
        );
        const stream = await client.responses.create(
          {
            model: model.model,
            instructions: `${request.instructions}\nReturn exactly one JSON object matching this schema: ${JSON.stringify(request.response.schema)}`,
            input: [{ role: 'user', content }],
            store: false,
            stream: true,
          },
          { signal: combined },
        );
        let completed: OpenAI.Responses.Response | null = null;
        for await (const event of stream) {
          if (combined.aborted)
            throw new DOMException('ChatGPT inference cancelled.', 'AbortError');
          if (event.type === 'response.completed') completed = event.response;
          else if (event.type === 'response.failed')
            throw new Error(
              'ChatGPT response failed. Check account plan access and model entitlement.',
            );
          else if (event.type === 'response.incomplete')
            throw new Error('ChatGPT response was incomplete. No Chat batch was accepted.');
        }
        if (!completed || completed.status !== 'completed')
          throw new Error(
            'ChatGPT stream ended without response.completed. No Chat batch was accepted.',
          );
        const chunks: string[] = [];
        for (const item of completed.output) {
          if (item.type === 'message' && item.role === 'assistant' && item.status === 'completed')
            for (const part of item.content)
              if (part.type === 'output_text') chunks.push(part.text);
        }
        const normalized = normalizeRemoteResult(boundedJson(chunks.join('')), options.roster);
        const counts = usage(completed.usage);
        const raw = {
          id: completed.id,
          status: completed.status,
          usage: {
            prompt_tokens: counts.promptTokens,
            completion_tokens: counts.completionTokens,
            total_tokens: counts.totalTokens,
          },
        };
        observe?.('response', raw);
        observe?.('normalized', normalized);
        return { raw, normalized, usage: counts };
      } catch (error) {
        if (signal.aborted || registered.signal.aborted)
          throw new DOMException('ChatGPT inference cancelled.', 'AbortError');
        if (combined.aborted) throw new Error('ChatGPT inference timed out.');
        if (
          error instanceof Error &&
          /^ChatGPT (account|plan|image|stream|response|inference)|^Selected model|^Remote inference returned/.test(
            error.message,
          )
        )
          throw error;
        const failure = error as { status?: number; code?: string } | null;
        if (failure?.code === 'subscription_sharing_usage_limit_exceeded')
          throw new Error(
            'ChatGPT plan usage limit exceeded. Review ChatGPT Settings → Usage; no paid API fallback.',
          );
        if (failure?.code === 'subscription_sharing_user_not_eligible')
          throw new Error('This ChatGPT account/workspace is not eligible for plan inference.');
        if (failure?.status === 401)
          throw new Error('ChatGPT authorization was rejected. Sign in again.');
        if (failure?.status === 403)
          throw new Error('ChatGPT plan access or serving policy denied this request.');
        if (failure?.status === 429)
          throw new Error(
            'ChatGPT plan inference is rate-limited or out of usage. Check Settings → Usage.',
          );
        if (failure?.status === 503)
          throw new Error('ChatGPT plan inference temporarily unavailable; retry later.');
        throw new Error('ChatGPT plan inference transport failed. No API-key fallback was used.');
      } finally {
        registered.release();
      }
    },
  };
}

/** Verify actual plan model transport and completed JSON, without sending private media. */
export async function probeChatGPTModel(
  selection: RemoteSelection,
  auth: ChatGPTAuth,
  signal: AbortSignal,
) {
  const probe: UnifiedInferenceRequest = {
    role: 'unified',
    instructions: 'Return exactly JSON with two empty arrays: events and messages.',
    content: [{ type: 'text', text: 'Compatibility probe; no history or media.' }],
    response: { kind: 'json', schema: unifiedOutputSchema(AUDIENCE, 'normal') },
    sampling: { temperature: 0, maxTokens: 100 },
    evidenceWindow: null,
  };
  const result = await chatGPTUnifiedAdapter(selection, auth, { roster: AUDIENCE }).complete(
    probe,
    signal,
  );
  const output = result.normalized as { events?: unknown; messages?: unknown };
  if (
    !Array.isArray(output.events) ||
    output.events.length ||
    !Array.isArray(output.messages) ||
    output.messages.length
  )
    throw new Error('ChatGPT model returned an incompatible structured result.');
  return {
    compatible: true as const,
    protocol: 'responses' as const,
    usage: result.usage ?? usage(null),
  };
}
