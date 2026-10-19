import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
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
} from '../shared/compact-recording-contract';

type EvidenceKind = 'observation' | 'transcript' | 'event' | 'chat' | 'frame';
type Evidence = { type: 'evidence'; kind: EvidenceKind; id: string; data: Record<string, unknown> };
type AttemptRecord = {
  type: 'attempt';
  summary: CompactAttemptSummary;
  base: Record<string, unknown>;
  selection: Record<string, string[]>;
  details: Record<string, unknown>;
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
type Row = Evidence | AttemptRecord | Presentation | PresentationClosed;
type IndexRow = {
  type: 'attempt' | 'presentation' | 'presentation-closed';
  chunk: string;
  attemptId: string;
  summary?: CompactAttemptSummary;
};
type Capture = {
  metadata: Parameters<InferenceTrace['begin']>[0];
  patch: Partial<TraceAttempt>;
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
  private directory: string | null = null;
  private recordingId: string | null = null;
  private serialByDirectory = new Map<string, number>();
  private attempts = 0;
  private bytes = 0;
  private chunks = 0;
  private error: string | null = null;
  private pending = new Map<string, Capture>();
  private seen = new Set<string>();
  private indexedDirs = new Map<string, string>();
  private indexedRun = new Map<string, number>();
  private indexedStage = new Map<string, TraceAttempt['stage']>();
  private presented = new Set<string>();
  private closedRuns = new Set<number>();
  private broken = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly root: string,
    private readonly onError: (error: unknown) => void = () => {},
  ) {}

  status(): CompactRecordingStatus {
    return {
      enabled: this.enabled,
      recordingId: this.recordingId,
      attempts: this.attempts,
      chunks: this.chunks,
      bytes: this.bytes,
      error: this.error,
    };
  }

  /** A fresh recording begins at the next attempt. Already captured attempts finish on disable. */
  async configure(enabled: boolean): Promise<CompactRecordingStatus> {
    if (typeof enabled !== 'boolean') throw new Error('Invalid compact recording setting.');
    if (enabled === this.enabled) return this.status();
    if (enabled) {
      if (this.pending.size)
        throw new Error(
          'Cannot start a new recording until the previous captured attempts finish.',
        );
      await this.flush();
      this.recordingId = `recording-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
      this.directory = path.join(this.root, 'compact-inference', this.recordingId);
      await mkdir(path.join(this.directory, 'frames'), { recursive: true, mode: 0o700 });
      await mkdir(path.join(this.directory, 'chunks'), { recursive: true, mode: 0o700 });
      await writeFile(
        path.join(this.directory, 'manifest.json'),
        JSON.stringify({
          format: 'lonely-chat-compact',
          version: 1,
          builderVersion: BUILDER_VERSION,
        }),
        { flag: 'wx', mode: 0o600 },
      );
      this.serialByDirectory.set(this.directory, 0);
      this.attempts = 0;
      this.bytes = 0;
      this.chunks = 0;
      this.seen.clear();
      this.error = null;
      this.broken = false;
    }
    this.enabled = enabled;
    return this.status();
  }

  begin(id: string, metadata: Parameters<InferenceTrace['begin']>[0]): void {
    if (!this.enabled || !this.directory) return;
    safeId(id);
    // Deep copy at the capture boundary, not after another cycle can mutate its input.
    try {
      this.pending.set(id, { metadata: structuredClone(metadata), patch: {} });
      this.indexedRun.set(id, metadata.runId);
    } catch {
      this.captureError('Unable to snapshot selected inference input.');
    }
  }

  update(id: string, patch: Partial<TraceAttempt>): void {
    const item = this.pending.get(id);
    if (!item) return;
    // Exact transport requests belong to the next ticket, never retain them in compact mode.
    const { request: _request, ...compactPatch } = patch;
    try {
      Object.assign(item.patch, structuredClone(compactPatch));
    } catch {
      this.pending.delete(id);
      this.captureError('Unable to snapshot an inference result for compact recording.');
      return;
    }
    if (patch.stage === 'scheduled' || patch.stage === 'failed' || patch.stage === 'cancelled') {
      this.pending.delete(id);
      const snapshot = { ...item.metadata, ...item.patch, id } as unknown as TraceAttempt;
      this.enqueue(() => this.saveAttempt(snapshot));
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
    if (run === undefined || this.closedRuns.has(run)) return;
    this.enqueue(async () => {
      const dir = this.indexedDirs.get(id);
      const key = `${id}:${scheduledIndex}`;
      if (!dir || this.indexedStage.get(id) !== 'scheduled' || this.presented.has(key)) return;
      const row: Presentation = { type: 'presentation', attemptId: id, scheduledIndex, ...message };
      await this.chunk(dir, [row], { type: 'presentation', attemptId: id, chunk: '' });
      this.presented.add(key);
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
    if (this.closedRuns.has(runId)) return;
    this.closedRuns.add(runId);
    this.enqueue(async () => {
      const grouped = new Map<string, string[]>();
      for (const [id, dir] of this.indexedDirs) {
        if (this.indexedRun.get(id) !== runId) continue;
        const ids = grouped.get(dir) ?? [];
        ids.push(id);
        grouped.set(dir, ids);
      }
      for (const [dir, attemptIds] of grouped) {
        await this.chunk(dir, [{ type: 'presentation-closed', runId, attemptIds }], {
          type: 'presentation-closed',
          attemptId: `run-${runId}`,
          chunk: '',
        });
      }
    });
  }

  async flush(): Promise<void> {
    await this.chain;
  }

  private enqueue(write: () => Promise<void>): void {
    this.chain = this.chain
      .then(() => (this.broken ? undefined : write()))
      .catch(() => {
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
    this.onError(new Error(message));
  }

  private async chunk(dir: string, rows: readonly Row[], index: IndexRow): Promise<void> {
    const serial = (this.serialByDirectory.get(dir) ?? 0) + 1;
    this.serialByDirectory.set(dir, serial);
    const name = `${String(serial).padStart(8, '0')}.jsonl.gz`;
    const bytes = gzipSync(rows.map(jsonLine).join(''), { level: 6 });
    await writeFile(path.join(dir, 'chunks', name), bytes, { flag: 'wx', mode: 0o600 });
    await appendFile(path.join(dir, 'index.jsonl'), jsonLine({ ...index, chunk: name }), {
      mode: 0o600,
    });
    if (dir === this.directory) {
      this.chunks++;
      this.bytes += bytes.byteLength;
    }
  }

  private async saveAttempt(attempt: TraceAttempt): Promise<void> {
    const dir = this.directory;
    if (!dir) return;
    const input = object(attempt.input);
    const selection = object(input.captureSelection);
    const entries: Row[] = [];
    const references: Record<string, string[]> = {};
    const emit = (kind: EvidenceKind, id: string, data: Record<string, unknown>): void => {
      if (!this.seen.has(id)) {
        entries.push({ type: 'evidence', kind, id, data });
        this.seen.add(id);
      }
    };
    const run = attempt.runId;
    const capture = (kind: Exclude<EvidenceKind, 'frame'>, values: unknown, ids: unknown): void => {
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
    capture('observation', input.observations, selection.observations);
    capture('transcript', input.recentTranscripts, selection.transcripts);
    capture('event', input.recentEvents, selection.events);
    capture('chat', input.recentChat, selection.chat);
    references.frame = [];
    for (const [index, value] of array(input.frames).entries()) {
      const frame = object(value);
      const match = typeof frame.dataUrl === 'string' ? JPEG.exec(frame.dataUrl) : null;
      if (!match) throw new Error('Selected JPEG was unavailable for compact recording.');
      const buffer = Buffer.from(match[1], 'base64');
      const digest = sha(buffer);
      const frameId = `${run}:frame:${sha(
        JSON.stringify([frame.sourceId, frame.observedAt, frame.mediaTimeMs, digest]),
      )}`;
      const filename = `${digest}.jpg`;
      // Content-addressed exact JPEG bytes, shared across attempts and observations.
      try {
        await writeFile(path.join(dir, 'frames', filename), buffer, { flag: 'wx', mode: 0o600 });
        this.bytes += buffer.byteLength;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
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
    entries.push({
      type: 'attempt',
      summary,
      base,
      selection: references,
      details: { ...rest, originalSelection: selection, builderVersion: BUILDER_VERSION },
    } as AttemptRecord);
    await this.chunk(dir, entries, { type: 'attempt', attemptId: attempt.id, chunk: '', summary });
    this.indexedDirs.set(attempt.id, dir);
    this.indexedRun.set(attempt.id, attempt.runId);
    this.indexedStage.set(attempt.id, attempt.stage);
    this.attempts++;
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
      const index = await this.readIndex(path.join(base, recordingId));
      results.push(
        ...index
          .filter((item) => item.type === 'attempt' && item.summary)
          .map((item) => ({ ...item.summary!, recordingId, chunk: item.chunk })),
      );
    }
    return results;
  }

  private async readIndex(dir: string): Promise<IndexRow[]> {
    let data: string;
    try {
      data = await readFile(path.join(dir, 'index.jsonl'), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    // A torn final index append must not invalidate previously completed chunks.
    const complete = data.endsWith('\n') ? data : data.slice(0, data.lastIndexOf('\n') + 1);
    return complete
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as IndexRow);
  }

  async reconstruct(id: string, recordingId: string): Promise<CompactReconstruction | null> {
    safeId(id);
    if (typeof recordingId !== 'string' || !RECORDING_ID.test(recordingId))
      throw new Error('Invalid compact recording ID.');
    await this.flush();
    const dir = path.join(this.root, 'compact-inference', recordingId);
    const index = await this.readIndex(dir);
    const target = index.find((item) => item.type === 'attempt' && item.attemptId === id);
    if (!target) return null;
    const evidence = new Map<string, Evidence>();
    let attempt: AttemptRecord | null = null;
    for (const item of index) {
      const rows = await this.readChunk(dir, item.chunk);
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
    const currentBuilderVersion = BUILDER_VERSION;
    const recordedBuilderVersion =
      typeof selected.details.builderVersion === 'string'
        ? selected.details.builderVersion
        : 'unknown';
    return {
      input,
      request: nativeChatRequest(input),
      provenance: 'current-builder-reconstruction',
      recordedBuilderVersion,
      currentBuilderVersion,
      warning:
        (recordedBuilderVersion !== currentBuilderVersion
          ? 'The recorded builder fingerprint differs from this application. '
          : 'The recorded builder fingerprint matches this application. ') +
        'Reconstructed with the current native request builder. This is not the byte-exact ' +
        'historical request; builder/schema/version changes can alter the prompt and output.',
      attempt: { ...selected.summary, chunk: target.chunk },
    };
  }

  private async readChunk(dir: string, name: string): Promise<Row[]> {
    if (!/^\d{8}\.jsonl\.gz$/.test(name)) throw new Error('Invalid compact chunk name.');
    return gunzipSync(await readFile(path.join(dir, 'chunks', name)))
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Row);
  }
}
