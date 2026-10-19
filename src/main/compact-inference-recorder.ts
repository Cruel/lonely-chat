import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import type { InferenceTrace } from './inference-trace';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { nativeChatRequest, inferenceSchema, INFERENCE_SCHEMA } from './native-inference';
import type { InferenceInput } from './fake-inference';
import type { TraceAttempt } from '../shared/inference-trace-contract';
import type {
  CompactAttemptSummary,
  CompactReconstruction,
  CompactRecordingStatus,
  InferenceRecordingMode,
  RecordingLimits,
} from '../shared/compact-recording-contract';

type EvidenceKind = 'observation' | 'transcript' | 'event' | 'chat' | 'frame';
type Evidence = { type: 'evidence'; kind: EvidenceKind; id: string; data: Record<string, unknown> };
type AttemptRecord = {
  type: 'attempt';
  summary: CompactAttemptSummary;
  base: Record<string, unknown>;
  selection: Record<string, string[]>;
  details: Record<string, unknown>;
  exact?: { readonly encodedJson: string; readonly sha256: string };
};
type Presentation = {
  type: 'presentation';
  attemptId: string;
  scheduledIndex: number;
  id: string;
  author: string;
  text: string;
  presentedAt: number;
  /** Recorded playback publication time with pause intervals excluded. */
  timelineAt?: number;
};
type PresentationClosed = { type: 'presentation-closed'; runId: number; attemptIds: string[] };
type AttemptStart = { type: 'attempt-start'; summary: CompactAttemptSummary };
type Row = Evidence | AttemptRecord | Presentation | PresentationClosed | AttemptStart;
type IndexRow = {
  type: 'attempt' | 'attempt-start' | 'presentation' | 'presentation-closed';
  chunk: string;
  attemptId: string;
  summary?: CompactAttemptSummary;
  sha256?: string;
};
type Capture = {
  metadata: Parameters<InferenceTrace['begin']>[0];
  patch: Partial<TraceAttempt>;
  mode: InferenceRecordingMode;
  requestJson?: string;
  bytes: number;
};

// Builder fingerprints distinguish app revisions without implying byte-identical prompts.
const BUILDER_VERSION = `native-chat-request-v1:${createHash('sha256')
  .update(
    nativeChatRequest.toString() + inferenceSchema.toString() + JSON.stringify(INFERENCE_SCHEMA),
  )
  .digest('hex')
  .slice(0, 16)}`;
const JPEG = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/;
const ATTEMPT_ID = /^attempt-\d{1,12}$/;
const RECORDING_ID = /^recording-[A-Za-z0-9-]{15,110}$/;

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function sha(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}
function safeId(value: string): void {
  if (!ATTEMPT_ID.test(value)) throw new Error('Invalid recorded attempt ID.');
}
function jsonLine(value: Row | IndexRow): string {
  return JSON.stringify(value) + '\n';
}

/** Replace only transport image URLs; never rewrite matching strings inside user prompts. */
function mapImageUrls(value: unknown, replace: (url: string) => string): unknown {
  if (Array.isArray(value)) return value.map((item) => mapImageUrls(item, replace));
  if (!value || typeof value !== 'object') return value;
  const item = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(item).map(([key, entry]) => {
      if (key === 'image_url' && entry && typeof entry === 'object' && !Array.isArray(entry)) {
        const image = entry as Record<string, unknown>;
        if (typeof image.url === 'string') return [key, { ...image, url: replace(image.url) }];
      }
      return [key, mapImageUrls(entry, replace)];
    }),
  );
}
const EXACT_FRAME_REF = /^exact-jpeg:([a-f0-9]{64})$/;
const CHUNK_SHA = /^[a-f0-9]{64}$/;
const CHUNK_FILE = /^\d{8}\.jsonl\.gz$/;
const DEFAULT_LIMITS: RecordingLimits = { diskBytes: 1024 ** 3, memoryBytes: 64 * 1024 ** 2 };
// Corrupt or unfinished indices cannot force an unbounded recovery scan.
const MAX_INDEX_BYTES = 128 * 1024 * 1024;
const MAX_RECOVERY_CHUNKS = 8192;
const MAX_CHUNK_BYTES = 16 * 1024 * 1024;
// Recent deduplication is only an optimization. Old IDs remain discoverable on disk.
const MAX_CACHED_EVIDENCE_IDS = 2048;
const MAX_CACHED_FRAME_HASHES = 512;
class RecordingLimitExceeded extends Error {}

function snapshotBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? 'null');
}

/**
 * Append-only, opt-in compact evidence storage. Each committed attempt is an independently
 * readable gzip JSONL chunk. The index is appended only AFTER chunk and referenced JPEG files
 * are fully written. Neither source video/audio nor duplicate reconstructed prompts are saved.
 *
 * Capture holds the selected input independently of the bounded inspector so eviction can't
 * discard in-flight evidence. Queue writes are serialized to preserve record ordering.
 */
