import { stat } from 'node:fs/promises';
import type { InferenceInput, InferenceProvider } from './fake-inference';
import type { NativeInference, NativeModelFiles } from './native-inference';
import { llamaCppAdapter } from './unified-inference-adapters';
import type { UnifiedInferenceAdapter } from './inference-coordinator';

type Role = 'observer' | 'chat' | 'memory';
interface Job<T> {
  role: Role;
  signal: AbortSignal;
  deadline: number;
  run: () => Promise<T>;
  resolve: (result: T) => void;
  reject: (error: unknown) => void;
  dispose: () => void;
}

/** One GPU admission authority for all resident local Split workers. */
export class LocalGpuQueue {
  private waiting: Job<unknown>[] = [];
  private busy = false;
  private consecutiveChats = 0;
  constructor(
    private readonly maxWaiting = 16,
    private readonly now = () => Date.now(),
  ) {}

  get pending(): number {
    return this.waiting.length;
  }

  submit<T>(role: Role, signal: AbortSignal, deadline: number, run: () => Promise<T>): Promise<T> {
    if (signal.aborted) return Promise.reject(new DOMException('Cancelled', 'AbortError'));
    if (this.waiting.length >= this.maxWaiting)
      return Promise.reject(new Error('Local GPU queue is full.'));
    return new Promise<T>((resolve, reject) => {
      const remove = () => {
        const index = this.waiting.indexOf(job as Job<unknown>);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(new DOMException('Cancelled', 'AbortError'));
      };
      const job: Job<T> = {
        role,
        signal,
        deadline,
        run,
        resolve,
        reject,
        dispose: () => signal.removeEventListener('abort', remove),
      };
      signal.addEventListener('abort', remove, { once: true });
      this.waiting.push(job as Job<unknown>);
      this.pump();
    });
  }

  private pump(): void {
    if (this.busy) return;
    for (const job of this.waiting.slice()) {
      if (job.deadline <= this.now()) {
        this.waiting.splice(this.waiting.indexOf(job), 1);
        job.dispose();
        job.reject(new Error('Local GPU admission deadline expired.'));
      }
    }
    if (!this.waiting.length) return;
    // A sustained Chat backlog cannot permanently exclude Vision. Deadline
    // ordering applies within each role, and Chat wins an otherwise tied slot.
    this.waiting.sort(
      (a, b) => (a.role === 'memory' ? 1 : 0) - (b.role === 'memory' ? 1 : 0) ||
        a.deadline - b.deadline || (a.role === b.role ? 0 : a.role === 'chat' ? -1 : 1),
    );
    const visionIndex =
      this.consecutiveChats >= 2 ? this.waiting.findIndex((job) => job.role === 'observer') : -1;
    const job = visionIndex >= 0 ? this.waiting.splice(visionIndex, 1)[0] : this.waiting.shift()!;
    job.dispose();
    this.consecutiveChats = job.role === 'chat' ? this.consecutiveChats + 1 : 0;
    this.busy = true;
    void Promise.resolve()
      .then(job.run)
      .then(job.resolve, job.reject)
      .finally(() => {
        this.busy = false;
        this.pump();
      });
  }

  cancel(): void {
    for (const job of this.waiting.splice(0)) {
      job.dispose();
      job.reject(new DOMException('Cancelled', 'AbortError'));
    }
  }
}

export interface LocalPoolOptions {
  files: (id: string) => Promise<NativeModelFiles>;
  create: (id: string) => NativeInference;
  ramBudgetMiB: () => number;
  vramBudgetMiB: () => number;
  /** Explicit CPU choice does not consume the configured GPU VRAM budget. */
  computeBackend?: () => string;
  timeoutMs: () => number;
  warmIdleMs?: () => number;
  clock?: () => number;
}

/** Owns pinned workers, model-weight admission and explicit release. */
export class LocalModelPool {
  readonly gpu: LocalGpuQueue;
  private workers = new Map<string, NativeInference>();
  private pinned = new Set<string>();
  private unloadTimer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly options: LocalPoolOptions) {
    this.gpu = new LocalGpuQueue(16, options.clock);
  }

  async reserve(ids: readonly string[]): Promise<void> {
    const unique = [...new Set(ids)];
    const unchanged =
      unique.length === this.workers.size && unique.every((id) => this.workers.has(id));
    if (!unchanged) await this.unload();
    if (this.unloadTimer) clearTimeout(this.unloadTimer);
    this.unloadTimer = null;
    const sizes = await Promise.all(
      unique.map(async (id) => {
        const files = await this.options.files(id);
        const model = await stat(files.modelPath);
        const projector = files.projectorPath ? await stat(files.projectorPath) : null;
        return (model.size + (projector?.size ?? 0)) / 1048576;
      }),
    );
    const total = sizes.reduce((a, b) => a + b, 0);
    const ram = this.options.ramBudgetMiB();
    const vram = this.options.vramBudgetMiB();
    const gpuBudgetApplies = this.options.computeBackend?.() !== 'cpu';
    if (total > ram || (gpuBudgetApplies && vram > 0 && total > vram)) {
      await this.unload();
      const ramExceeded = total > ram;
      throw new Error(
        `Local Split models require ~${Math.ceil(total)} MiB of weights, exceeding the configured ${ramExceeded ? 'RAM' : 'VRAM'} target. Select a smaller model${ramExceeded ? '' : ', explicitly choose CPU'}, or increase the resource budget; no automatic backend switching will occur.`,
      );
    }
    try {
      for (const id of unique) {
        if (!this.workers.has(id)) this.workers.set(id, this.options.create(id));
      }
      this.pinned = new Set(unique);
    } catch (error) {
      await this.unload();
      throw error;
    }
  }

  adapter(id: string, role: Role, input: InferenceInput): UnifiedInferenceAdapter {
    const worker = this.workers.get(id);
    if (!worker || !this.pinned.has(id)) throw new Error('Local Split model is not resident.');
    const base = llamaCppAdapter(worker, input);
    return {
      capabilities: base.capabilities,
      complete: (request, signal, observer) =>
        this.gpu.submit(
          role,
          signal,
          (this.options.clock?.() ?? Date.now()) + this.options.timeoutMs(),
          () => base.complete(request, signal, observer),
        ),
    };
  }

  rosterProvider(id: string): InferenceProvider {
    const worker = this.workers.get(id);
    if (!worker || !this.pinned.has(id)) throw new Error('Local Chat model is not resident.');
    return {
      generate: (input, signal, trace) => worker.generate(input, signal, trace),
      generateRoster: (count, excluded, signal, seed) =>
        this.gpu.submit(
          'chat',
          signal,
          (this.options.clock?.() ?? Date.now()) + this.options.timeoutMs(),
          () => worker.generateRoster(count, excluded, signal, seed),
        ),
    };
  }

  async release(): Promise<void> {
    this.gpu.cancel();
    this.pinned.clear();
    const idle = this.options.warmIdleMs?.() ?? 0;
    if (this.unloadTimer) clearTimeout(this.unloadTimer);
    if (idle > 0)
      this.unloadTimer = setTimeout(() => {
        void this.unload();
      }, idle);
    else await this.unload();
  }

  async unload(): Promise<void> {
    if (this.unloadTimer) clearTimeout(this.unloadTimer);
    this.unloadTimer = null;
    this.gpu.cancel();
    this.pinned.clear();
    const workers = [...this.workers.values()];
    this.workers.clear();
    await Promise.all(workers.map((worker) => worker.stop()));
  }
}
