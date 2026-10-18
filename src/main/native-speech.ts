import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import path from 'node:path';
import type { NativeServiceStatus } from '../shared/native-service-contract';
import type { OperationalErrorSink } from './operational-logger';
import { NativeWorkerLog, type WorkerLogSink, type WorkerStream } from './native-worker-log';
import { stat } from 'node:fs/promises';
import {
  MAX_SPEECH_FRAME,
  SPEECH_ERROR,
  SPEECH_INIT,
  SPEECH_READY,
  SPEECH_RESULT,
  SPEECH_TRANSCRIBE,
  SpeechFrameReader,
  speechFrame,
} from './speech-protocol';

interface SpeechOptions {
  readonly executable: string;
  readonly reportError?: OperationalErrorSink;
  readonly log?: WorkerLogSink;
  readonly privateWorkerLine?: (worker: string, stream: WorkerStream, line: string) => void;
  readonly resolveModel: () => Promise<string>;
  readonly launch?: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => ChildProcess;
}

type Pending = { opcode: number; resolve: (text: string) => void; reject: (error: Error) => void };
const START_TIMEOUT_MS = 180_000;
const TRANSCRIBE_TIMEOUT_MS = 180_000;

/** One CPU whisper.cpp process. Strict request/response IPC, bounded memory and cancellation. */
export class NativeSpeech {
  private child: ChildProcess | null = null;
  private pending: Pending | null = null;
  private queue: Pending[] = [];
  private reader = new SpeechFrameReader();
  private workerStop: (() => void) | null = null;
  private workerLog: NativeWorkerLog | null = null;
  private epoch = 0;
  private ready: Promise<void> | null = null;
  private exitTask: Promise<void> = Promise.resolve();
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

  constructor(private readonly options: SpeechOptions) {}

  async start(): Promise<void> {
    if (this.ready) return this.ready;
    const epoch = ++this.epoch;
    this.publish('loading');
    const task = this.launch(epoch);
    this.ready = task;
    try {
      await task;
      if (epoch === this.epoch) this.publish('ready');
    } catch (error) {
      // An obsolete load must not kill a newer worker started after Stop/Restart.
      if (epoch === this.epoch) {
        this.workerLog?.runtimeError('startup');
        this.stop(error instanceof Error ? error : new Error('Speech worker failed.'));
        this.publish('failed', error instanceof Error ? error.message : 'Speech worker failed.');
      }
      throw error;
    }
  }

