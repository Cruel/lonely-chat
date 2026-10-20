import OpenAI from 'openai';
import type { InferenceTraceObserver } from './inference-trace';
import type { UnifiedInferenceAdapter, NormalizedInferenceUsage } from './inference-coordinator';
import { unifiedOutputSchema, type UnifiedInferenceRequest } from './unified-inference-request';
import { AUDIENCE } from './fake-inference';
import { AUTHOR_PLACEHOLDER, type ChatterIdentity } from '../shared/audience-contract';
import {
  validateRemoteEndpoint,
  type RemoteConnection,
  type RemoteModelConfiguration,
} from '../shared/remote-inference-contract';

export interface RemoteSelection {
  readonly connection: RemoteConnection;
  readonly model: RemoteModelConfiguration;
  /** Resolved exclusively within main. Never serialize this selection. */
  readonly credential: string | null;
}

export function usage(
  value:
    | {
        input_tokens?: number | null;
        output_tokens?: number | null;
        prompt_tokens?: number | null;
        completion_tokens?: number | null;
        total_tokens?: number | null;
      }
    | null
    | undefined,
): NormalizedInferenceUsage {
  return {
    promptTokens: value?.input_tokens ?? value?.prompt_tokens ?? null,
    completionTokens: value?.output_tokens ?? value?.completion_tokens ?? null,
    totalTokens: value?.total_tokens ?? null,
  };
}

/** Never propagate provider-controlled error bodies or SDK request configuration to IPC/logs. */
function safeTransportError(error: unknown, signal: AbortSignal): Error {
  if (signal.aborted) return new DOMException('Remote inference cancelled.', 'AbortError');
  if (error instanceof Error && error.name === 'AbortError')
    return new DOMException('Remote inference cancelled.', 'AbortError');
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === 'number' && status >= 100 && status <= 599)
    return new Error(
      `Remote inference failed (HTTP ${status}). Check the Connection, model, credentials and protocol.`,
    );
  return new Error(
    'Remote inference transport failed. Check endpoint reachability, TLS and protocol compatibility.',
  );
}

/** Secure transport without weakening TLS, even for an explicitly authorized HTTP LAN host. */
export function makeRemoteClient(
  selection: RemoteSelection,
  fetcher: typeof fetch = fetch,
): OpenAI {
  if (selection.connection.credentialMode === 'chatgpt')
    throw new Error('ChatGPT plan usage requires its separate OAuth transport.');
  const baseURL = validateRemoteEndpoint(
    selection.connection.baseUrl,
    selection.connection.allowInsecureLan,
  );
  return new OpenAI({
    apiKey: selection.credential ?? 'keyless-local-connection',
    baseURL,
    maxRetries: 0,
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      if (!selection.credential) headers.delete('authorization');
      return fetcher(input, { ...init, headers, redirect: 'error' });
    },
  });
}

export function boundedJson(text: string): unknown {
  if (!text || text.length > 2_000_000)
    throw new Error('Remote inference returned empty or oversized JSON.');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('Remote inference returned invalid JSON.');
  }
}

/**
 * Strict OpenAI structured output accepts only a subset of JSON Schema.
 * The application's original schema remains authoritative after transport.
 */
export function strictProviderSchema(value: Record<string, unknown>): Record<string, unknown> {
  const clean = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(clean);
    if (!entry || typeof entry !== 'object') return entry;
    return strictProviderSchema(entry as Record<string, unknown>);
  };
  const unsupported = new Set([
    'maxItems',
    'minItems',
    'minLength',
    'maxLength',
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'pattern',
    'format',
    'uniqueItems',
  ]);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !unsupported.has(key))
      .map(([key, item]) => [key, clean(item)]),
  );
}

/** Resolve author colors after decoding JSON; external models never control audience colors. */
export function normalizeRemoteResult(
  parsed: unknown,
  roster: readonly ChatterIdentity[],
): unknown {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Remote inference returned an invalid result object.');
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.messages))
    throw new Error('Remote inference returned an invalid chat batch.');
  const allowed = new Map(roster.map((person) => [person.author, person.color]));
  const messages = record.messages.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error('Remote inference returned an invalid chat message.');
    const item = entry as Record<string, unknown>;
    if (
      typeof item.author !== 'string' ||
      (item.author !== AUTHOR_PLACEHOLDER && !allowed.has(item.author))
    )
      throw new Error('Remote inference returned an unknown chatter identity.');
    return { ...item, color: allowed.get(item.author) ?? '#000000' };
  });
  return { ...record, messages };
}

