import OpenAI from 'openai';
import { normalizeStageMemory } from './stage-output';
import type { InferenceRequest } from './unified-inference-request';
import type { InferenceTraceObserver } from './inference-trace';
import type { UnifiedInferenceAdapter, NormalizedInferenceUsage } from './inference-coordinator';
import { unifiedOutputSchema, type UnifiedInferenceRequest } from './unified-inference-request';
import { validateRemoteRequest } from './remote-inference-capabilities';
import { AUDIENCE } from './fake-inference';
import { AUTHOR_PLACEHOLDER, type ChatterIdentity } from '../shared/audience-contract';
import {
  validateRemoteEndpoint,
  effectiveRemoteCapabilities,
  type RemoteCapabilityFlags,
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
  const validate = (entry: unknown): void => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error('Invalid strict provider JSON Schema.');
    const schema = entry as Record<string, unknown>;
    if (schema.type === 'object') {
      if (
        !schema.properties ||
        typeof schema.properties !== 'object' ||
        Array.isArray(schema.properties) ||
        schema.additionalProperties !== false
      )
        throw new Error('Strict JSON Schema requires properties and additionalProperties: false.');
      const keys = Object.keys(schema.properties);
      if (
        !Array.isArray(schema.required) ||
        (schema.required as unknown[]).some((key) => !keys.includes(String(key)))
      )
        throw new Error('Strict JSON Schema must require all declared properties.');
      for (const property of Object.values(schema.properties)) validate(property);
    } else if (schema.type === 'array') {
      validate(schema.items);
    } else if (
      !['string', 'integer', 'number', 'boolean', 'null'].includes(schema.type as string) &&
      !(
        Array.isArray(schema.type) &&
        schema.type.length === 2 &&
        schema.type.includes('null') &&
        schema.type.some((type) => ['string', 'integer', 'number', 'boolean'].includes(type))
      )
    ) {
      throw new Error('Unsupported strict provider JSON Schema type.');
    }
  };
  validate(value);
  const clean = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(clean);
    if (!entry || typeof entry !== 'object') return entry;
    const schema = entry as Record<string, unknown>;
    const result = Object.fromEntries(
      Object.entries(schema)
        .filter(([key]) => !unsupported.has(key))
        .map(([key, item]) => [key, clean(item)]),
    );
    if (schema.type === 'object') {
      const properties = result.properties as Record<string, Record<string, unknown>>;
      const required = new Set(schema.required as string[]);
      for (const [key, property] of Object.entries(properties)) {
        if (required.has(key)) continue;
        // OpenAI strict output requires every property; null represents omitted.
        properties[key] = { ...property, type: [property.type, 'null'] };
      }
      result.required = Object.keys(properties);
    }
    return result;
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
  return clean(value) as Record<string, unknown>;
}

