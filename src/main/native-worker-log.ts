import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { OperationalLogger } from './operational-logger';

export type WorkerLogSink = Pick<OperationalLogger, 'debug' | 'info' | 'warn' | 'error'>;
export type WorkerStream = 'stdout' | 'stderr';

export interface WorkerIdentity {
  readonly worker: string;
  readonly backend: string;
  readonly pid?: number;
}

const MAX_LINE_CHARS = 2048;
const MAX_CHUNK_BYTES = 64 * 1024;
const WINDOW_MS = 60_000;
const MAX_ROUTINE_PER_WINDOW = 400;
const MAX_FAILURE_PER_WINDOW = 80;

/**
 * Native text is untrusted: workers sometimes echo model paths, prompts, HTTP bodies,
 * transcripts and credentials. Only fixed diagnostic categories enter persistent logs.
 * Raw bounded lines are available solely in explicitly enabled private capture.
 */
function safeNativeLine(line: string): { level: 'info' | 'warn' | 'error'; text: string } | null {
  const normalized = line.toLowerCase();
  const category = /\b(?:cuda|cublas|cudnn|cudart|cudamalloc)\b|ggml_cuda/.test(normalized)
    ? 'CUDA'
    : /\b(?:vulkan|vk_error)\b|ggml_vk/.test(normalized)
      ? 'Vulkan'
      : /\b(?:metal|mps)\b|ggml_metal/.test(normalized)
        ? 'Metal'
        : /\b(?:ggml|llama|whisper|model|backend)\b/.test(normalized)
          ? 'Native model'
          : 'Native worker';
  const kind = /out of memory|failed to alloc|allocat\w* fail|cudaerror.*memory/.test(normalized)
    ? 'memory allocation failed'
    : /failed to (?:load|open|read|map) (?:model|weights)|model.*(?:failed to load|load failed)/.test(
          normalized,
        )
      ? 'model loading failed'
      : /(?:initializ|init).*fail|fail.*(?:initializ|init)/.test(normalized)
        ? 'initialization failed'
        : /(?:driver|runtime).*incompat|unsupported.*(?:device|driver|backend)/.test(normalized)
          ? 'driver/backend incompatibility'
          : /device.*(?:not found|unavailable)|no (?:cuda|vulkan|gpu) devices?/.test(normalized)
            ? 'device unavailable'
            : /\b(?:error|fatal|failed|exception)\b/.test(normalized)
              ? 'reported an error'
              : /\bwarn(?:ing)?\b/.test(normalized)
                ? 'reported a warning'
                : /(?:loading model|model loaded|server listening|listening on|ready to serve)/.test(
                      normalized,
                    )
                  ? 'reported startup progress'
                  : null;
  if (!kind) return null;
  // Never interpolate untrusted line substrings, filenames, paths or model output.
  const errorCode = /\b(?:cuda error|vk_error|error code)\s*[:=( ]\s*(\d{1,5})\b/i.exec(line);
  return {
    level: /failed|error|incompatibility|unavailable/.test(kind)
      ? 'error'
      : /warning/.test(kind)
        ? 'warn'
        : 'info',
    text: `${category}: ${kind}${errorCode ? ` (code ${errorCode[1]})` : ''}`,
  };
}

/** Per-instance ordered line framing with hard bounds and an explicit privacy boundary. */
export class NativeWorkerLog {
  readonly id = randomUUID();
  private readonly state: Record<WorkerStream, { decoder: StringDecoder; pending: string }> = {
    stdout: { decoder: new StringDecoder('utf8'), pending: '' },
    stderr: { decoder: new StringDecoder('utf8'), pending: '' },
  };
  private windowStart = Date.now();
  private routineLines = 0;
  private failureLines = 0;
  private latestSuppressedFailure: {
    stream: WorkerStream;
    text: string;
    level: 'warn' | 'error';
  } | null = null;
  private dropped = 0;
  private unclassified = new Set<WorkerStream>();
  private finished = false;

  constructor(
    private readonly source: 'llama.cpp' | 'whisper',
    private readonly sink: WorkerLogSink | undefined,
    private readonly identity: Omit<WorkerIdentity, 'worker'>,
    private readonly privateLine?: (worker: string, stream: WorkerStream, line: string) => void,
  ) {}

  private context(extra: Record<string, string | number | boolean> = {}) {
    return { worker: this.id, ...this.identity, ...extra };
  }

  start(): void {
    this.sink?.info(this.source, 'Native worker started', this.context());
  }

  write(stream: WorkerStream, bytes: Buffer): void {
    if (this.finished) return;
    // For a pathological chunk, retain a bounded prefix, count all omitted bytes.
    if (bytes.length > MAX_CHUNK_BYTES) this.dropped++;
    const value = this.state[stream];
    const decoded = value.decoder.write(bytes.subarray(0, MAX_CHUNK_BYTES));
    let offset = 0;
    for (let index = 0; index < decoded.length; index++) {
      if (decoded[index] !== '\n' && decoded[index] !== '\r') continue;
      this.append(stream, decoded.slice(offset, index));
      this.emit(stream, value.pending);
      value.pending = '';
      offset = index + 1;
      if (decoded[index] === '\r' && decoded[index + 1] === '\n') {
        offset++;
        index++;
      }
    }
    this.append(stream, decoded.slice(offset));
  }

  private append(stream: WorkerStream, part: string): void {
    const state = this.state[stream];
    if (state.pending.length + part.length > MAX_LINE_CHARS) {
      state.pending = (state.pending + part).slice(0, MAX_LINE_CHARS);
      this.dropped++;
    } else {
      state.pending += part;
    }
  }

  private emitSuppressedFailure(): void {
    const tail = this.latestSuppressedFailure;
    this.latestSuppressedFailure = null;
    if (!tail) return;
    this.sink?.[tail.level](
      this.source,
      `${tail.stream}: ${tail.text}`,
      undefined,
      this.context({ stream: tail.stream, code: 'RATE_LIMIT_TAIL' }),
    );
  }

  private permit(failure: boolean): boolean {
    if (Date.now() - this.windowStart >= WINDOW_MS) {
      this.emitSuppressedFailure();
      this.windowStart = Date.now();
      this.routineLines = 0;
      this.failureLines = 0;
    }
    const count = failure ? ++this.failureLines : ++this.routineLines;
    if (count <= (failure ? MAX_FAILURE_PER_WINDOW : MAX_ROUTINE_PER_WINDOW)) return true;
    this.dropped++;
    if (count === (failure ? MAX_FAILURE_PER_WINDOW : MAX_ROUTINE_PER_WINDOW) + 1)
      this.sink?.warn(
        this.source,
        'Native worker output rate limited; later failures remain eligible',
        undefined,
        this.context({ code: 'OUTPUT_LIMIT' }),
      );
    return false;
  }

  private emit(stream: WorkerStream, line: string): void {
    if (!line.trim()) return;
    // Private capture is a separate bounded ring: it must remain available even
    // after routine operational output has been suppressed.
    this.privateLine?.(this.id, stream, line);
    const classified = safeNativeLine(line);
    if (!this.permit(classified?.level === 'error' || classified?.level === 'warn')) {
      if (classified && (classified.level === 'error' || classified.level === 'warn')) {
        this.latestSuppressedFailure = {
          stream,
          text: classified.text,
          level: classified.level,
        };
      }
      return;
    }
    if (!this.sink) return;
    if (!classified) {
      if (!this.unclassified.has(stream)) {
        this.unclassified.add(stream);
        this.sink.debug(
          this.source,
          `Native ${stream} contains private/unclassified output; details omitted (enable private diagnostic capture to export).`,
          this.context({ stream }),
        );
      }
      return;
    }
    // stderr alone does not imply failure (native libraries use it for progress).
    if (classified.level === 'info')
      this.sink.info(this.source, `${stream}: ${classified.text}`, this.context({ stream }));
    else
      this.sink[classified.level](
        this.source,
        `${stream}: ${classified.text}`,
        undefined,
        this.context({ stream }),
      );
  }

  /** Speech stdout is framed binary IPC. Emit metadata, never decoded transcript bytes. */
  protocolReply(operation: 'ready' | 'transcribed' | 'error'): void {
    if (this.finished) return;
    if (!this.permit(operation === 'error')) return;
    this.sink?.debug(
      this.source,
      'stdout: Whisper IPC response received',
      this.context({ stream: 'stdout', operation }),
    );
  }

  finish(exitCode: number | null, signal: NodeJS.Signals | null, expected: boolean): void {
    if (this.finished) return;
    for (const stream of ['stdout', 'stderr'] as const) {
      const state = this.state[stream];
      this.append(stream, state.decoder.end());
      this.emit(stream, state.pending);
      state.pending = '';
    }
    this.finished = true;
    // Preserve the final classified failure even after a continuous error flood.
    // Only safe categories/codes are retained; raw output remains private.
    this.emitSuppressedFailure();
    if (this.dropped) {
      this.sink?.warn(
        this.source,
        'Native worker output exceeded buffering/throughput limits',
        undefined,
        this.context({ code: 'OUTPUT_LIMIT', attempt: this.dropped }),
      );
    }
    const context = this.context({
      phase: expected ? 'stopped' : 'failed',
      ...(exitCode === null ? {} : { exitCode }),
      ...(signal ? { signal } : {}),
    });
    if (expected && (exitCode === 0 || signal)) {
      this.sink?.info(this.source, 'Native worker stopped', context);
    } else {
      this.sink?.error(this.source, 'Native worker exited unexpectedly', undefined, context);
    }
  }

  launchError(error: NodeJS.ErrnoException): void {
    this.sink?.error(
      this.source,
      'Native worker launch failed',
      undefined,
      this.context(error.code ? { code: error.code } : {}),
    );
  }

  runtimeError(operation: string, error?: unknown): void {
    this.sink?.error(
      this.source,
      'Native worker operation failed',
      error,
      this.context({ operation }),
    );
  }
}