function completedResponsesText(result: OpenAI.Responses.Response): string {
  const chunks: string[] = [];
  for (const item of result.output) {
    if (item.type === 'message' && item.role === 'assistant' && item.status === 'completed') {
      for (const part of item.content) if (part.type === 'output_text') chunks.push(part.text);
    }
  }
  return chunks.join('');
}

async function remoteComplete(
  client: OpenAI,
  selection: RemoteSelection,
  request: UnifiedInferenceRequest,
  signal: AbortSignal,
  roster: readonly ChatterIdentity[],
  observe?: InferenceTraceObserver,
): Promise<{ raw: unknown; normalized: unknown; usage: NormalizedInferenceUsage }> {
  if (request.nativeVideo) throw new Error('This remote model does not support native video.');
  const images = request.content.filter((part) => part.type === 'image');
  if (images.length && (!selection.model.images || !selection.model.allowRemoteImages))
    throw new Error(
      'Remote screenshot transmission requires an image-capable model and explicit image permission.',
    );
  // Never trace the resolved key, request headers, baseURL credentials or entire media.
  observe?.('request', {
    protocol: selection.connection.protocol,
    model: selection.model.model,
    imageCount: images.length,
    evidenceWindow: request.evidenceWindow,
    contentTypes: request.content.map((part) => part.type),
  });
  const format = selection.model.outputFormat;
  const instructions =
    format === 'prompt-json'
      ? `${request.instructions}\nRequired JSON Schema: ${JSON.stringify(request.response.schema)}`
      : request.instructions;
  const model = selection.model.model;
  if (selection.connection.protocol === 'responses') {
    const input: OpenAI.Responses.ResponseInput = [
      {
        role: 'user',
        content: request.content.map((part) =>
          part.type === 'text'
            ? { type: 'input_text' as const, text: part.text }
            : { type: 'input_image' as const, image_url: part.dataUrl, detail: 'auto' as const },
        ),
      },
    ];
    const result = await client.responses.create(
      {
        model,
        instructions,
        input,
        store: false,
        max_output_tokens: request.sampling.maxTokens,
        ...(format === 'json-schema'
          ? {
              text: {
                format: {
                  type: 'json_schema' as const,
                  name: 'unified_inference',
                  strict: true,
                  schema: strictProviderSchema(request.response.schema),
                },
              },
            }
          : format === 'json-object'
            ? { text: { format: { type: 'json_object' as const } } }
            : {}),
      },
      { signal },
    );
    if (result.status !== 'completed')
      throw new Error('Remote inference did not complete. No Chat batch was accepted.');
    const normalized = normalizeRemoteResult(boundedJson(completedResponsesText(result)), roster);
    const counts = usage(result.usage);
    const raw = {
      id: result.id,
      status: result.status,
      usage: {
        prompt_tokens: counts.promptTokens,
        completion_tokens: counts.completionTokens,
        total_tokens: counts.totalTokens,
      },
    };
    observe?.('response', raw);
    observe?.('normalized', normalized);
    return { raw, normalized, usage: counts };
  }
  const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = request.content.map(
    (part) =>
      part.type === 'text'
        ? { type: 'text', text: part.text }
        : { type: 'image_url', image_url: { url: part.dataUrl, detail: 'auto' } },
  );
  const result = await client.chat.completions.create(
    {
      model,
      temperature: request.sampling.temperature,
      max_tokens: request.sampling.maxTokens,
      ...(request.sampling.seed === undefined ? {} : { seed: request.sampling.seed }),
      messages: [
        { role: 'system', content: instructions },
        { role: 'user', content },
      ],
      ...(format === 'json-schema'
        ? {
            response_format: {
              type: 'json_schema' as const,
              json_schema: {
                name: 'unified_inference',
                strict: true,
                schema: strictProviderSchema(request.response.schema),
              },
            },
          }
        : format === 'json-object'
          ? { response_format: { type: 'json_object' as const } }
          : {}),
    },
    { signal },
  );
  const choice = result.choices[0];
  if (!choice || choice.finish_reason !== 'stop' || typeof choice.message.content !== 'string')
    throw new Error('Remote inference did not finish normally. No Chat batch was accepted.');
  const normalized = normalizeRemoteResult(boundedJson(choice.message.content), roster);
  const counts = usage(result.usage);
  const raw = {
    id: result.id,
    finishReason: choice.finish_reason,
    usage: {
      prompt_tokens: counts.promptTokens,
      completion_tokens: counts.completionTokens,
      total_tokens: counts.totalTokens,
    },
  };
  observe?.('response', raw);
  observe?.('normalized', normalized);
  return { raw, normalized, usage: counts };
}