export class CompactInferenceRecorder {
  private enabled = false;
  private mode: InferenceRecordingMode = 'compact';
  private directory: string | null = null;
  private recordingId: string | null = null;
  private serialByDirectory = new Map<string, number>();
  private attempts = 0;
  private bytes = 0;
  private totalBytes = 0;
  private chunks = 0;
  private error: string | null = null;
  private warning: string | null = null;
  private partial = false;
  private finalizingDirectory: string | null = null;
  private limits: RecordingLimits = { ...DEFAULT_LIMITS };
  private frames = new Set<string>();
  private overLimitDirectories = new Set<string>();
  private captureLimited = false;
  private pending = new Map<string, Capture>();
  /** Terminal snapshots remain reserved until their actual asynchronous write settles. */
  private queued = new Map<string, Capture>();
  private queuedPresentationBytes = 0;
  private seen = new Set<string>();
  private indexedDirs = new Map<string, string>();
  private indexedRun = new Map<string, number>();
  private indexedStage = new Map<string, TraceAttempt['stage']>();
  private presented = new Set<string>();
  // Run IDs increase monotonically within one process; no growing tombstone set is needed.
  private closedThroughRunId = -1;
  private broken = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly root: string,
    private readonly onError: (error: unknown) => void = () => {},
  ) {}

  status(): CompactRecordingStatus {
    return {
      enabled: this.enabled,
      mode: this.mode,
      recordingId: this.recordingId,
      attempts: this.attempts,
      chunks: this.chunks,
      bytes: this.bytes,
      totalBytes: this.totalBytes,
      error: this.error,
      warning: this.warning,
      partial: this.partial,
      finalizing: this.finalizingDirectory ? this.pending.size : 0,
      limits: { ...this.limits },
      memoryBytes: this.memoryUsed(),
    };
  }

  /** Limits apply only to opt-in session evidence, never to independently saved cases. */
  async loadLimits(): Promise<void> {
    this.totalBytes = await this.measureArchiveUsage();
    try {
      const value: unknown = JSON.parse(
        await readFile(path.join(this.root, 'compact-inference', 'limits.json'), 'utf8'),
      );
      if (this.validLimits(value)) this.limits = { ...value };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        this.onError(new Error('Unable to read recording limits; using safe defaults.'));
    }
  }

  /** Bounded startup scan of private archive storage. An excessive tree fails closed. */
  private async measureArchiveUsage(): Promise<number> {
    const base = path.join(this.root, 'compact-inference');
    let files = 0;
    const sizeOf = async (dir: string, depth: number): Promise<number> => {
      if (depth > 2) return Number.MAX_SAFE_INTEGER;
      let entries: import('node:fs').Dirent<string>[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
        throw error;
      }
      let total = 0;
      for (const entry of entries) {
        if (++files > 100000) return Number.MAX_SAFE_INTEGER;
        const child = path.join(dir, entry.name);
        if (entry.isDirectory()) total += await sizeOf(child, depth + 1);
        else if (entry.isFile()) total += (await stat(child)).size;
        if (!Number.isSafeInteger(total)) return Number.MAX_SAFE_INTEGER;
      }
      return total;
    };
    let recordings: string[];
    try {
      recordings = (await readdir(base, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && RECORDING_ID.test(entry.name))
        .map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
    let total = 0;
    for (const recording of recordings) {
      total += await sizeOf(path.join(base, recording), 0);
      if (!Number.isSafeInteger(total)) return Number.MAX_SAFE_INTEGER;
    }
    return total;
  }

  private validLimits(value: unknown): value is RecordingLimits {
    const limits = value as RecordingLimits | null;
    return (
      !!limits &&
      [limits.diskBytes, limits.memoryBytes].every(
        (number) => Number.isSafeInteger(number) && number >= 1024 && number <= 1024 ** 4,
      )
    );
  }

  async setLimits(limits: RecordingLimits): Promise<CompactRecordingStatus> {
    if (!this.validLimits(limits)) throw new Error('Invalid recording storage limits.');
    const dir = path.join(this.root, 'compact-inference');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(dir, 'limits.json'), JSON.stringify(limits), { mode: 0o600 });
    this.limits = { ...limits };
    if (this.enabled && this.totalBytes >= limits.diskBytes)
      this.limitReached(
        'Disk recording limit reached; further recording is disabled.',
        this.directory,
        true,
      );
    return this.status();
  }

  /** A fresh recording begins at the next attempt. Already captured attempts finish on disable. */
  async configure(
    enabled: boolean,
    mode: InferenceRecordingMode = 'compact',
    partial = false,
  ): Promise<CompactRecordingStatus> {
    if (typeof enabled !== 'boolean' || (mode !== 'compact' && mode !== 'exact'))
      throw new Error('Invalid inference recording configuration.');
    if (enabled === this.enabled) {
      if (enabled && mode !== this.mode)
        throw new Error('Stop the current recording before switching capture modes.');
      return this.status();
    }
    if (enabled) {
      if (this.pending.size || this.queued.size)
        throw new Error(
          'Cannot start a new recording until the previous captured attempts finish.',
        );
      await this.flush();
      this.totalBytes = await this.measureArchiveUsage();
      if (this.totalBytes >= this.limits.diskBytes)
        throw new Error(
          'Recording disk limit reached across saved session archives. Increase the limit to start a new recording; saved cases remain untouched.',
        );
      this.finalizingDirectory = null;
      this.partial = partial;
      this.recordingId = `recording-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
      this.directory = path.join(this.root, 'compact-inference', this.recordingId);
      await mkdir(path.join(this.directory, 'frames'), { recursive: true, mode: 0o700 });
      await mkdir(path.join(this.directory, 'chunks'), { recursive: true, mode: 0o700 });
      const manifest = JSON.stringify({
        format: 'lonely-chat-compact',
        version: 1,
        builderVersion: BUILDER_VERSION,
        mode,
        partial,
      });
      await writeFile(path.join(this.directory, 'manifest.json'), manifest, {
        flag: 'wx',
        mode: 0o600,
      });
      this.mode = mode;
      this.overLimitDirectories.clear();
      this.captureLimited = false;
      // Keep sequence state only for older runs with chat still eligible to publish.
      const liveDirs = new Set(this.indexedDirs.values());
      for (const old of this.serialByDirectory.keys())
        if (!liveDirs.has(old)) this.serialByDirectory.delete(old);
      this.serialByDirectory.set(this.directory, 0);
      this.attempts = 0;
      this.bytes = Buffer.byteLength(manifest);
      this.totalBytes += this.bytes;
      this.chunks = 0;
      this.seen.clear();
      this.frames.clear();
      this.error = null;
      this.warning = partial
        ? 'Recording began mid-session; earlier observations and attempts are not included.'
        : null;
      this.broken = false;
    }
    this.enabled = enabled;
    if (!enabled && this.directory) {
      this.finalizingDirectory = this.directory;
      this.finalizeIfDrained();
    }
    return this.status();
  }

  begin(id: string, metadata: Parameters<InferenceTrace['begin']>[0]): void {
    if (!this.enabled || !this.directory) return;
    safeId(id);
    // Deep copy at the capture boundary, not after another cycle can mutate its input.
    try {
      const frozen = structuredClone(metadata);
      const bytes = snapshotBytes(frozen);
      if (this.memoryUsed() + bytes * 2 + 256 > this.limits.memoryBytes) {
        this.limitReached('Recording memory limit reached; later attempts are excluded.');
        return;
      }
      this.pending.set(id, { metadata: frozen, patch: {}, mode: this.mode, bytes });
      this.indexedRun.set(id, metadata.runId);
      const summary = this.summaryForStart(id, metadata);
      const dir = this.directory;
      this.enqueue(() =>
        this.chunk(dir, [{ type: 'attempt-start', summary }], {
          type: 'attempt-start',
          attemptId: id,
          chunk: '',
          summary,
        }),
      );
    } catch {
      this.captureError('Unable to snapshot selected inference input.');
    }
  }

  update(id: string, patch: Partial<TraceAttempt>): void {
    const item = this.pending.get(id);
    if (!item) return;
    // Capture the actual JSON transport representation when the native request is constructed.
    // Compact continues to omit it, even while the ephemeral inspector retains the request.
    const { request, ...compactPatch } = patch;
    try {
      if (item.mode === 'exact' && request != null) {
        const json = JSON.stringify(request);
        if (!json) throw new Error('The constructed request is not JSON serializable.');
        item.requestJson = json;
      }
      Object.assign(item.patch, structuredClone(compactPatch));
      item.bytes =
        snapshotBytes(item.metadata) +
        snapshotBytes(item.patch) +
        (item.requestJson ? Buffer.byteLength(item.requestJson) : 0);
      if (this.memoryUsed() > this.limits.memoryBytes)
        this.limitReached(
          'Recording memory limit reached; in-flight attempts will finish, but later attempts are excluded.',
        );
    } catch {
      this.pending.delete(id);
      this.captureError('Unable to snapshot an inference result for compact recording.');
      return;
    }
    if (patch.stage === 'scheduled' || patch.stage === 'failed' || patch.stage === 'cancelled') {
      this.pending.delete(id);
      // Transfer the reservation without a gap: the promise chain still owns these values.
      this.queued.set(id, item);
      const snapshot = { ...item.metadata, ...item.patch, id } as unknown as TraceAttempt;
      this.enqueue(async () => {
        try {
          await this.saveAttempt(snapshot, item);
        } finally {
          this.queued.delete(id);
          if (this.enabled && this.memoryUsed() > this.limits.memoryBytes)
            this.limitReached('Recording memory limit reached while retaining attempt references.');
        }
      });
      this.finalizeIfDrained();
    }
  }

  present(
    id: string,
    message: {
      id: string;
      author: string;
      text: string;
      presentedAt: number;
      timelineAt?: number;
    },
    scheduledIndex: number,
  ): void {
    if (!ATTEMPT_ID.test(id) || !Number.isInteger(scheduledIndex) || scheduledIndex < 0) return;
    const run = this.indexedRun.get(id);
    // Close is synchronous; a presentation already queued before Close still belongs in the record.
    if (run === undefined || run <= this.closedThroughRunId || this.captureLimited || this.broken)
      return;
    const reservedBytes = snapshotBytes(message) * 2 + 256;
    if (this.memoryUsed() + reservedBytes > this.limits.memoryBytes) {
      this.limitReached('Recording memory limit reached while queuing chat presentations.');
      return;
    }
    this.queuedPresentationBytes += reservedBytes;
    this.enqueue(async () => {
      try {
        const dir = this.indexedDirs.get(id);
        const key = `${id}:${scheduledIndex}`;
        if (!dir || this.indexedStage.get(id) !== 'scheduled' || this.presented.has(key)) return;
        const row: Presentation = {
          type: 'presentation',
          attemptId: id,
          scheduledIndex,
          ...message,
        };
        await this.chunk(dir, [row], { type: 'presentation', attemptId: id, chunk: '' });
        this.presented.add(key);
      } finally {
        this.queuedPresentationBytes = Math.max(0, this.queuedPresentationBytes - reservedBytes);
        if (this.memoryUsed() > this.limits.memoryBytes)
          this.limitReached(
            'Recording memory limit reached while retaining presentation references.',
          );
      }
    });
  }

  cancelPending(runId: number): void {
    for (const [id, item] of this.pending) {
      if (item.metadata.runId === runId) {
        this.update(id, {
          stage: 'cancelled',
          errorStage: (item.patch.stage ?? 'preparing') as TraceAttempt['stage'],
          error: 'Simulation stopped or model changed before completion.',
        });
      }
    }
  }

  /** Explicitly mark queued chat as closed when the Run ends, even after trace eviction. */
  closePresentation(runId: number): void {
    if (runId <= this.closedThroughRunId) return;
    this.closedThroughRunId = runId;
    // Sessions without any recorded inference must not grow the write queue.
    if (![...this.indexedRun.values()].includes(runId)) return;
    this.enqueue(async () => {
      const grouped = new Map<string, string[]>();
      for (const [id, dir] of this.indexedDirs) {
        if (this.indexedRun.get(id) !== runId) continue;
        const ids = grouped.get(dir) ?? [];
        ids.push(id);
        grouped.set(dir, ids);
      }
      try {
        for (const [dir, attemptIds] of grouped) {
          await this.chunk(dir, [{ type: 'presentation-closed', runId, attemptIds }], {
            type: 'presentation-closed',
            attemptId: `run-${runId}`,
            chunk: '',
          });
        }
      } finally {
        // Presentation identity state is needed only while a Run can publish chat.
        for (const [id, owner] of this.indexedRun) {
          if (owner !== runId) continue;
          this.indexedRun.delete(id);
          this.indexedDirs.delete(id);
          this.indexedStage.delete(id);
          for (const key of this.presented)
            if (key.startsWith(`${id}:`)) this.presented.delete(key);
        }
        for (const dir of grouped.keys()) {
          if (dir !== this.directory && ![...this.indexedDirs.values()].includes(dir))
            this.serialByDirectory.delete(dir);
        }
      }
    });
  }

  async flush(): Promise<void> {
    await this.chain;
  }

  private memoryUsed(): number {
    // JSON byte lengths approximate encoded capture size; 2x covers UTF-16 strings.
    // Reserve for queued terminal snapshots as well as still-running inference.
    let used = this.queuedPresentationBytes;
    for (const item of this.pending.values()) used += item.bytes * 2 + 256;
    for (const item of this.queued.values()) used += item.bytes * 2 + 256;
    // Retained deduplication and publication identities are part of the budget too.
    for (const id of this.seen) used += id.length * 2 + 128;
    for (const hash of this.frames) used += hash.length * 2 + 128;
    for (const id of this.indexedRun.keys()) used += id.length * 2 + 192;
    for (const [id, dir] of this.indexedDirs) used += (id.length + dir.length) * 2 + 192;
    for (const id of this.indexedStage.keys()) used += id.length * 2 + 128;
    for (const id of this.presented) used += id.length * 2 + 128;
    for (const dir of this.serialByDirectory.keys()) used += dir.length * 2 + 128;
    return used;
  }

  private remember(set: Set<string>, key: string, max: number): void {
    if (set.has(key)) return;
    set.add(key);
    if (set.size > max) set.delete(set.values().next().value!);
  }

  private summaryForStart(
    id: string,
    metadata: Parameters<InferenceTrace['begin']>[0],
  ): CompactAttemptSummary {
    return {
      recordingId: this.recordingId!,
      mode: this.mode,
      id,
      runId: metadata.runId,
      cycle: metadata.cycle,
      attempt: metadata.attempt,
      seed: metadata.seed,
      modelId: metadata.modelId,
      startedAt: metadata.startedAt,
      durationMs: null,
      stage: 'preparing',
      chunk: '',
    };
  }

  private finalizeIfDrained(): void {
    const dir = this.finalizingDirectory;
    if (!dir || this.pending.size) return;
    this.finalizingDirectory = null;
    this.enqueue(async () => {
      if (this.overLimitDirectories.has(dir)) return;
      // A marker written only after every queued chunk makes interrupted shutdowns recognizable.
      const marker = JSON.stringify({ finalizedAt: new Date().toISOString() });
      this.ensureDiskBudget(dir, Buffer.byteLength(marker));
      await writeFile(path.join(dir, 'complete.json'), marker, { flag: 'wx', mode: 0o600 });
      if (dir === this.directory) this.bytes += Buffer.byteLength(marker);
      this.totalBytes += Buffer.byteLength(marker);
    });
  }

  private limitReached(
    message: string,
    affectedDirectory = this.directory,
    blockWrites = false,
  ): void {
    if (!this.warning || !this.warning.includes('limit')) this.warning = message;
    this.enabled = false;
    this.captureLimited = true;
    // A memory backlog stops admission but must not throw away already accepted
    // terminal outcomes. Only exhausted disk capacity prohibits queued writes.
    if (blockWrites) {
      if (this.directory) this.overLimitDirectories.add(this.directory);
      if (affectedDirectory) this.overLimitDirectories.add(affectedDirectory);
    }
    // Do not mark this archive complete: pending/outstanding evidence may not fit.
    this.finalizingDirectory = null;
  }

  private ensureDiskBudget(dir: string, additionalBytes: number): void {
    if (this.overLimitDirectories.has(dir)) throw new RecordingLimitExceeded();
    if (this.totalBytes + additionalBytes > this.limits.diskBytes) {
      this.limitReached(
        'Disk recording limit reached; further evidence is not captured. Saved cases are untouched.',
        dir,
        true,
      );
      throw new RecordingLimitExceeded();
    }
  }

  private enqueue(write: () => Promise<void>): void {
    this.chain = this.chain
      .then(() => (this.broken ? undefined : write()))
      .catch((error: unknown) => {
        if (error instanceof RecordingLimitExceeded) return;
        this.captureError(
          'Unable to save compact recording to disk. Earlier indexed chunks remain readable.',
        );
      });
  }

  private captureError(message: string): void {
    this.error = message;
    this.enabled = false;
    this.broken = true;
    this.pending.clear();
    this.queued.clear();
    this.queuedPresentationBytes = 0;
    this.finalizingDirectory = null;
    this.onError(new Error(message));
  }

  private async chunk(dir: string, rows: readonly Row[], index: IndexRow): Promise<void> {
    const serial = (this.serialByDirectory.get(dir) ?? 0) + 1;
    this.serialByDirectory.set(dir, serial);
    const name = `${String(serial).padStart(8, '0')}.jsonl.gz`;
    const bytes = gzipSync(rows.map(jsonLine).join(''), { level: 6 });
    if (bytes.byteLength > MAX_CHUNK_BYTES) {
      this.limitReached(
        'One compressed chunk exceeds the archive size limit; recording stopped.',
        dir,
        true,
      );
      throw new RecordingLimitExceeded();
    }
    const indexLine = jsonLine({ ...index, chunk: name, sha256: sha(bytes) });
    this.ensureDiskBudget(dir, bytes.byteLength + Buffer.byteLength(indexLine));
    await writeFile(path.join(dir, 'chunks', name), bytes, { flag: 'wx', mode: 0o600 });
    await appendFile(path.join(dir, 'index.jsonl'), indexLine, { mode: 0o600 });
    if (dir === this.directory) {
      this.chunks++;
      this.bytes += bytes.byteLength + Buffer.byteLength(indexLine);
    }
    this.totalBytes += bytes.byteLength + Buffer.byteLength(indexLine);
  }

  private async saveAttempt(attempt: TraceAttempt, capture: Capture): Promise<void> {
    const dir = this.directory;
    if (!dir) return;
    const input = object(attempt.input);
    const selection = object(input.captureSelection);
    const entries: Row[] = [];
    const references: Record<string, string[]> = {};
    const emit = (kind: EvidenceKind, id: string, data: Record<string, unknown>): void => {
      if (!this.seen.has(id)) {
        entries.push({ type: 'evidence', kind, id, data });
        this.remember(this.seen, id, MAX_CACHED_EVIDENCE_IDS);
      }
    };
    const run = attempt.runId;
    const captureEvidence = (
      kind: Exclude<EvidenceKind, 'frame'>,
      values: unknown,
      ids: unknown,
    ): void => {
      const chosen = array(values);
      const provided = array(ids);
      references[kind] = chosen.map((value, index) => {
        const key = provided[index];
        if (typeof key !== 'string' && typeof key !== 'number')
          throw new Error(`Missing ${kind} selection ID for compact attempt ${attempt.id}.`);
        const id = `${run}:${kind}:${key}`;
        emit(kind, id, { ...object(value), order: index });
        return id;
      });
    };
    captureEvidence('observation', input.observations, selection.observations);
    captureEvidence('transcript', input.recentTranscripts, selection.transcripts);
    captureEvidence('event', input.recentEvents, selection.events);
    captureEvidence('chat', input.recentChat, selection.chat);
    references.frame = [];
    const selectedJpegs = new Set<string>();
    const pendingFrames = new Map<string, Buffer>();
    for (const [index, value] of array(input.frames).entries()) {
      const frame = object(value);
      const match = typeof frame.dataUrl === 'string' ? JPEG.exec(frame.dataUrl) : null;
      if (!match) throw new Error('Selected JPEG was unavailable for compact recording.');
      const buffer = Buffer.from(match[1], 'base64');
      const digest = sha(buffer);
      selectedJpegs.add(digest);
      const frameId = `${run}:frame:${sha(
        JSON.stringify([frame.sourceId, frame.observedAt, frame.mediaTimeMs, digest]),
      )}`;
      const filename = `${digest}.jpg`;
      // Reserve disk budget before writing any blobs so an oversized attempt leaves no
      // partial media alongside a missing outcome. Content hashes deduplicate frames.
      if (!this.frames.has(digest)) pendingFrames.set(digest, buffer);
      emit('frame', frameId, {
        sourceId: frame.sourceId,
        observedAt: frame.observedAt,
        ...(frame.mediaTimeMs === undefined ? {} : { mediaTimeMs: frame.mediaTimeMs }),
        width: frame.width,
        height: frame.height,
        jpeg: filename,
        order: index,
      });
      references.frame.push(frameId);
    }
    const {
      frames: _frames,
      recentTranscripts: _transcripts,
      observations: _observations,
      recentEvents: _events,
      recentChat: _chat,
      captureSelection: _selection,
      ...base
    } = input;
    const { request: _request, input: _input, ...rest } = attempt;
    const summary: CompactAttemptSummary = {
      mode: capture.mode,
      recordingId: this.recordingId!,
      id: attempt.id,
      runId: attempt.runId,
      cycle: attempt.cycle,
      attempt: attempt.attempt,
      seed: attempt.seed,
      modelId: attempt.modelId,
      startedAt: attempt.startedAt,
      durationMs: attempt.durationMs ?? null,
      stage: attempt.stage,
      chunk: '',
    };
    let exact: AttemptRecord['exact'];
    if (capture.mode === 'exact' && capture.requestJson !== undefined) {
      const original = capture.requestJson;
      const encoded = mapImageUrls(JSON.parse(original), (url) => {
        const match = JPEG.exec(url);
        if (!match) throw new Error('Exact native request contains a non-JPEG image.');
        const bytes = Buffer.from(match[1], 'base64');
        const hash = sha(bytes);
        if (!selectedJpegs.has(hash))
          throw new Error('Exact request image does not match the selected input frames.');
        return `exact-jpeg:${hash}`;
      });
      exact = { encodedJson: JSON.stringify(encoded), sha256: sha(original) };
    }
    entries.push({
      type: 'attempt',
      summary,
      base,
      selection: references,
      details: { ...rest, originalSelection: selection, builderVersion: BUILDER_VERSION },
      ...(exact ? { exact } : {}),
    } as AttemptRecord);
    // The bounded in-memory frame hash cache may have evicted an older digest.
    // Check disk before reserving quota; an existing blob costs zero new bytes.
    for (const digest of pendingFrames.keys()) {
      const file = path.join(dir, 'frames', `${digest}.jpg`);
      try {
        if ((await stat(file)).isFile()) {
          pendingFrames.delete(digest);
          this.remember(this.frames, digest, MAX_CACHED_FRAME_HASHES);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const projectedChunk = gzipSync(entries.map(jsonLine).join(''), { level: 6 });
    const serial = (this.serialByDirectory.get(dir) ?? 0) + 1;
    const name = `${String(serial).padStart(8, '0')}.jsonl.gz`;
    const projectedIndex = jsonLine({
      type: 'attempt',
      attemptId: attempt.id,
      chunk: name,
      summary,
      sha256: sha(projectedChunk),
    });
    this.ensureDiskBudget(
      dir,
      projectedChunk.byteLength +
        Buffer.byteLength(projectedIndex) +
        [...pendingFrames.values()].reduce((total, frame) => total + frame.byteLength, 0),
    );
    for (const [digest, buffer] of pendingFrames) {
      try {
        await writeFile(path.join(dir, 'frames', `${digest}.jpg`), buffer, {
          flag: 'wx',
          mode: 0o600,
        });
        if (dir === this.directory) this.bytes += buffer.byteLength;
        this.totalBytes += buffer.byteLength;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      this.remember(this.frames, digest, MAX_CACHED_FRAME_HASHES);
    }
    await this.chunk(dir, entries, { type: 'attempt', attemptId: attempt.id, chunk: '', summary });
    if (attempt.stage === 'scheduled' && attempt.runId > this.closedThroughRunId) {
      this.indexedDirs.set(attempt.id, dir);
      this.indexedRun.set(attempt.id, attempt.runId);
      this.indexedStage.set(attempt.id, attempt.stage);
    } else {
      this.indexedRun.delete(attempt.id);
      this.indexedDirs.delete(attempt.id);
      this.indexedStage.delete(attempt.id);
    }
    if (dir === this.directory) this.attempts++;
  }

  /** All previously completed recordings remain discoverable after an application restart. */
  async list(): Promise<CompactAttemptSummary[]> {
    await this.flush();
    const base = path.join(this.root, 'compact-inference');
    let recordings: string[];
    try {
      recordings = (await readdir(base, { withFileTypes: true }))
        .filter((item) => item.isDirectory())
        .map((item) => item.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const results: CompactAttemptSummary[] = [];
    for (const recordingId of recordings.filter((id) => RECORDING_ID.test(id)).sort()) {
      const dir = path.join(base, recordingId);
      const index = await this.readIndex(dir);
      const complete = await stat(path.join(dir, 'complete.json')).then(
        () => true,
        () => false,
      );
      let partial = false;
      try {
        const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as {
          partial?: boolean;
        };
        partial = manifest.partial === true;
      } catch {
        /* A missing or damaged manifest must not hide recoverable chunks. */
      }
      const attempts = new Map<string, CompactAttemptSummary>();
      const finished = new Set<string>();
      for (const item of index) {
        if ((item.type !== 'attempt-start' && item.type !== 'attempt') || !item.summary) continue;
        if (item.type === 'attempt') finished.add(item.attemptId);
        const previous = attempts.get(item.attemptId);
        if (previous && item.type === 'attempt-start') continue;
        attempts.set(item.attemptId, {
          ...item.summary,
          mode: item.summary.mode ?? 'compact',
          recordingId,
          chunk: item.chunk,
          archiveStatus: complete ? 'complete' : 'incomplete',
          partial,
        });
      }
      for (const [id, summary] of attempts) {
        results.push(
          finished.has(id)
            ? summary
            : {
                ...summary,
                stage:
                  this.pending.has(id) && recordingId === this.recordingId
                    ? 'preparing'
                    : 'interrupted',
                interrupted: !(this.pending.has(id) && recordingId === this.recordingId),
              },
        );
      }
    }
    return results;
  }

  private async readIndex(dir: string): Promise<IndexRow[]> {
    const indexed: IndexRow[] = [];
    const names = new Set<string>();
    try {
      const file = path.join(dir, 'index.jsonl');
      // Do not read an attacker-controlled or runaway index into unbounded memory.
      if ((await stat(file)).size <= MAX_INDEX_BYTES) {
        const data = await readFile(file, 'utf8');
        for (const line of data.split('\n')) {
          if (!line || line.length > 1024 * 1024) continue;
          try {
            const row = JSON.parse(line) as IndexRow;
            if (
              !CHUNK_FILE.test(row.chunk) ||
              !['attempt', 'attempt-start', 'presentation', 'presentation-closed'].includes(
                row.type,
              )
            )
              continue;
            indexed.push(row);
            names.add(row.chunk);
          } catch {
            /* A torn or corrupt line cannot mask later valid entries. */
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // The process may die after atomically creating a gzip chunk but before indexing it.
    // Recover only bounded, independently decodable chunks, never arbitrary archive paths.
    let chunks: string[];
    try {
      chunks = (await readdir(path.join(dir, 'chunks')))
        .filter((name) => CHUNK_FILE.test(name))
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return indexed;
      throw error;
    }
    // Inspect missing chunks, not the first N filenames: a crash after a very long
    // recording most often leaves unindexed chunks at the *end* of the archive.
    const orphanChunks = chunks.filter((name) => !names.has(name));
    for (const name of orphanChunks.slice(-MAX_RECOVERY_CHUNKS)) {
      try {
        const rows = await this.readChunk(dir, name);
        for (const row of rows) {
          if (row.type === 'attempt' || row.type === 'attempt-start') {
            indexed.push({
              type: row.type,
              chunk: name,
              attemptId: row.summary.id,
              summary: row.summary,
            });
          } else if (row.type === 'presentation') {
            indexed.push({ type: row.type, chunk: name, attemptId: row.attemptId });
          } else if (row.type === 'presentation-closed') {
            indexed.push({ type: row.type, chunk: name, attemptId: `run-${row.runId}` });
          }
        }
      } catch {
        /* A corrupt orphan chunk does not prevent recovery of its neighbors. */
      }
    }
    return indexed.sort((a, b) => a.chunk.localeCompare(b.chunk));
  }

  async reconstruct(id: string, recordingId: string): Promise<CompactReconstruction | null> {
    safeId(id);
    if (typeof recordingId !== 'string' || !RECORDING_ID.test(recordingId))
      throw new Error('Invalid compact recording ID.');
    await this.flush();
    const dir = path.join(this.root, 'compact-inference', recordingId);
    const index = await this.readIndex(dir);
    const target = index.find((item) => item.type === 'attempt' && item.attemptId === id);
    if (!target) {
      const started = index.find((item) => item.type === 'attempt-start' && item.attemptId === id);
      if (!started?.summary) return null;
      return {
        input: null,
        request: null,
        provenance: 'exact-not-constructed',
        recordedBuilderVersion: 'unknown',
        currentBuilderVersion: BUILDER_VERSION,
        warning:
          'Inference attempt was interrupted before its outcome could be recorded; no input or completed request is available.',
        attempt: {
          ...started.summary,
          recordingId,
          chunk: started.chunk,
          stage: 'interrupted',
          interrupted: true,
          archiveStatus: 'incomplete',
        },
      };
    }
    const evidence = new Map<string, Evidence>();
    let attempt: AttemptRecord | null = null;
    for (const item of index) {
      let rows: Row[];
      try {
        rows = await this.readChunk(dir, item.chunk, item.sha256);
      } catch (error) {
        if (item === target) throw error;
        // An unrelated damaged chunk need not hide readable later attempts.
        continue;
      }
      for (const row of rows) {
        if (row.type === 'evidence') evidence.set(row.id, row);
        if (row.type === 'attempt' && row.summary.id === id) attempt = row;
      }
      if (item === target) break;
    }
    if (!attempt) throw new Error('Compact attempt index references a missing attempt.');
    const selected = attempt as AttemptRecord;
    const required = (kind: EvidenceKind): Record<string, unknown>[] =>
      (selected.selection[kind] ?? []).map((key) => {
        const row = evidence.get(key);
        if (!row || row.kind !== kind)
          throw new Error(`Compact reconstruction is missing selected ${kind} ${key}.`);
        const { order: _order, ...data } = row.data;
        return data;
      });
    const frames = await Promise.all(
      required('frame').map(async (frame) => {
        const filename = frame.jpeg;
        if (typeof filename !== 'string' || !/^[a-f0-9]{64}\.jpg$/.test(filename))
          throw new Error('Invalid recorded JPEG reference.');
        const bytes = await readFile(path.join(dir, 'frames', filename));
        if (sha(bytes) + '.jpg' !== filename) throw new Error('Recorded JPEG checksum mismatch.');
        const { jpeg: _jpeg, ...metadata } = frame;
        return { ...metadata, dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}` };
      }),
    );
    const input: InferenceInput = {
      ...selected.base,
      captureSelection: selected.details.originalSelection as InferenceInput['captureSelection'],
      observations: required('observation') as unknown as InferenceInput['observations'],
      recentTranscripts: required('transcript') as unknown as InferenceInput['recentTranscripts'],
      recentEvents: required('event') as unknown as InferenceInput['recentEvents'],
      recentChat: required('chat') as unknown as InferenceInput['recentChat'],
      frames: frames as unknown as InferenceInput['frames'],
    } as InferenceInput;
    let request: unknown;
    let provenance: CompactReconstruction['provenance'];
    let warning: string;
    const mode = selected.summary.mode ?? 'compact';
    if (mode === 'exact') {
      if (!selected.exact) {
        request = null;
        provenance = 'exact-not-constructed';
        warning =
          'The attempt ended before its native request was constructed; no original request exists to rerun.';
      } else {
        const blobs = new Map(
          frames.map((frame) => {
            const match = JPEG.exec(frame.dataUrl);
            const bytes = Buffer.from(match![1], 'base64');
            return [sha(bytes), frame.dataUrl] as const;
          }),
        );
        const restored = mapImageUrls(JSON.parse(selected.exact.encodedJson), (reference) => {
          const match = EXACT_FRAME_REF.exec(reference);
          if (!match || !blobs.has(match[1]))
            throw new Error('Exact request references a missing or invalid selected JPEG.');
          return blobs.get(match[1])!;
        });
        if (sha(JSON.stringify(restored)) !== selected.exact.sha256)
          throw new Error('Exact request checksum mismatch; the archive may be corrupt.');
        request = restored;
        provenance = 'exact-recorded-request';
        warning =
          'Verified original native request; its prompts, schema, parameters, seed and JPEG bytes are independent of the current builder.';
      }
    } else {
      request = nativeChatRequest(input);
      provenance = 'current-builder-reconstruction';
      warning = ''; // Compact reconstruction caveat is applied below.
    }
    const currentBuilderVersion = BUILDER_VERSION;
    const recordedBuilderVersion =
      typeof selected.details.builderVersion === 'string'
        ? selected.details.builderVersion
        : 'unknown';
    return {
      input,
      request,
      provenance,
      recordedBuilderVersion,
      currentBuilderVersion,
      warning:
        mode === 'exact'
          ? warning
          : (recordedBuilderVersion !== currentBuilderVersion
              ? 'The recorded builder fingerprint differs from this application. '
              : 'The recorded builder fingerprint matches this application. ') +
            'Reconstructed with the current native request builder. This is not the byte-exact ' +
            'historical request; builder/schema/version changes can alter the prompt and output.',
      attempt: { ...selected.summary, mode, chunk: target.chunk },
    };
  }

  /** Turn a disk-backed Exact attempt into a standalone immutable saved case source. */
  async restoreExactAttempt(id: string, recordingId: string): Promise<TraceAttempt> {
    const rebuilt = await this.reconstruct(id, recordingId);
    if (!rebuilt) throw new Error('Recorded inference attempt was not found.');
    if (rebuilt.provenance !== 'exact-recorded-request')
      throw new Error('This attempt has no constructed Exact native request.');
    const dir = path.join(this.root, 'compact-inference', recordingId);
    const index = await this.readIndex(dir);
    const target = index.find((row) => row.type === 'attempt' && row.attemptId === id);
    if (!target) throw new Error('Recorded attempt index is missing.');
    const stored = (await this.readChunk(dir, target.chunk, target.sha256)).find(
      (row): row is AttemptRecord => row.type === 'attempt' && row.summary.id === id,
    );
    if (!stored) throw new Error('Recorded Exact attempt is missing.');
    const {
      builderVersion: _builderVersion,
      originalSelection: _selection,
      ...details
    } = stored.details;
    return {
      errorStage: null,
      error: null,
      usage: null,
      rawResponse: null,
      normalized: null,
      parsed: null,
      accepted: null,
      scheduled: null,
      transportError: null,
      presented: [],
      presentationClosed: false,
      ...rebuilt.attempt,
      ...details,
      input: rebuilt.input,
      request: rebuilt.request,
    } as unknown as TraceAttempt;
  }

  private async readChunk(dir: string, name: string, digest?: string): Promise<Row[]> {
    if (!CHUNK_FILE.test(name)) throw new Error('Invalid compact chunk name.');
    if ((await stat(path.join(dir, 'chunks', name))).size > MAX_CHUNK_BYTES)
      throw new Error('Recorded chunk exceeds the recovery size limit.');
    const bytes = await readFile(path.join(dir, 'chunks', name));
    if (digest !== undefined && (!CHUNK_SHA.test(digest) || sha(bytes) !== digest))
      throw new Error('Recorded chunk integrity checksum mismatch.');
    return gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 })
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Row);
  }
}
