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
import type { InferenceTraceObserver } from './inference-trace';
import type { NativeRuntimeResources } from '../shared/native-service-contract';
import type { NativeServiceStatus } from '../shared/native-service-contract';
import type { FreeformRequest, FreeformResult, FreeformUsage } from '../shared/playground-contract';
import type { NativeVideoPreferences } from '../shared/video-tools-contract';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AUDIENCE, type InferenceInput, type InferenceProvider } from './fake-inference';
import {
  buildUnifiedInferenceRequest,
  type UnifiedInferenceRequest,
} from './unified-inference-request';
import { PrivateInferenceError } from './private-inference-error';
import { executeNativeSimulation, SimulationExecutionError } from './simulation-execution';
import { NativeWorkerLog, type WorkerLogSink, type WorkerStream } from './native-worker-log';
import { AUTHOR_PLACEHOLDER, type ChatterIdentity } from '../shared/audience-contract';
import type { ContinuousVideoWindow } from './continuous-video-window';
import { ffmpegNativeVideoEncoder, type NativeVideoEncoder } from './continuous-video-encoder';

export interface NativeModelFiles {
  readonly modelPath: string;
  readonly projectorPath: string | null;
}

const MAX_REPLY_BYTES = 1024 * 1024;
const STARTUP_TIMEOUT_MS = 300_000;
const COMPLETION_MAX_TOKENS = 2048;

/** Only a temporary main-process resolver may replace this diagnostic placeholder. */
export const VIDEO_DATA_PLACEHOLDER = '[video loaded only at transport]';

/** Native video payloads stay out of IPC results, run inspectors, and persisted traces. */
export function withNativeVideoPlaceholder<
  T extends { messages: Array<{ role: string; content: unknown }> },
>(request: T): T {
  const messages = request.messages.map((message) =>
    message.role === 'user'
      ? {
          ...message,
          content: [
            ...(Array.isArray(message.content)
              ? message.content
              : [{ type: 'text', text: message.content }]),
            { type: 'input_video', input_video: { data: VIDEO_DATA_PLACEHOLDER } },
          ],
        }
      : message,
  );
  return { ...request, messages } as T;
}

export function withNativeVideoData(request: unknown, data: string): unknown {
  if (!request || typeof request !== 'object') throw new Error('Invalid native video request.');
  const record = request as { messages?: Array<{ role: string; content: unknown }> };
  if (!Array.isArray(record.messages)) throw new Error('Missing native video messages.');
  let replacements = 0;
  const messages = record.messages.map((message) => ({
    ...message,
    content: Array.isArray(message.content)
      ? message.content.map((part: unknown) => {
          if (
            part &&
            typeof part === 'object' &&
            (part as { type?: string }).type === 'input_video'
          ) {
            const content = part as { input_video?: { data?: string } };
            if (content.input_video?.data !== VIDEO_DATA_PLACEHOLDER)
              throw new Error('Unexpected native video content.');
            replacements++;
            return { type: 'input_video', input_video: { data } };
          }
          return part;
        })
      : message.content,
  }));
  if (replacements !== 1) throw new Error('Expected exactly one native video placeholder.');
  return { ...request, messages };
}

/** Freeform multimodal requests use the same llama.cpp image parts as Session. */
export function nativeFreeformRequest(request: FreeformRequest) {
  const frames = request.frames ?? [];
  return {
    stream: false,
    messages: [
      ...(request.systemPrompt ? [{ role: 'system', content: request.systemPrompt }] : []),
      {
        role: 'user',
        content:
          request.videoMode === 'native-video'
            ? [
                { type: 'text', text: request.userPrompt },
                { type: 'input_video', input_video: { data: VIDEO_DATA_PLACEHOLDER } },
              ]
            : frames.length
              ? [
                  { type: 'text', text: request.userPrompt },
                  ...frames.flatMap((frame, index) => [
                    {
                      type: 'text',
                      text: `Selected frame ${index + 1}, source=${frame.sourceId}${frame.mediaTimeMs === undefined ? '' : `, mediaTimeMs=${frame.mediaTimeMs}`}`,
                    },
                    { type: 'image_url', image_url: { url: frame.dataUrl } },
                  ]),
                ]
              : request.userPrompt,
      },
    ],
    temperature: request.temperature,
    top_p: request.topP,
    top_k: request.topK,
    max_tokens: request.maxTokens,
    seed: request.seed,
    ...(request.responseSchema
      ? { response_format: { type: 'json_object', schema: request.responseSchema } }
      : {}),
  };
}

/** The bundled runtime's json_object format uses the canonical output requirement. */
export {
  UNIFIED_OUTPUT_SCHEMA as INFERENCE_SCHEMA,
  unifiedOutputSchema as inferenceSchema,
} from './unified-inference-request';