export function remoteUnifiedAdapter(
  selection: RemoteSelection,
  options: { timeoutMs?: number; fetcher?: typeof fetch; roster?: readonly ChatterIdentity[] } = {},
): UnifiedInferenceAdapter {
  if (selection.connection.id !== selection.model.connectionId)
    throw new Error('Remote model and Connection do not match.');
  const client = makeRemoteClient(selection, options.fetcher);
  const timeoutMs = options.timeoutMs ?? 45_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600_000)
    throw new Error('Invalid remote inference timeout.');
  return {
    capabilities: { images: selection.model.images && selection.model.allowRemoteImages },
    async complete(request, signal, observe) {
      const combined = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
      try {
        return await remoteComplete(
          client,
          selection,
          request,
          combined,
          options.roster ?? AUDIENCE,
          observe,
        );
      } catch (error) {
        // Validation failures are safe but provider-controlled errors are not.
        if (
          error instanceof Error &&
          (error.message.startsWith('Remote inference returned ') ||
            error.message.startsWith('Remote inference did not ') ||
            error.message.startsWith('Remote screenshot ') ||
            error.message.startsWith('This remote model '))
        )
          throw error;
        if (!signal.aborted && combined.aborted) throw new Error('Remote inference timed out.');
        throw safeTransportError(error, combined);
      }
    },
  };
}

/** A real transport probe, not an optimistic capability guess based on a model name. */
export async function probeRemoteModel(
  selection: RemoteSelection,
  signal: AbortSignal,
  options: { fetcher?: typeof fetch } = {},
): Promise<{
  compatible: true;
  protocol: RemoteConnection['protocol'];
  usage: NormalizedInferenceUsage;
}> {
  const adapter = remoteUnifiedAdapter(selection, { timeoutMs: 20_000, ...options });
  const probe: UnifiedInferenceRequest = {
    role: 'unified',
    instructions: 'Return JSON with exactly two empty arrays: events and messages.',
    content: [{ type: 'text', text: 'Compatibility probe. No user media or history is supplied.' }],
    response: { kind: 'json', schema: unifiedOutputSchema(AUDIENCE, 'normal') },
    sampling: { temperature: 0, maxTokens: 100 },
    evidenceWindow: null,
  };
  const result = await adapter.complete(probe, signal);
  const v = result.normalized;
  if (
    !v ||
    typeof v !== 'object' ||
    !('events' in v) ||
    !('messages' in v) ||
    !Array.isArray(v.events) ||
    !Array.isArray(v.messages) ||
    v.events.length ||
    v.messages.length
  )
    throw new Error('Endpoint returned an incompatible structured result.');
  return {
    compatible: true,
    protocol: selection.connection.protocol,
    usage: result.usage ?? usage(null),
  };
}

export async function listRemoteModels(
  selection: RemoteSelection,
  signal: AbortSignal,
  fetcher?: typeof fetch,
): Promise<string[]> {
  const client = makeRemoteClient(selection, fetcher);
  try {
    const result = await client.models.list({ signal });
    return result.data
      .map((item) => item.id)
      .filter((id) => typeof id === 'string')
      .slice(0, 500);
  } catch (error) {
    throw safeTransportError(error, signal);
  }
}