  private async launch(epoch: number): Promise<void> {
    const model = await this.options.resolveModel();
    if (epoch !== this.epoch) throw new Error('Speech startup cancelled.');
    // The manager has verified the model's hash. Only the worker reads the file.
    const executable = this.options.executable;
    await stat(executable);
    const child = (this.options.launch ?? spawn)(executable, [], {
      cwd: path.dirname(executable),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    if (epoch !== this.epoch) {
      child.kill();
      throw new Error('Speech startup cancelled.');
    }
    this.child = child;
    this.reader = new SpeechFrameReader();
    const worker = new NativeWorkerLog(
      'whisper',
      this.options.log,
      { backend: 'cpu', ...(child.pid ? { pid: child.pid } : {}) },
      this.options.privateWorkerLine,
    );
    this.workerLog = worker;
    worker.start();
    child.stderr?.on('data', (data: Buffer) => worker.write('stderr', data));
    // stdout is binary length-prefixed IPC, not a text log stream. Never persist
    // transcription replies or decode binary output as lines.
    let stopping = false;
    this.workerStop = () => {
      stopping = true;
    };
    child.once('close', (code, signal) => worker.finish(code, signal, stopping));
    child.stdout?.on('data', (chunk: Buffer) => {
      // A retired process may still drain its final stdout bytes. Its binary
      // frames must never reach the next worker's pending request or decoder.
      if (this.child !== child) return;
      try {
        for (const response of this.reader.push(chunk)) {
          worker.protocolReply(
            response.opcode === SPEECH_READY
              ? 'ready'
              : response.opcode === SPEECH_RESULT
                ? 'transcribed'
                : 'error',
          );
          const pending = this.pending;
          if (!pending) throw new Error('Unexpected native speech IPC response.');
          this.pending = null;
          if (response.opcode === SPEECH_ERROR) {
            this.options.privateWorkerLine?.(
              worker.id,
              'stdout',
              response.data.toString('utf8').slice(0, 2048),
            );
            worker.runtimeError('ipc-response');
            pending.reject(
              new Error(`whisper.cpp: ${response.data.toString('utf8').slice(0, 500)}`),
            );
          } else if (response.opcode === pending.opcode) {
            pending.resolve(response.data.toString('utf8'));
          } else {
            pending.reject(new Error('Native speech IPC response type mismatch.'));
            throw new Error('Native speech IPC response type mismatch.');
          }
          this.drain();
        }
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error('Invalid native speech reply.'));
      }
    });
    child.on('error', (error) => {
      worker.launchError(error);
      if (this.child === child)
        this.fail(new Error(`Unable to launch whisper.cpp: ${error.message}`));
    });
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.fail(
        new Error(`whisper.cpp exited (${signal ?? code ?? 'unknown'}). See Logs for details.`),
      );
    });
    await this.send(SPEECH_INIT, SPEECH_READY, Buffer.from(model, 'utf8'), START_TIMEOUT_MS);
    if (epoch !== this.epoch) throw new Error('Speech startup cancelled.');
  }

  async transcribe(samples: Float32Array): Promise<string> {
    if (
      !(samples instanceof Float32Array) ||
      samples.length < 1600 ||
      samples.length > 16_000 * 30
    ) {
      throw new Error('Speech segment must contain 0.1–30 seconds of 16 kHz audio.');
    }
    if (!samples.every((value) => Number.isFinite(value) && Math.abs(value) <= 1.01)) {
      throw new Error('Speech samples must be finite normalized PCM.');
    }
    await this.start();
    const bytes = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
    if (bytes.length + 1 > MAX_SPEECH_FRAME)
      throw new Error('Speech input exceeds IPC frame limit.');
    return (await this.send(SPEECH_TRANSCRIBE, SPEECH_RESULT, bytes, TRANSCRIBE_TIMEOUT_MS)).trim();
  }

  private send(opcode: number, response: number, data: Buffer, timeoutMs: number): Promise<string> {
    const child = this.child;
    if (!child?.stdin || child.stdin.destroyed)
      return Promise.reject(new Error('Speech worker is unavailable.'));
    const frame = speechFrame(opcode, data);
    return new Promise<string>((resolve, reject) => {
      // Only one message in flight. Keep a bounded pending queue.
      if (this.queue.length > 2) {
        reject(new Error('Speech worker queue is full; audio segment dropped.'));
        return;
      }
      const timer = setTimeout(() => {
        reject(new Error(`whisper.cpp request timed out after ${timeoutMs / 1000}s.`));
        this.stop();
      }, timeoutMs);
      timer.unref();
      const wrap: Pending = {
        opcode: response,
        resolve: (text) => {
          clearTimeout(timer);
          resolve(text);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      this.queue.push(wrap);
      // Attach frame to this request without allocating a second unbounded queue.
      this.frames.set(wrap, frame);
      this.drain();
    });
  }

  private frames = new WeakMap<Pending, Buffer>();

  private drain(): void {
    if (this.pending || !this.child?.stdin || !this.queue.length) return;
    const task = this.queue.shift()!;
    const frame = this.frames.get(task)!;
    this.pending = task;
    this.child.stdin.write(frame, (error) => {
      if (error) this.fail(new Error(`Speech IPC write failed: ${error.message}`));
    });
  }

  private fail(error: Error): void {
    if (!this.child) return;
    this.workerLog?.runtimeError('ipc-or-worker');
    this.stop(error);
    this.publish('failed', error.message);
  }

  /** Await retirement even if a crash already initiated Stop before the caller arrived. */
  async shutdown(): Promise<void> {
    this.stop();
    await this.exitTask;
  }

  stop(reason?: Error): void {
    if (!this.child && !this.ready && !this.pending && this.status.phase === 'stopped') return;
    ++this.epoch;
    this.publish('stopped');
    const child = this.child;
    this.child = null;
    if (!reason) this.workerStop?.();
    this.workerStop = null;
    this.workerLog = null;
    this.ready = null;
    this.pending?.reject(reason ?? new Error('Speech transcription stopped.'));
    this.pending = null;
    for (const task of this.queue.splice(0))
      task.reject(reason ?? new Error('Speech transcription stopped.'));
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill();
      const escalation = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 2000);
      escalation.unref();
      this.exitTask = (async () => {
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            exited,
            new Promise<void>((resolve) => {
              deadline = setTimeout(resolve, 4500);
              deadline.unref();
            }),
          ]);
          if (child.exitCode === null && child.signalCode === null) {
            throw new Error('Speech worker did not exit after SIGKILL.');
          }
        } finally {
          clearTimeout(escalation);
          if (deadline) clearTimeout(deadline);
        }
      })();
      void this.exitTask.catch((error: unknown) =>
        this.options.reportError?.('whisper', 'Speech worker retirement failed', error),
      );
    }
  }
}
