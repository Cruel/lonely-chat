import { spawn, execFile, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { stat, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import {
  chooseBackend,
  parseBackendDevices,
  type BackendDevice,
  type ResourceMeasurements,
} from './resource-policy';
import { DEFAULT_PREFERENCES, type SessionPreferences } from '../shared/session-contract';
import type { NativeRuntimeResources } from '../shared/native-service-contract';
import type { NativeServiceStatus } from '../shared/native-service-contract';
import type { FreeformRequest, FreeformResult, FreeformUsage } from '../shared/playground-contract';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AUDIENCE, type InferenceInput, type InferenceProvider } from './fake-inference';
import { PrivateInferenceError } from './private-inference-error';
import { NativeWorkerLog, type WorkerLogSink, type WorkerStream } from './native-worker-log';
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
): unknown {
  const parsed = parseCompletion(body);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('llama.cpp generated an invalid cycle.');
  }
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.messages)) throw new Error('llama.cpp omitted its chat batch.');
  const allowed = new Map(roster.map((item) => [item.author, item.color]));
  const messages = record.messages.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('llama.cpp generated an invalid chat message.');
    }
    const item = entry as Record<string, unknown>;
    const author = item.author;
    if (typeof author !== 'string' || (author !== AUTHOR_PLACEHOLDER && !allowed.has(author))) {
      throw new Error('llama.cpp generated a chatter outside the configured roster.');
    }
    // Transport normalization only. AudienceService owns placeholder selection and
    // authoritative colors after the whole batch has passed schema validation.
    return { ...item, author, color: allowed.get(author) ?? '#000000' };
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
  /** Optional separately bundled CUDA/Vulkan workers, each with adjacent shared libraries. */
  readonly gpuExecutables?: Partial<Record<'cuda' | 'vulkan', string>>;
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
  readonly resourcePreferences?: () => SessionPreferences;
  /** Injectable device detection; production probes the shipped executable. */
  readonly probeDevices?: () => Promise<readonly BackendDevice[]>;
  readonly log?: WorkerLogSink;
  readonly privateWorkerLine?: (worker: string, stream: WorkerStream, line: string) => void;
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
  private generation = 0;
  private shutdown: Promise<void> | null = null;
  private workerStop: (() => void) | null = null;
  private status: NativeServiceStatus = { revision: 0, phase: 'stopped', error: null };
  private listeners = new Set<(status: NativeServiceStatus) => void>();
  private resources: NativeRuntimeResources | null = null;
  /** A failed GPU child must not be selected again by the controller's bounded retry. */
  private fallbackToCpu = false;
  private visionReady = false;

  snapshot(): NativeServiceStatus {
    return { ...this.status, resources: this.resources };
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

  private async devices(): Promise<readonly BackendDevice[]> {
    if (this.options.probeDevices) return this.options.probeDevices();
    const binaries = [
      { executable: this.options.executable, backend: null },
      ...Object.entries(this.options.gpuExecutables ?? {}).map(([backend, executable]) => ({
        executable,
        backend,
      })),
    ];
    const detected: BackendDevice[] = [];
    for (const { executable, backend } of binaries) {
      if (!executable) continue;
      try {
        const { stdout, stderr } = await promisify(execFile)(executable, ['--list-devices'], {
          timeout: 3000,
          maxBuffer: 32 * 1024,
          env: this.processEnvironment(executable),
        });
        detected.push(
          ...parseBackendDevices(stdout + '\n' + stderr).filter(
            (device) => backend === null || device.backend === backend,
          ),
        );
      } catch {
        // Optional accelerator or driver may be unavailable. CPU remains usable.
      }
    }
    return detected;
  }

  private processEnvironment(executable = this.options.executable): NodeJS.ProcessEnv {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith('LLAMA_')),
    );
    const directory = path.dirname(executable);
    if (process.platform === 'linux')
      env.LD_LIBRARY_PATH = [directory, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
    if (process.platform === 'darwin')
      env.DYLD_LIBRARY_PATH = [directory, process.env.DYLD_LIBRARY_PATH].filter(Boolean).join(':');
    return env;
  }

  async resourceMeasurements(): Promise<ResourceMeasurements> {
    const child = this.child;
    if (!child?.pid || process.platform !== 'linux') {
      return { ramUsedMiB: null, vramUsedMiB: null, gpuComputePercent: null };
    }
    try {
      const status = await readFile(`/proc/${child.pid}/status`, 'utf8');
      const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
      const ramUsedMiB = match ? Number(match[1]) / 1024 : null;
      if (this.child === child && this.resources && ramUsedMiB !== this.resources.workerRamMiB) {
        this.resources = { ...this.resources, workerRamMiB: ramUsedMiB };
        this.publish(this.status.phase, this.status.error);
      }
      return { ramUsedMiB, vramUsedMiB: null, gpuComputePercent: null };
    } catch {
      return { ramUsedMiB: null, vramUsedMiB: null, gpuComputePercent: null };
    }
  }

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
    const settings = this.options.resourcePreferences?.() ?? DEFAULT_PREFERENCES;
    const detected = await this.devices();
    if (signal.aborted || this.generation !== generation)
      throw new Error('Native inference cancelled.');
    const requested =
      settings.computeBackend === 'auto' && settings.gpuOffloadLayers === 0
        ? 'cpu'
        : settings.computeBackend;
    const selection = chooseBackend(this.fallbackToCpu ? 'cpu' : requested, detected);
    let diagnostic = selection.warning;
    if (this.fallbackToCpu)
      diagnostic = 'The selected GPU worker failed; retrying with CPU fallback.';
    const appendDiagnostic = (value: string) => {
      diagnostic = diagnostic ? diagnostic + ' ' + value : value;
    };
    let fileSizeMiB: number | null = null;
    try {
      fileSizeMiB = (await stat(files.modelPath)).size / (1024 * 1024);
    } catch {
      /* unavailable in mocked or removed packages */
    }
    if (
      fileSizeMiB !== null &&
      fileSizeMiB > settings.ramBudgetMiB &&
      selection.selected === 'cpu'
    ) {
      appendDiagnostic(
        `Selected GGUF weight file is ${Math.ceil(fileSizeMiB)} MiB, above the advisory RAM target of ${settings.ramBudgetMiB} MiB. Select a smaller model or increase the target; this is not an OS memory limit.`,
      );
    }
    if (signal.aborted || this.generation !== generation)
      throw new Error('Native inference cancelled.');
    if (settings.gpuComputeTargetPercent > 0)
      appendDiagnostic(
        'GPU compute target is a best-effort frame/pacing policy, not a GPU utilization quota.',
      );
    if (settings.vramBudgetMiB > 0)
      appendDiagnostic(
        'VRAM target is advisory; llama.cpp does not provide a guaranteed per-process VRAM ceiling.',
      );
    const gpuOffloadLayers =
      selection.selected === 'cpu' || settings.vramBudgetMiB === 0 ? 0 : settings.gpuOffloadLayers;
    if (selection.selected !== 'cpu' && gpuOffloadLayers === 0)
      appendDiagnostic('GPU offload is disabled (zero layers or zero VRAM target).');
    this.resources = {
      backend: gpuOffloadLayers > 0 ? selection.selected : 'cpu',
      availableBackends: selection.available,
      cpuThreads: settings.cpuThreads,
      contextTokens: settings.contextTokens,
      gpuOffloadLayers,
      ramTargetMiB: settings.ramBudgetMiB,
      vramTargetMiB: settings.vramBudgetMiB,
      gpuComputeTargetPercent: settings.gpuComputeTargetPercent,
      workerRamMiB: null,
      diagnostic,
    };
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
      String(settings.contextTokens),
      '--threads',
      String(settings.cpuThreads),
      '--n-gpu-layers',
      String(gpuOffloadLayers),
      '--reasoning',
      this.options.reasoningEnabled?.() ? 'on' : 'off',
    ];
    if (selection.device && gpuOffloadLayers > 0) args.push('--device', selection.device);
    if (files.projectorPath) args.push('--mmproj', files.projectorPath);
    this.port = port;
    this.apiKey = key;
    this.failure = null;
    this.visionReady = false;
    const executable =
      gpuOffloadLayers > 0 && (selection.selected === 'cuda' || selection.selected === 'vulkan')
        ? (this.options.gpuExecutables?.[selection.selected] ?? this.options.executable)
        : this.options.executable;
    const child = (this.options.launch ?? spawn)(executable, args, {
      cwd: path.dirname(executable),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: this.processEnvironment(executable),
    });
    this.child = child;
    const worker = new NativeWorkerLog(
      'llama.cpp',
      this.options.log,
      { backend: this.resources.backend, ...(child.pid ? { pid: child.pid } : {}) },
      this.options.privateWorkerLine,
    );
    worker.start();
    child.stdout?.on('data', (chunk: Buffer) => worker.write('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => worker.write('stderr', chunk));
    let stopping = false;
    let exited: { code: number | null; signal: NodeJS.Signals | null } = {
      code: null,
      signal: null,
    };
    child.once('close', (code, signal) =>
      worker.finish(code ?? exited.code, signal ?? exited.signal, stopping),
    );
    child.once('error', (error) => {
      worker.launchError(error);
      if (this.child !== child) return;
      if (this.resources?.backend !== 'cpu') this.fallbackToCpu = true;
      this.failure = new Error(`Unable to launch bundled llama.cpp: ${error.message}`);
      this.publish('failed', this.failure.message);
      this.lifecycle?.abort();
    });
    child.once('exit', (code, termination) => {
      exited = { code, signal: termination };
      if (this.child !== child) return;
      if (this.resources?.backend !== 'cpu') this.fallbackToCpu = true;
      this.failure = new Error(
        `llama.cpp exited (${termination ?? code ?? 'unknown'}). See Logs for worker diagnostics.`,
      );
      this.publish('failed', this.failure.message);
      this.lifecycle?.abort();
    });
    // stop() clears the active child before termination; the log retains its own
    // instance identity and deliberately still records its final exit status.
    this.workerStop = () => {
      stopping = true;
    };
    const fetcher = this.options.fetcher ?? fetch;
    const until = performance.now() + STARTUP_TIMEOUT_MS;
    while (performance.now() < until) {
      if (this.failure) throw this.failure;
      if (signal.aborted || generation !== this.generation)
        throw new Error('Native inference cancelled.');
      try {
        const response = await fetcher(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]),
        });
        if (response.ok) {
          const health: unknown = await response.json();
          if ((health as { status?: string })?.status === 'ok') {
            if (files.projectorPath) {
              // b11700 /props reports modalities for the actually loaded model +
              // projector, unlike filename-based Hub companion suggestions.
              const response = await fetcher(`http://127.0.0.1:${port}/props`, {
                headers: { Authorization: `Bearer ${key}` },
                signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
              });
              if (!response.ok)
                throw new Error(
                  'Model compatibility check failed: unable to query loaded modalities.',
                );
              const props = (await readBounded(response)) as { modalities?: { vision?: unknown } };
              if (props?.modalities?.vision !== true) {
                throw new Error(
                  'Model compatibility check failed: the pinned llama.cpp runtime did not load a vision-capable model/projector pair. Select a matching projector or text-only.',
                );
              }
              this.visionReady = true;
            }
            return;
          }
        } else if (response.status !== 503) {
          throw new Error(`llama.cpp health check failed (HTTP ${response.status}).`);
        }
      } catch (error) {
        if (this.failure) throw this.failure;
        if (signal.aborted) throw new Error('Native inference cancelled.');
        if (
          error instanceof Error &&
          (error.message.startsWith('llama.cpp health check failed') ||
            error.message.startsWith('Model compatibility check failed'))
        )
          throw error;
      }
      try {
        await delay(200, undefined, { signal });
      } catch (error) {
        if (this.failure) throw this.failure;
        throw error;
      }
    }
    throw new Error('Timed out loading llama.cpp model. See Logs for worker diagnostics.');
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

  /** Raw freeform text completion; intentionally bypasses simulation prompts and parsers. */
  async completeFreeform(
    request: FreeformRequest,
    signal: AbortSignal,
  ): Promise<Omit<FreeformResult, 'modelId' | 'request'>> {
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const messages = [
      ...(request.systemPrompt ? [{ role: 'system', content: request.systemPrompt }] : []),
      { role: 'user', content: request.userPrompt },
    ];
    const payload = {
      stream: false,
      messages,
      temperature: request.temperature,
      top_p: request.topP,
      top_k: request.topK,
      max_tokens: request.maxTokens,
      seed: request.seed,
    };
    const response = await this.complete(payload, signal);
    if (!response || typeof response !== 'object' || Array.isArray(response))
      throw new Error('llama.cpp returned an invalid Playground response.');
    const body = response as Record<string, unknown>;
    const choices = body.choices;
    if (!Array.isArray(choices) || choices.length !== 1) {
      throw new Error('llama.cpp did not return one Playground completion.');
    }
    const choice = choices[0] as {
      message?: { content?: unknown };
      finish_reason?: unknown;
    } | null;
    if (!choice || typeof choice.message?.content !== 'string') {
      throw new Error('llama.cpp returned no Playground text.');
    }
    const usage = body.usage;
    const usageData =
      usage && typeof usage === 'object' && !Array.isArray(usage)
        ? (usage as Record<string, unknown>)
        : null;
    const token = (key: string) => {
      const n = usageData?.[key];
      return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
    };
    const tokenUsage: FreeformUsage | null = usageData
      ? {
          promptTokens: token('prompt_tokens'),
          completionTokens: token('completion_tokens'),
          totalTokens: token('total_tokens'),
        }
      : null;
    return {
      startedAt,
      durationMs: Math.round(performance.now() - started),
      effectiveSeed: request.seed,
      content: choice.message.content,
      finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
      usage: tokenUsage,
    };
  }

  /** Preserve the original native completion for Simulation Playground inspection. */
  async completeSimulationRequest(
    input: InferenceInput,
    request: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    await this.prepare(signal);
    if (input.frames?.length && !this.visionReady) {
      throw new Error(
        'Live video requires a model/projector pair verified as vision-capable by the pinned llama.cpp runtime. Install a matching projector or stop video for text-only inference.',
      );
    }
    return this.complete(request, signal);
  }

  async generate(input: InferenceInput, signal: AbortSignal): Promise<unknown> {
    const response = await this.completeSimulationRequest(input, nativeChatRequest(input), signal);
    return extractNativeChat(response, input.roster ?? AUDIENCE);
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
        throw new PrivateInferenceError(
          `llama.cpp inference failed (HTTP ${response.status}). Enable private diagnostics to inspect the response.`,
          { httpStatus: response.status, responseBody: body },
        );
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
    // On normal Stop, probe GPU again next time. Failed workers retain CPU fallback
    // through the current session controller's retry/cleanup cycle.
    if (this.status.phase === 'ready') this.fallbackToCpu = false;
    ++this.generation;
    this.resources = null;
    this.publish('stopped');
    this.lifecycle?.abort();
    this.lifecycle = null;
    this.startup = null;
    this.port = null;
    this.apiKey = null;
    this.failure = null;
    this.resources = null;
    const child = this.child;
    this.child = null;
    this.workerStop?.();
    this.workerStop = null;
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
