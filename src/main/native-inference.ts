import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { NativeServiceStatus } from '../shared/native-service-contract';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AUDIENCE, type InferenceInput, type InferenceProvider } from './fake-inference';
import {
  AUTHOR_PLACEHOLDER,
  CHAT_ACTIVITY_LIMITS,
  type ChatActivity,
  type ChatterIdentity,
} from '../shared/audience-contract';

export interface NativeModelFiles {
  readonly modelPath: string;
  readonly projectorPath: string | null;
}

const AUTHORS = AUDIENCE.map(({ author }) => author);
const MAX_REPLY_BYTES = 1024 * 1024;
const STARTUP_TIMEOUT_MS = 300_000;
const COMPLETION_MAX_TOKENS = 2048;

/** Schema is a generation hint, never a substitute for parseInferenceResult. */
export const INFERENCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['events', 'messages'],
  properties: {
    events: {
      type: 'array',
      maxItems: 24,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'summary', 'ageMs'],
        properties: {
          kind: { type: 'string', enum: ['context', 'reaction'] },
          summary: { type: 'string', minLength: 1, maxLength: 300 },
          ageMs: { type: 'integer', minimum: 0, maximum: 60000 },
        },
      },
    },
    messages: {
      type: 'array',
      maxItems: 64,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['author', 'text', 'offsetMs'],
        properties: {
          author: { type: 'string', enum: [...AUTHORS, AUTHOR_PLACEHOLDER] },
          text: { type: 'string', minLength: 1, maxLength: 500 },
          offsetMs: { type: 'integer', minimum: 0, maximum: 60000 },
        },
      },
    },
  },
} as const;

/** Dynamic constrained grammar must match the roster actually supplied to the model. */
export function inferenceSchema(roster: readonly ChatterIdentity[], activity: ChatActivity) {
  return {
    ...INFERENCE_SCHEMA,
    properties: {
      ...INFERENCE_SCHEMA.properties,
      messages: {
        ...INFERENCE_SCHEMA.properties.messages,
        maxItems: CHAT_ACTIVITY_LIMITS[activity],
        items: {
          ...INFERENCE_SCHEMA.properties.messages.items,
          properties: {
            ...INFERENCE_SCHEMA.properties.messages.items.properties,
            author: {
              type: 'string',
              enum: [...roster.map((member) => member.author), AUTHOR_PLACEHOLDER],
            },
          },
        },
      },
    },
  };
}

/** Prompt snapshots contain no paths, installation metadata or IPC capabilities. */
export function nativeChatRequest(input: InferenceInput) {
  const roster = input.roster ?? AUDIENCE;
  const activity = input.chatActivity ?? 'normal';
  const history = (input.recentEvents ?? []).map((event) => ({
    kind: event.kind,
    summary: event.summary,
    observedAt: event.observedAt,
  }));
  const context = JSON.stringify({
    manualContext: input.context,
    cycle: input.cycle,
    recentEvents: history,
    recentTranscripts: input.recentTranscripts ?? [],
    observations: input.observations ?? [],
    recentChat: input.recentChat ?? [],
    roster,
    chatActivity: activity,
    observationWindow: input.boundary ?? null,
    playbackWindowMs: input.playbackWindowMs ?? 3000,
    videoWindow: input.videoWindow ?? null,
    videoFrames: (input.frames ?? []).map(({ observedAt, sourceId, width, height }) => ({
      observedAt,
      sourceId,
      width,
      height,
      offsetMs: input.videoWindow ? observedAt - input.videoWindow.fromMs : 0,
      ageMs: input.videoWindow ? input.videoWindow.throughMs - observedAt : 0,
    })),
  });
  const content = input.frames?.length
    ? [
        { type: 'text', text: context },
        ...input.frames.flatMap((frame, index) => [
          {
            type: 'text',
            text: `Visual frame ${index + 1}, observedAt=${frame.observedAt} ms, relativeMs=${input.videoWindow ? frame.observedAt - input.videoWindow.fromMs : 0}, ageMs=${input.videoWindow ? input.videoWindow.throughMs - frame.observedAt : 0}, source=${frame.sourceId}`,
          },
          { type: 'image_url', image_url: { url: frame.dataUrl } },
        ]),
      ]
    : context;
  return {
    stream: false,
    temperature: 0.7,
    max_tokens: COMPLETION_MAX_TOKENS,
    // Pinned llama-server b11700 enforces this schema via json_object. Its json_schema
    // response_format variant silently ignored the schema for tested GGUF models.
    response_format: { type: 'json_object', schema: inferenceSchema(roster, activity) },
    messages: [
      {
        role: 'system',
        content:
          `You simulate a friendly live-stream audience. Infer at most 3 short events and write 1-${CHAT_ACTIVITY_LIMITS[activity]} natural viewer chat messages (activity: ${activity}). ` +
          `Use only roster identities, or ${AUTHOR_PLACEHOLDER} when any eligible roster member can speak. Prefer using explicit authors to follow earlier conversation threads. ` +
          'Only use the allowed author identities. Each visual frame is ordered and labeled with absolute and relative observation timestamps. Infer visual events from the images, not their metadata alone. A truncated videoWindow indicates missing earlier footage; do not invent it. ' +
          'ageMs is how many milliseconds before the observationWindow.throughMs an event happened (use 0 for ongoing context). ' +
          'offsetMs is when to display a chat message after this reply, within the requested playbackWindowMs. ' +
          'Use the provided observations and labeled transcripts to react to new content; maintain continuity with recent chat and events. ' +
          'Return only JSON matching the required schema.',
      },
      {
        role: 'user',
        content,
      },
    ],
  };
}