export function llamaCppRequest(request: UnifiedInferenceRequest) {
  const content =
    request.content.length === 1 && request.content[0].type === 'text'
      ? request.content[0].text
      : request.content.map((part) =>
          part.type === 'text'
            ? { type: 'text', text: part.text }
            : { type: 'image_url', image_url: { url: part.dataUrl } },
        );
  return {
    stream: false,
    ...(request.sampling.seed === undefined ? {} : { seed: request.sampling.seed }),
    temperature: request.sampling.temperature,
    max_tokens: request.sampling.maxTokens,
    // The pinned llama-server enforces json_object + schema; json_schema was ignored.
    response_format: { type: 'json_object', schema: request.response.schema },
    messages: [
      { role: 'system', content: request.instructions },
      { role: 'user', content },
    ],
  };
}

/** Playground and Simulation share one model-independent Unified prompt builder. */
export function nativeChatRequest(input: InferenceInput) {
  return llamaCppRequest(buildUnifiedInferenceRequest(input));
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

export function extractNativeJson(body: unknown): unknown {
  return parseCompletion(body);
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

async function readBoundedText(response: Response): Promise<string> {
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
  return Buffer.concat(chunks).toString('utf8');
}

async function readBounded(response: Response): Promise<unknown> {
  const raw = await readBoundedText(response);
  try {
    return JSON.parse(raw);
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
  readonly forbidCpuFallback?: boolean;
  /** Optional host FFmpeg directory for llama.cpp native video decoding. */
  readonly videoFfmpegDir?: () => string | null;
  readonly videoPreferences?: NativeVideoPreferences;
  readonly resolveVideo?: (token: string, preferences?: NativeVideoPreferences) => Promise<string>;
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
  private videoReady = false;

  /** True only after the loaded model/projector advertises native video in /props. */
  supportsNativeVideo(): boolean {
    return this.videoReady && Boolean(this.options.videoFfmpegDir?.());
  }

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
    if (this.options.forbidCpuFallback && requested !== 'cpu' && selection.selected === 'cpu')
      throw new Error(
        `The selected ${requested} backend is unavailable. Explicitly select CPU or another model before retrying.`,
      );
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
    // This applies to image_url frames and FFmpeg-extracted input_video frames alike.
    // llama.cpp only honors it on dynamic-resolution vision models.
    if (settings.imageMaxTokens > 0)
      args.push('--image-max-tokens', String(settings.imageMaxTokens));
    const ffmpegDir = this.options.videoFfmpegDir?.();
    if (ffmpegDir) args.push('--video-ffmpeg-dir', ffmpegDir);
    if (this.options.videoPreferences)
      args.push(
        '--video-fps',
        String(this.options.videoPreferences.fps),
        '--video-timestamp-interval',
        String(this.options.videoPreferences.timestampIntervalMs),
      );
    if (selection.device && gpuOffloadLayers > 0) args.push('--device', selection.device);
    if (files.projectorPath) args.push('--mmproj', files.projectorPath);
    this.port = port;
    this.apiKey = key;
    this.failure = null;
    this.visionReady = false;
    this.videoReady = false;
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
      if (this.resources?.backend !== 'cpu' && !this.options.forbidCpuFallback)
        this.fallbackToCpu = true;
      this.failure = new Error(`Unable to launch bundled llama.cpp: ${error.message}`);
      this.publish('failed', this.failure.message);
      this.lifecycle?.abort();
    });
    child.once('exit', (code, termination) => {
      exited = { code, signal: termination };
      if (this.child !== child) return;
      if (this.resources?.backend !== 'cpu' && !this.options.forbidCpuFallback)
        this.fallbackToCpu = true;
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
              const props = (await readBounded(response)) as {
                modalities?: { vision?: unknown; video?: unknown };
              };
              if (props?.modalities?.vision !== true) {
                throw new Error(
                  'Model compatibility check failed: the pinned llama.cpp runtime did not load a vision-capable model/projector pair. Select a matching projector or text-only.',
                );
              }
              this.visionReady = true;
              this.videoReady = props.modalities?.video === true;
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
    seed?: number,
  ): Promise<string[]> {
    const prompt = {
      stream: false,
      temperature: 0.85,
      ...(seed === undefined ? {} : { seed }),
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
    await this.prepare(signal);
    if ((request.frames?.length || request.videoMode === 'native-video') && !this.visionReady)
      throw new Error(
        'Selected model is not vision-capable. Install a matching projector or remove selected frames/video.',
      );
    const draft = nativeFreeformRequest(request);
    const payload =
      request.videoMode === 'native-video'
        ? withNativeVideoData(
            draft,
            await this.resolveNativeVideo(request.video?.token, request.videoOptions),
          )
        : draft;
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
  private async resolveNativeVideo(
    token: string | undefined,
    preferences?: NativeVideoPreferences,
  ): Promise<string> {
    if (!token || !this.options.resolveVideo)
      throw new Error('Native video clips are only supported in Playground.');
    return this.options.resolveVideo(token, preferences);
  }

  /** Run-only native-video transport; the encoded clip never reaches an inspector. */
  async completeSimulationVideoWindow(
    input: InferenceInput,
    request: unknown,
    signal: AbortSignal,
    window: ContinuousVideoWindow,
    encoder?: NativeVideoEncoder,
    requestTimeoutMs?: number,
  ): Promise<unknown> {
    await this.prepare(signal);
    if (!this.videoReady)
      throw new Error(
        'Selected local model has no verified native-video modality; use image frames.',
      );
    const directory = this.options.videoFfmpegDir?.();
    if (!encoder && !directory)
      throw new Error('FFmpeg is required for continuous native-video clips.');
    const encoded = await (
      encoder ??
      ffmpegNativeVideoEncoder(
        path.join(directory!, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
      )
    ).encode(window, signal);
    if (signal.aborted) throw new DOMException('Native video cancelled.', 'AbortError');
    return this.complete(withNativeVideoData(request, encoded), signal, requestTimeoutMs);
  }

  async completeSimulationRequest(
    input: InferenceInput,
    request: unknown,
    signal: AbortSignal,
    videoToken?: string,
    videoOptions?: NativeVideoPreferences,
    requestTimeoutMs?: number,
  ): Promise<unknown> {
    await this.prepare(signal);
    const submittedMessages = (request as { messages?: readonly { content?: unknown }[] } | null)
      ?.messages;
    const hasImages = submittedMessages?.some(
      (message) =>
        Array.isArray(message.content) &&
        message.content.some((part: unknown) =>
          Boolean(
            part &&
            typeof part === 'object' &&
            ['image_url', 'input_video'].includes((part as { type?: string }).type ?? ''),
          ),
        ),
    );
    if ((hasImages || videoToken) && !this.visionReady) {
      throw new Error(
        'Live video requires a model/projector pair verified as vision-capable by the pinned llama.cpp runtime. Install a matching projector or stop video for text-only inference.',
      );
    }
    const payload = videoToken
      ? withNativeVideoData(request, await this.resolveNativeVideo(videoToken, videoOptions))
      : request;
    return this.complete(payload, signal, requestTimeoutMs);
  }

  async generate(
    input: InferenceInput,
    signal: AbortSignal,
    trace?: InferenceTraceObserver,
  ): Promise<unknown> {
    const request = nativeChatRequest(input);
    try {
      const outcome = await executeNativeSimulation(
        input,
        request,
        signal,
        (nativeRequest, activeSignal) =>
          this.completeSimulationRequest(input, nativeRequest, activeSignal),
        (raw, selected) => extractNativeChat(raw, selected.roster ?? AUDIENCE),
        trace,
      );
      return outcome.normalizedResult;
    } catch (error) {
      // Preserve existing native transport/private diagnostics error identity for
      // Session retry policy, while the shared seam records the exact failed stage.
      if (error instanceof SimulationExecutionError) throw error.cause;
      throw error;
    }
  }

  private async complete(
    request: unknown,
    signal: AbortSignal,
    requestTimeoutMs?: number,
  ): Promise<unknown> {
    await this.prepare(signal);
    if (signal.aborted || !this.lifecycle || !this.port || !this.apiKey) {
      throw new Error('Native inference cancelled.');
    }
    // An admitted stage owns its own transport deadline. The global preference
    // only applies when no stage-specific deadline was supplied.
    const timeoutMs = requestTimeoutMs ?? this.options.inferenceTimeoutMs?.() ?? 600_000;
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
      // Keep transport bytes before JSON parsing: error pages and truncated JSON are
      // still evidence for the private Run Inspector, never for operational logs.
      const rawBody = await readBoundedText(response);
      let body: unknown;
      try {
        body = JSON.parse(rawBody);
      } catch {
        throw new PrivateInferenceError('llama.cpp returned malformed HTTP JSON.', {
          httpStatus: response.status,
          responseBody: rawBody,
        });
      }
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
      if (
        (error instanceof Error && error.name === 'TimeoutError') ||
        (signal.aborted && signal.reason instanceof Error && signal.reason.name === 'TimeoutError')
      ) {
        throw new Error(
          `llama.cpp inference timed out after ${timeoutMs / 1000} seconds. The model did not finish within the configured request deadline.`,
        );
      }
      if (signal.aborted || this.lifecycle?.signal.aborted)
        throw new Error('Native inference cancelled.');
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