/** Resolve author colors after decoding JSON; external models never control audience colors. */
export function normalizeRemoteResult(
  parsed: unknown,
  roster: readonly ChatterIdentity[],
  role: InferenceRequest['role'] = 'unified',
): unknown {
  if (role === 'memory') return parsed;
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
  validateRemoteRequest(selection.connection, selection.model, request);
  const images = request.content.filter((part) => part.type === 'image');
  // Never trace the resolved key, request headers, baseURL credentials or entire media.
  observe?.('request', {
    protocol: selection.connection.protocol,
    model: selection.model.model,
    imageCount: images.length,
    evidenceWindow: request.evidenceWindow,
    contentTypes: request.content.map((part) => part.type),
    ...(request.sampling.seed !== undefined &&
    !effectiveRemoteCapabilities(selection.connection, selection.model).seed
      ? { omittedControls: ['seed'] }
      : {}),
  });
  const support = effectiveRemoteCapabilities(selection.connection, selection.model);
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
        ...(support.sampling ? { temperature: request.sampling.temperature } : {}),
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
    const normalized = normalizeRemoteResult(
      normalizeStageMemory(boundedJson(completedResponsesText(result)), request),
      roster,
      request.role,
    );
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
      ...(support.sampling ? { temperature: request.sampling.temperature } : {}),
      max_tokens: request.sampling.maxTokens,
      ...(request.sampling.seed === undefined || !support.seed
        ? {}
        : { seed: request.sampling.seed }),
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
  const normalized = normalizeRemoteResult(
    normalizeStageMemory(boundedJson(choice.message.content), request),
    roster,
    request.role,
  );
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
    capabilities: {
      images:
        effectiveRemoteCapabilities(selection.connection, selection.model).images &&
        selection.model.images &&
        selection.model.allowRemoteImages,
      nativeVideo: false,
    },
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
          (error.message.startsWith('Remote input ') ||
            error.message.startsWith('Remote image ') ||
            error.message.startsWith('Remote text ') ||
            error.message.startsWith('Selected model ') ||
            error.message.startsWith('This model') ||
            error.message.startsWith('Native-video transport ') ||
            error.message.startsWith('Invalid maximum ') ||
            error.message.startsWith('Invalid provider sampling ') ||
            error.message.startsWith('Strict JSON Schema ') ||
            error.message.startsWith('Invalid strict provider ') ||
            error.message.startsWith('Unsupported strict provider ') ||
            error.message.startsWith('Remote inference returned ') ||
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
  support: RemoteCapabilityFlags;
}> {
  // Test the selected output mode even if a previous metadata claim was negative.
  const formatKey = selection.model.outputFormat === 'json-schema' ? 'jsonSchema' : 'jsonObject';
  const probeSelection: RemoteSelection = {
    ...selection,
    model: {
      ...selection.model,
      capabilityOverrides: {
        ...selection.model.capabilityOverrides,
        text: true,
        ...(selection.model.outputFormat === 'prompt-json' ? {} : { [formatKey]: true }),
      },
    },
  };
  const adapter = remoteUnifiedAdapter(probeSelection, { timeoutMs: 20_000, ...options });
  const probe: UnifiedInferenceRequest = {
    role: 'unified',
    instructions: 'Return JSON with exactly two empty arrays: events and messages.',
    content: [{ type: 'text', text: 'Compatibility probe. No user media or history is supplied.' }],
    response: { kind: 'json', schema: unifiedOutputSchema(AUDIENCE, 'normal') },
    sampling: { temperature: 0.7, maxTokens: 100 },
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
    support: {
      text: true,
      ...(selection.model.outputFormat === 'json-schema' ? { jsonSchema: true } : {}),
      ...(selection.model.outputFormat === 'json-object' ? { jsonObject: true } : {}),
    },
  };
}

/** Read only well-understood metadata hints, never an arbitrary remote object. */
export function readRemoteModelMetadata(value: unknown): RemoteCapabilityFlags {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const data = value as Record<string, unknown>;
  const caps =
    data.capabilities && typeof data.capabilities === 'object' && !Array.isArray(data.capabilities)
      ? (data.capabilities as Record<string, unknown>)
      : {};
  const flags: Record<string, boolean> = {};
  const assign = (key: string, ...names: string[]) => {
    const found = names.map((name) => caps[name] ?? data[name]).find((v) => typeof v === 'boolean');
    if (typeof found === 'boolean') flags[key] = found;
  };
  assign('text', 'text', 'supports_text');
  assign('images', 'vision', 'images', 'supports_vision', 'image_input');
  assign('nativeVideo', 'video', 'native_video', 'supports_video');
  assign('jsonSchema', 'json_schema', 'supports_json_schema', 'structured_outputs');
  assign('jsonObject', 'json_object', 'supports_json_object');
  assign('seed', 'seed', 'supports_seed');
  assign('sampling', 'sampling', 'supports_temperature');
  const modalities = data.input_modalities ?? data.modalities;
  if (Array.isArray(modalities) && modalities.every((entry) => typeof entry === 'string')) {
    flags.text = modalities.includes('text');
    flags.images = modalities.includes('image');
    flags.nativeVideo = modalities.includes('video');
  }
  if (
    Array.isArray(data.supported_parameters) &&
    data.supported_parameters.every((entry) => typeof entry === 'string')
  ) {
    const parameters = data.supported_parameters;
    // Generic response_format support is not proof of strict JSON Schema support.
    flags.jsonSchema =
      parameters.includes('json_schema') ||
      parameters.includes('response_format.json_schema') ||
      parameters.includes('text.format.json_schema');
    flags.jsonObject = parameters.includes('response_format') || parameters.includes('text.format');
    flags.seed = parameters.includes('seed');
    flags.sampling = parameters.includes('temperature');
  }
  return flags as RemoteCapabilityFlags;
}

export async function inspectRemoteModel(
  selection: RemoteSelection,
  signal: AbortSignal,
  fetcher?: typeof fetch,
): Promise<RemoteCapabilityFlags> {
  const client = makeRemoteClient(selection, fetcher);
  try {
    const info = await client.models.retrieve(selection.model.model, { signal });
    if (info.id !== selection.model.model)
      throw new Error('Endpoint returned metadata for a different model.');
    return readRemoteModelMetadata(info);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Endpoint returned metadata'))
      throw error;
    const status = (error as { status?: unknown } | null)?.status;
    if (status === 404 || status === 405)
      throw new Error(
        'This endpoint does not publish model capability metadata. Use a compatibility probe or explicit overrides.',
      );
    throw safeTransportError(error, signal);
  }
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