function parseCompletion(body: unknown): unknown {
  if (!body || typeof body !== 'object') throw new Error('llama.cpp returned an invalid response.');
  const choice = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choice) || choice.length !== 1) {
    throw new Error('llama.cpp did not return exactly one chat completion.');
  }
  if (choice[0]?.finish_reason !== 'stop') {
    const reason = choice[0]?.finish_reason;
    const usage = (
      body as {
        usage?: {
          prompt_tokens?: unknown;
          completion_tokens?: unknown;
          completion_tokens_details?: { reasoning_tokens?: unknown };
        };
      }
    ).usage;
    const counts = [
      typeof usage?.prompt_tokens === 'number' ? `prompt=${usage.prompt_tokens}` : null,
      typeof usage?.completion_tokens === 'number' ? `completion=${usage.completion_tokens}` : null,
      typeof usage?.completion_tokens_details?.reasoning_tokens === 'number'
        ? `reasoning=${usage.completion_tokens_details.reasoning_tokens}`
        : null,
    ].filter(Boolean);
    const detail = counts.length > 0 ? ` Usage: ${counts.join(', ')} tokens.` : '';
    const explanation =
      reason === 'length'
        ? `The model hit the ${COMPLETION_MAX_TOKENS}-token output limit before finishing its structured reply.`
        : reason === 'content_filter'
          ? 'The model reported content filtering.'
          : 'The completion was interrupted or terminated unexpectedly.';
    throw new Error(
      `llama.cpp finish_reason=${JSON.stringify(reason ?? null)}. ${explanation}${detail}`,
    );
  }
  const content: unknown = choice[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('llama.cpp returned no JSON chat content.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('llama.cpp generated malformed JSON.');
  }
  return parsed;
}

export function extractNativeChat(
  body: unknown,
  roster: readonly ChatterIdentity[] = AUDIENCE,
  recentChat: readonly { author: string }[] = [],
): unknown {
  const parsed = parseCompletion(body);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('llama.cpp generated an invalid cycle.');
  }
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.messages)) throw new Error('llama.cpp omitted its chat batch.');
  const allowed = new Map(roster.map((item) => [item.author, item.color]));
  const uses = new Map<string, number>();
  for (const item of recentChat) uses.set(item.author, (uses.get(item.author) ?? 0) + 1);
  const messages = record.messages.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('llama.cpp generated an invalid chat message.');
    }
    const item = entry as Record<string, unknown>;
    let author = item.author;
    if (author === AUTHOR_PLACEHOLDER) {
      const candidate = roster.reduce<ChatterIdentity | null>(
        (best, member) =>
          !best || (uses.get(member.author) ?? 0) < (uses.get(best.author) ?? 0) ? member : best,
        null,
      );
      author = candidate?.author;
    }
    if (typeof author !== 'string' || !allowed.has(author)) {
      throw new Error('llama.cpp generated a chatter outside the configured roster.');
    }
    uses.set(author, (uses.get(author) ?? 0) + 1);
    return { ...item, author, color: allowed.get(author) };
  });
  return { ...record, messages };
}

async function findLoopbackPort(): Promise<number> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No loopback address available.');
    return address.port;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function readBounded(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('llama.cpp returned an empty response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REPLY_BYTES) throw new Error('llama.cpp reply exceeded the size limit.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('llama.cpp returned malformed HTTP JSON.');
  }
}

interface NativeOptions {
  readonly executable: string;
  readonly resolveModel: () => Promise<NativeModelFiles>;
  readonly fetcher?: typeof fetch;
  readonly launch?: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => ChildProcess;
  readonly allocatePort?: () => Promise<number>;
  /** Evaluated when a new worker launches; defaults to non-thinking inference. */
  readonly reasoningEnabled?: () => boolean;
  /** Evaluated per request so saved changes apply without restarting the model. */
  readonly inferenceTimeoutMs?: () => number;
}

