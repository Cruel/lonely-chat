import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AUDIENCE, type InferenceInput, type InferenceProvider } from './fake-inference';

export interface NativeModelFiles {
  readonly modelPath: string;
  readonly projectorPath: string | null;
}

const ROSTER = Object.fromEntries(AUDIENCE.map(({ author, color }) => [author, color]));
const AUTHORS = AUDIENCE.map(({ author }) => author);
const MAX_REPLY_BYTES = 1024 * 1024;
const STARTUP_TIMEOUT_MS = 120_000;
const INFERENCE_TIMEOUT_MS = 120_000;

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
          author: { type: 'string', enum: AUTHORS },
          text: { type: 'string', minLength: 1, maxLength: 500 },
          offsetMs: { type: 'integer', minimum: 0, maximum: 60000 },
        },
      },
    },
  },
} as const;

/** Prompt snapshots contain no paths, installation metadata or IPC capabilities. */
export function nativeChatRequest(input: InferenceInput) {
  const history = (input.recentEvents ?? []).map((event) => ({
    kind: event.kind,
    summary: event.summary,
    observedAt: event.observedAt,
  }));
  return {
    stream: false,
    temperature: 0.7,
    max_tokens: 800,
    response_format: { type: 'json_schema', schema: INFERENCE_SCHEMA },
    json_schema: INFERENCE_SCHEMA,
    messages: [
      {
        role: 'system',
        content:
          'You simulate a small friendly live-stream audience. From the context, infer at most 3 short events and write 1-4 natural viewer chat messages. ' +
          'Only use the allowed author identities. ageMs is how many milliseconds before now an event happened (use 0 for ongoing context). ' +
          'offsetMs is when to display a chat message after this reply, within the requested playbackWindowMs. ' +
          'Use the provided observations and labeled transcripts to react to new content; maintain continuity with recent chat and events. ' +
          'Return only JSON matching the required schema.',
      },
      {
        role: 'user',
        content: JSON.stringify({
          manualContext: input.context,
          cycle: input.cycle,
          recentEvents: history,
          recentTranscripts: input.recentTranscripts ?? [],
          observations: input.observations ?? [],
          recentChat: input.recentChat ?? [],
          roster: input.roster ?? AUDIENCE,
          observationWindow: input.boundary ?? null,
          playbackWindowMs: input.playbackWindowMs ?? 3000,
        }),
      },
    ],
  };
}

export function extractNativeChat(body: unknown): unknown {
  if (!body || typeof body !== 'object') throw new Error('llama.cpp returned an invalid response.');
  const choice = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choice) || choice.length !== 1) {
    throw new Error('llama.cpp did not return exactly one chat completion.');
  }
  if (choice[0]?.finish_reason !== 'stop') {
    throw new Error('llama.cpp response was incomplete (token limit or interruption).');
  }
  const content: unknown = choice[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('llama.cpp returned no JSON chat content.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('llama.cpp generated malformed JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('llama.cpp generated an invalid cycle.');
  }
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.messages)) throw new Error('llama.cpp omitted its chat batch.');
  const messages = record.messages.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('llama.cpp generated an invalid chat message.');
    }
    const item = entry as Record<string, unknown>;
    if (typeof item.author !== 'string' || !Object.hasOwn(ROSTER, item.author)) {
      throw new Error('llama.cpp generated a chatter outside the configured roster.');
    }
    return { ...item, color: ROSTER[item.author] };
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

  constructor(private readonly options: NativeOptions) {}

  async prepare(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error('Native inference cancelled.');
    if (this.failure) throw this.failure;
    if (this.child && this.port && !this.failure && !this.startup) return;
    if (!this.startup) {
      const generation = ++this.generation;
      const abort = new AbortController();
      this.lifecycle = abort;
      const task = this.launchServer(generation, abort.signal);
      this.startup = task;
      void task
        .finally(() => {
          if (this.startup === task) this.startup = null;
        })
        .catch(() => {});
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
      '--no-mmap', // Explicitly release file handles on stop (especially on Windows).
      '--ctx-size',
      '4096',
      '--n-gpu-layers',
      '0',
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
      this.lifecycle?.abort();
    });
    child.once('exit', (code, termination) => {
      if (this.child !== child) return;
      this.failure = new Error(
        `llama.cpp exited (${termination ?? code ?? 'unknown'}). ${this.logTail.slice(-750)}`,
      );
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

  async generate(input: InferenceInput, signal: AbortSignal): Promise<unknown> {
    await this.prepare(signal);
    if (signal.aborted || !this.lifecycle || !this.port || !this.apiKey) {
      throw new Error('Native inference cancelled.');
    }
    try {
      const response = await (this.options.fetcher ?? fetch)(
        `http://127.0.0.1:${this.port}/v1/chat/completions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify(nativeChatRequest(input)),
          signal: AbortSignal.any([
            signal,
            this.lifecycle.signal,
            AbortSignal.timeout(INFERENCE_TIMEOUT_MS),
          ]),
        },
      );
      const body = await readBounded(response);
      if (!response.ok) {
        const detail = JSON.stringify(body).slice(0, 500);
        throw new Error(`llama.cpp inference failed (HTTP ${response.status}): ${detail}`);
      }
      if (signal.aborted || this.lifecycle.signal.aborted)
        throw new Error('Native inference cancelled.');
      return extractNativeChat(body);
    } catch (error) {
      if (this.failure) throw this.failure;
      if (signal.aborted || this.lifecycle?.signal.aborted)
        throw new Error('Native inference cancelled.');
      throw error;
    }
  }

  async stop(): Promise<void> {
    ++this.generation;
    this.lifecycle?.abort();
    this.lifecycle = null;
    this.startup = null;
    this.port = null;
    this.apiKey = null;
    this.failure = null;
    const child = this.child;
    this.child = null;
    if (!child) return;
    if (child.exitCode !== null || child.signalCode !== null) return;
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
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}