/**
 * One private, authenticated loopback llama-server per native session.
 * Abort and process exit invalidate readiness and every in-flight request.
 */
export class NativeInference implements InferenceProvider {
  private child: ChildProcess | null = null;
  private lifecycle: AbortController | null = null;
  private startup: Promise<void> | null = null;
  private port: number | null = null;
  private apiKey: string | null = null;
  private failure: Error | null = null;
  private logTail = '';
  private generation = 0;
  private shutdown: Promise<void> | null = null;
  private status: NativeServiceStatus = { revision: 0, phase: 'stopped', error: null };
  private listeners = new Set<(status: NativeServiceStatus) => void>();

  snapshot(): NativeServiceStatus {
    return { ...this.status };
  }

  subscribe(listener: (status: NativeServiceStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(phase: NativeServiceStatus['phase'], error: string | null = null): void {
    this.status = { revision: this.status.revision + 1, phase, error };
    for (const listener of this.listeners) listener(this.snapshot());
  }

  constructor(private readonly options: NativeOptions) {}

  async prepare(signal: AbortSignal): Promise<void> {
    if (this.shutdown) await this.shutdown;
    if (signal.aborted) throw new Error('Native inference cancelled.');
    if (this.failure) throw this.failure;
    if (this.child && this.port && !this.failure && !this.startup) return;
    if (!this.startup) {
      this.publish('loading');
      const generation = ++this.generation;
      const abort = new AbortController();
      this.lifecycle = abort;
      const task = this.launchServer(generation, abort.signal);
      this.startup = task;
      void task
        .then(
          () => {
            if (generation === this.generation && !this.failure) this.publish('ready');
          },
          (error: unknown) => {
            if (generation !== this.generation) return;
            const failure = error instanceof Error ? error : new Error('Unable to load llama.cpp.');
            this.failure = failure;
            this.publish('failed', failure.message);
          },
        )
        .finally(() => {
          if (this.startup === task) this.startup = null;
        });
    }
    await Promise.race([
      this.startup,
      new Promise<never>((_resolve, reject) => {
        if (signal.aborted) reject(new Error('Native inference cancelled.'));
        else
          signal.addEventListener('abort', () => reject(new Error('Native inference cancelled.')), {
            once: true,
          });
      }),
    ]);
  }

  private async launchServer(generation: number, signal: AbortSignal): Promise<void> {
    const files = await this.options.resolveModel();
    if (signal.aborted || this.generation !== generation)
      throw new Error('Native inference cancelled.');
    const port = await (this.options.allocatePort ?? findLoopbackPort)();
    if (signal.aborted || this.generation !== generation)
      throw new Error('Native inference cancelled.');
    const key = randomBytes(32).toString('hex');
    const args = [
      '--model',
      files.modelPath,
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--api-key',
      key,
      '--no-webui',
      '--ctx-size',
      '4096',
      '--n-gpu-layers',
      '0',
      '--reasoning',
      this.options.reasoningEnabled?.() ? 'on' : 'off',
    ];
    if (files.projectorPath) args.push('--mmproj', files.projectorPath);
    this.port = port;
    this.apiKey = key;
    this.failure = null;
    this.logTail = '';
    const child = (this.options.launch ?? spawn)(this.options.executable, args, {
      cwd: path.dirname(this.options.executable),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([name]) => !name.startsWith('LLAMA_')),
        ),
        ...(process.platform === 'linux'
          ? {
              LD_LIBRARY_PATH: [path.dirname(this.options.executable), process.env.LD_LIBRARY_PATH]
                .filter(Boolean)
                .join(':'),
            }
          : {}),
        ...(process.platform === 'darwin'
          ? {
              DYLD_LIBRARY_PATH: [
                path.dirname(this.options.executable),
                process.env.DYLD_LIBRARY_PATH,
              ]
                .filter(Boolean)
                .join(':'),
            }
          : {}),
      },
    });
    this.child = child;
    const log = (chunk: Buffer) => {
      // Never expose server logs to the overlay; bound memory for diagnostics.
      this.logTail = (this.logTail + chunk.toString('utf8')).slice(-3000);
    };
    child.stdout?.on('data', log);
    child.stderr?.on('data', log);
    child.once('error', (error) => {
      this.failure = new Error(`Unable to launch bundled llama.cpp: ${error.message}`);
      this.publish('failed', this.failure.message);
      this.lifecycle?.abort();
    });
    child.once('exit', (code, termination) => {
      if (this.child !== child) return;
      this.failure = new Error(
        `llama.cpp exited (${termination ?? code ?? 'unknown'}). ${this.logTail.slice(-750)}`,
      );
      this.publish('failed', this.failure.message);
      this.lifecycle?.abort();
    });
    const fetcher = this.options.fetcher ?? fetch;
    const until = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < until) {
      if (this.failure) throw this.failure;
      if (signal.aborted || generation !== this.generation)
        throw new Error('Native inference cancelled.');
      try {
        const response = await fetcher(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]),
        });
        if (response.ok) {
          const health: unknown = await response.json();
          if ((health as { status?: string })?.status === 'ok') return;
        } else if (response.status !== 503) {
          throw new Error(`llama.cpp health check failed (HTTP ${response.status}).`);
        }
      } catch (error) {
        if (this.failure) throw this.failure;
        if (signal.aborted) throw new Error('Native inference cancelled.');
        if (error instanceof Error && error.message.startsWith('llama.cpp health check failed'))
          throw error;
      }
      await delay(200, undefined, { signal });
    }
    throw new Error(`Timed out loading llama.cpp model. ${this.logTail.slice(-750)}`);
  }

  async generateRoster(
    count: number,
    excluded: readonly string[],
    signal: AbortSignal,
  ): Promise<string[]> {
    const prompt = {
      stream: false,
      temperature: 0.85,
      max_tokens: 1024,
      response_format: {
        type: 'json_object',
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['names'],
          properties: {
            names: {
              type: 'array',
              minItems: count,
              maxItems: count,
              items: { type: 'string', pattern: '^[A-Za-z0-9_]{3,24}$' },
            },
          },
        },
      },
      messages: [
        {
          role: 'system',
          content:
            'Generate distinct, varied, plausible live-stream viewer usernames. Only ASCII letters, numbers and underscores, 3-24 characters. Return only the JSON schema. Do not reuse excluded usernames, ignoring case.',
        },
        { role: 'user', content: JSON.stringify({ count, excluded }) },
      ],
    };
    const result = parseCompletion(await this.complete(prompt, signal));
    if (
      !result ||
      typeof result !== 'object' ||
      Array.isArray(result) ||
      Object.keys(result).join(',') !== 'names' ||
      !Array.isArray((result as { names?: unknown }).names)
    ) {
      throw new Error('llama.cpp generated an invalid username list.');
    }
    return (result as { names: string[] }).names;
  }

  async generate(input: InferenceInput, signal: AbortSignal): Promise<unknown> {
    const response = await this.complete(nativeChatRequest(input), signal);
    return extractNativeChat(response, input.roster ?? AUDIENCE, input.recentChat ?? []);
  }

  private async complete(request: unknown, signal: AbortSignal): Promise<unknown> {
    await this.prepare(signal);
    if (signal.aborted || !this.lifecycle || !this.port || !this.apiKey) {
      throw new Error('Native inference cancelled.');
    }
    const timeoutMs = this.options.inferenceTimeoutMs?.() ?? 600_000;
    try {
      const response = await (this.options.fetcher ?? fetch)(
        `http://127.0.0.1:${this.port}/v1/chat/completions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify(request),
          signal: AbortSignal.any([signal, this.lifecycle.signal, AbortSignal.timeout(timeoutMs)]),
        },
      );
      const body = await readBounded(response);
      if (!response.ok) {
        const detail = JSON.stringify(body).slice(0, 500);
        throw new Error(`llama.cpp inference failed (HTTP ${response.status}): ${detail}`);
      }
      if (signal.aborted || this.lifecycle.signal.aborted)
        throw new Error('Native inference cancelled.');
      return body;
    } catch (error) {
      if (this.failure) throw this.failure;
      if (signal.aborted || this.lifecycle?.signal.aborted)
        throw new Error('Native inference cancelled.');
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new Error(
          `llama.cpp inference timed out after ${timeoutMs / 1000} seconds. The model did not finish within the configured request deadline.`,
        );
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    ++this.generation;
    this.publish('stopped');
    this.lifecycle?.abort();
    this.lifecycle = null;
    this.startup = null;
    this.port = null;
    this.apiKey = null;
    this.failure = null;
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const task = (async () => {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill();
      const timeout = new AbortController();
      try {
        await Promise.race([
          exited,
          delay(2000, undefined, { signal: timeout.signal }).catch(() => {}),
        ]);
      } finally {
        timeout.abort();
      }
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await Promise.race([exited, delay(2000)]);
      }
    })();
    this.shutdown = task;
    try {
      await task;
    } finally {
      if (this.shutdown === task) this.shutdown = null;
    }
  }
}
