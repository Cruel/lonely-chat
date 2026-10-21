import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { TraceAttempt } from '../shared/inference-trace-contract';
import type {
  SavedCaseChild,
  SavedCaseDetail,
  SavedCaseFork,
  SavedCaseFrame,
  SavedCaseSummary,
  SavedCaseSourceResult,
} from '../shared/saved-case-contract';
import type { SimulationExperimentResult } from '../shared/playground-contract';
import { validateRawSimulationRequest } from './simulation-experiment';
import { MAX_SIMULATION_FRAME_DATA_URL } from '../shared/video-contract';
import type { InferenceInput } from './fake-inference';

const VERSION = 1;
const MAX_CASES = 100;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_CASE_BYTES = 12 * 1024 * 1024;
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_FORK_BYTES = 512 * 1024;
const MAX_CHILDREN = 32;
const ID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const REF = /^saved-frame:([a-f\d]{64})$/;
const DATA = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/;

interface StoredFrame {
  index: number;
  sourceId: string;
  observedAt: number;
  mediaTimeMs?: number;
  width: number;
  height: number;
  ref: string;
}
interface Manifest {
  version: 1;
  summary: SavedCaseSummary;
  request: unknown;
  input: unknown;
  frames: StoredFrame[];
  sourceResult: SavedCaseSourceResult;
}
function obj(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Saved inference case contains invalid structured data.');
  return value as Record<string, unknown>;
}
function jpeg(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length > MAX_FRAME_BYTES * 1.4)
    throw new Error('Saved frame is missing or too large.');
  const match = DATA.exec(value);
  if (!match) throw new Error('Saved frame must contain JPEG bytes.');
  const bytes = Buffer.from(match[1], 'base64');
  if (
    bytes.length < 4 ||
    bytes.length > MAX_FRAME_BYTES ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes[bytes.length - 2] !== 0xff ||
    bytes[bytes.length - 1] !== 0xd9 ||
    bytes.toString('base64') !== match[1]
  )
    throw new Error('Saved JPEG bytes are malformed.');
  return bytes;
}
function sha(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function json(value: unknown): string {
  const data = JSON.stringify(value);
  if (!data) throw new Error('Saved inference case is not serializable.');
  return data;
}
function imageUrls(value: unknown): string[] {
  const user = obj(
    obj(value).messages instanceof Array ? (obj(value).messages as unknown[])[1] : null,
  );
  return Array.isArray(user.content)
    ? user.content.flatMap((part) => {
        const data = obj(part);
        return data.type === 'image_url' ? [obj(data.image_url).url as string] : [];
      })
    : [];
}
function replaceImages(value: unknown, replace: (url: string) => string): unknown {
  const clone = structuredClone(value);
  const req = obj(clone);
  if (!Array.isArray(req.messages) || req.messages.length !== 2)
    throw new Error('Missing native messages.');
  const user = obj(req.messages[1]);
  if (Array.isArray(user.content))
    for (const part of user.content) {
      const p = obj(part);
      if (p.type === 'image_url') {
        const link = obj(p.image_url);
        if (typeof link.url !== 'string') throw new Error('Invalid frame reference.');
        link.url = replace(link.url);
      }
    }
  return clone;
}
function validateModel(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200)
    throw new Error('The inference attempt has no usable model identity.');
  return value;
}
function validId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error('Invalid saved case ID.');
}
function usableAttempt(value: TraceAttempt): {
  request: unknown;
  input: InferenceInput;
  frames: StoredFrame[];
  blobs: Map<string, Buffer>;
} {
  if (value.mode !== 'native')
    throw new Error('Only native inference attempts have an exact transport request.');
  validateModel(value.modelId);
  const input = obj(value.input);
  const request = obj(value.request);
  if (!Array.isArray(input.frames))
    throw new Error('Exact selected frame evidence was not captured.');
  if (input.frames.length > 32) throw new Error('Too many selected frames to save.');
  const selected = input.frames.map((frame, index) => {
    const data = obj(frame);
    if (
      typeof data.sourceId !== 'string' ||
      !data.sourceId.trim() ||
      data.sourceId.length > 100 ||
      !Number.isFinite(data.observedAt) ||
      !Number.isSafeInteger(data.width) ||
      !Number.isSafeInteger(data.height) ||
      (data.width as number) < 1 ||
      (data.height as number) < 1
    )
      throw new Error('Selected frame metadata is incomplete.');
    const bytes = jpeg(data.dataUrl);
    const ref = 'saved-frame:' + sha(bytes);
    const metadata: StoredFrame = {
      index,
      sourceId: data.sourceId,
      observedAt: data.observedAt as number,
      width: data.width as number,
      height: data.height as number,
      ref,
      ...(typeof data.mediaTimeMs === 'number' ? { mediaTimeMs: data.mediaTimeMs } : {}),
    };
    return { metadata, bytes };
  });
  const urls = imageUrls(request);
  if (
    urls.length !== selected.length ||
    urls.some((url, i) => url !== obj((input.frames as unknown[])[i]).dataUrl)
  )
    throw new Error('Captured frame bytes do not match the exact native request.');
  if (request.seed !== value.seed)
    throw new Error('Missing or mismatched effective seed in native request.');
  validateRawSimulationRequest(
    json(request),
    input.frames as unknown as import('../shared/playground-media-contract').PlaygroundFrame[],
    MAX_SIMULATION_FRAME_DATA_URL,
  );
  return {
    request,
    input: value.input as InferenceInput,
    frames: selected.map(({ metadata }) => metadata),
    blobs: new Map(selected.map(({ metadata, bytes }) => [metadata.ref.slice(12), bytes])),
  };
}
/** Freeze captured evidence; never silently turn oversized results into empty results. */
function sourceResult(
  attempt: TraceAttempt,
  requestProvenance?: SavedCaseSourceResult['requestProvenance'],
): SavedCaseSourceResult {
  const base = {
    stage: attempt.stage,
    errorStage: attempt.errorStage,
    error: attempt.error,
    durationMs: attempt.durationMs,
    usage: attempt.usage,
    ...(attempt.role ? { role: attempt.role } : {}),
    ...(attempt.profileRevision === undefined ? {} : { profileRevision: attempt.profileRevision }),
    ...(attempt.observedAt === undefined ? {} : { observedAt: attempt.observedAt }),
    ...(attempt.availableAt === undefined ? {} : { availableAt: attempt.availableAt }),
    ...(attempt.dependsOn ? { dependsOn: attempt.dependsOn } : {}),
    ...(attempt.sourceFrameIds ? { sourceFrameIds: attempt.sourceFrameIds } : {}),
    ...(attempt.observationRefs ? { observationRefs: attempt.observationRefs } : {}),
    presentationClosed: attempt.presentationClosed ?? false,
    ...(requestProvenance ? { requestProvenance } : {}),
  };
  const evidence = {
    ...base,
    rawNativeOutput: attempt.rawResponse,
    normalizedResult: attempt.normalized,
    parsedResult: attempt.parsed,
    accepted: attempt.accepted,
    scheduled: attempt.scheduled,
    presented: attempt.presented ?? null,
    transportError: attempt.transportError,
  };
  if (Buffer.byteLength(json(evidence)) <= 2 * 1024 * 1024) return evidence;
  return {
    ...base,
    rawNativeOutput: null,
    normalizedResult: null,
    parsedResult: null,
    accepted: null,
    scheduled: null,
    presented: null,
    transportError: null,
    omitted: 'Original outcome exceeded the 2 MiB evidence storage limit.',
  };
}
function validateManifest(value: unknown): Manifest {
  const record = obj(value);
  if (record.version !== VERSION || !Array.isArray(record.frames) || record.frames.length > 32)
    throw new Error('Unsupported saved inference case format.');
  // Imported evidence is never a bag for arbitrary local, connection or
  // credential metadata. Fail closed rather than persisting unknown fields.
  if (Object.keys(record).some((key) =>
    !['version', 'summary', 'request', 'input', 'frames', 'sourceResult'].includes(key)))
    throw new Error('Unsupported saved case metadata field.');
  const summary = obj(record.summary);
  validId(summary.id);
  validateModel(summary.modelId);
  if (
    !Number.isSafeInteger(summary.seed) ||
    !Number.isInteger(summary.frameCount) ||
    summary.frameCount !== record.frames.length
  )
    throw new Error('Corrupt saved case metadata.');
  const frames = record.frames.map((item, i) => {
    const frame = obj(item);
    if (
      frame.index !== i ||
      typeof frame.ref !== 'string' ||
      !REF.test(frame.ref) ||
      typeof frame.sourceId !== 'string' ||
      !Number.isFinite(frame.observedAt) ||
      !Number.isSafeInteger(frame.width) ||
      !Number.isSafeInteger(frame.height)
    )
      throw new Error('Corrupt saved frame metadata.');
    return frame as unknown as StoredFrame;
  });
  const input = obj(record.input);
  if (typeof input.context !== 'string' || !Number.isSafeInteger(input.cycle))
    throw new Error('Saved case original input is incomplete.');
  {
    // Canonical exact cases always carry the source attempt outcome. Missing
    // evidence is corruption, never an inferred successful empty response.
    if (record.sourceResult === undefined)
      throw new Error('Missing saved case source result.');
    const evidence = obj(record.sourceResult);
    if (Object.keys(evidence).some((key) => ![
      'stage', 'errorStage', 'error', 'durationMs', 'usage',
      'role', 'profileRevision', 'observedAt', 'availableAt', 'dependsOn',
      'sourceFrameIds', 'observationRefs', 'presentationClosed', 'requestProvenance',
      'rawNativeOutput', 'normalizedResult', 'parsedResult', 'accepted',
      'scheduled', 'presented', 'transportError', 'omitted',
    ].includes(key)))
      throw new Error('Unsupported saved case outcome evidence field.');
    if (
      (evidence.role !== undefined && !['unified', 'vision', 'chat', 'memory'].includes(String(evidence.role))) ||
      (evidence.profileRevision !== undefined && evidence.profileRevision !== null &&
        (!Number.isSafeInteger(evidence.profileRevision) || (evidence.profileRevision as number) < 1)) ||
      ['observedAt', 'availableAt'].some((field) =>
        evidence[field] !== undefined && evidence[field] !== null &&
        (typeof evidence[field] !== 'number' || !Number.isFinite(evidence[field]))) ||
      ['dependsOn', 'sourceFrameIds', 'observationRefs'].some((field) =>
        evidence[field] !== undefined && (!Array.isArray(evidence[field]) ||
          (evidence[field] as unknown[]).length > 64 ||
          (evidence[field] as unknown[]).some((part) => typeof part !== 'string' || part.length > 250)))
    )
      throw new Error('Invalid saved case stage provenance.');
    if (
      evidence.requestProvenance !== undefined &&
      evidence.requestProvenance !== 'current-builder-reconstruction' &&
      evidence.requestProvenance !== 'exact-recorded-request'
    )
      throw new Error('Invalid saved case request provenance.');
    const stages = [
      'preparing',
      'transport',
      'normalization',
      'validation',
      'accepted',
      'scheduled',
      'failed',
      'cancelled',
    ];
    if (
      !stages.includes(evidence.stage as string) ||
      (evidence.errorStage !== null && !stages.includes(evidence.errorStage as string)) ||
      (evidence.error !== null && typeof evidence.error !== 'string') ||
      (evidence.durationMs !== null &&
        (typeof evidence.durationMs !== 'number' ||
          !Number.isFinite(evidence.durationMs) ||
          evidence.durationMs < 0)) ||
      (evidence.omitted !== undefined && typeof evidence.omitted !== 'string') ||
      (evidence.presentationClosed !== undefined &&
        typeof evidence.presentationClosed !== 'boolean') ||
      [
        'rawNativeOutput',
        'normalizedResult',
        'parsedResult',
        'accepted',
        'scheduled',
        'presented',
        'transportError',
      ].some((field) => !Object.hasOwn(evidence, field))
    )
      throw new Error('Corrupt saved source result.');
    if (evidence.usage !== null) {
      const usage = obj(evidence.usage);
      if (
        ['promptTokens', 'completionTokens', 'totalTokens'].some(
          (key) =>
            usage[key] !== null &&
            (typeof usage[key] !== 'number' ||
              !Number.isFinite(usage[key]) ||
              (usage[key] as number) < 0),
        )
      )
        throw new Error('Corrupt saved source token usage.');
    }
  }
  const request = obj(record.request);
  if (
    !Array.isArray(input.frames) ||
    input.frames.length !== frames.length ||
    imageUrls(request).some((url, i) => url !== frames[i]?.ref) ||
    imageUrls(request).length !== frames.length ||
    request.seed !== summary.seed ||
    input.frames.some((item: unknown, index: number) => obj(item).dataUrl !== frames[index].ref)
  )
    throw new Error('Corrupt case frame references or seed.');
  return value as Manifest;
}

/** Child experiments use one current evidence shape. Incomplete historical
 * children are unavailable rather than silently interpreted as empty output. */
function validateStoredChild(value: unknown, parentId: string, frameCount: number): SavedCaseChild {
  const child = obj(value);
  validId(child.id);
  if (
    Object.keys(child).some((key) => ![
      'id', 'parentCaseId', 'createdAt', 'modelId', 'seed', 'errorStage', 'error',
      'durationMs', 'frameIndices', 'outcome',
    ].includes(key)) ||
    child.parentCaseId !== parentId ||
    typeof child.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(child.createdAt)) ||
    typeof child.modelId !== 'string' || !child.modelId || child.modelId.length > 200 ||
    !Number.isSafeInteger(child.seed) || (child.seed as number) < 0 ||
    (child.seed as number) > 2147483647 ||
    !Number.isFinite(child.durationMs) || (child.durationMs as number) < 0 ||
    (child.error !== null && typeof child.error !== 'string') ||
    (child.errorStage !== null &&
      !['transport', 'normalization', 'validation'].includes(String(child.errorStage))) ||
    !Array.isArray(child.frameIndices) || child.frameIndices.length > 32 ||
    child.frameIndices.some((index: unknown) =>
      !Number.isSafeInteger(index) || (index as number) < 0 || (index as number) >= frameCount) ||
    new Set(child.frameIndices).size !== child.frameIndices.length
  )
    throw new Error('Corrupt imported case child.');
  if (!child.outcome) throw new Error('Corrupt imported case child.');
  const outcome = obj(child.outcome);
  if (
    Object.keys(outcome).some((key) => ![
      'submittedRequest', 'rawNativeOutput', 'normalizedResult', 'parsedResult',
      'accepted', 'usage', 'omitted',
    ].includes(key)) ||
    ['submittedRequest', 'rawNativeOutput', 'normalizedResult', 'parsedResult', 'accepted', 'usage']
      .some((key) => !Object.hasOwn(outcome, key)) ||
    (outcome.omitted !== undefined && typeof outcome.omitted !== 'string') ||
    Buffer.byteLength(json(outcome)) > 2 * 1024 * 1024 + 1024
  )
    throw new Error('Invalid imported child request or evidence.');
  return child as unknown as SavedCaseChild;
}

export class SavedInferenceCases {
  private readonly directory: string;
  private writeTail: Promise<void> = Promise.resolve();

  /** Serialize explicit saves so concurrent IPC calls cannot bypass byte/count quotas. */
  private withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeTail;
    let release!: () => void;
    this.writeTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    return previous.then(operation).finally(release);
  }
  constructor(userData: string) {
    this.directory = path.join(userData, 'saved-inference-cases');
  }
  private file(id: string): string {
    validId(id);
    return path.join(this.directory, id);
  }
  private async read(id: string): Promise<Manifest> {
    const contents = await readFile(path.join(this.file(id), 'case.json'));
    if (contents.byteLength > MAX_CASE_BYTES) throw new Error('Saved case exceeds the size limit.');
    const data = validateManifest(JSON.parse(contents.toString('utf8')));
    if (data.summary.id !== id) throw new Error('Saved case identity mismatch.');
    return data;
  }
  private async total(): Promise<{ count: number; bytes: number }> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let count = 0;
    let bytes = 0;
    for (const item of await readdir(this.directory, { withFileTypes: true })) {
      if (!item.isDirectory() || !ID.test(item.name)) continue;
      count++;
      const folder = this.file(item.name);
      for (const file of await readdir(folder, { withFileTypes: true })) {
        if (file.isFile()) bytes += (await stat(path.join(folder, file.name))).size;
      }
    }
    return { count, bytes };
  }
  async list(): Promise<SavedCaseSummary[]> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const results: SavedCaseSummary[] = [];
    for (const item of await readdir(this.directory)) {
      if (!ID.test(item)) continue;
      try {
        const data = await this.read(item);
        const children = await this.children(item);
        results.push({ ...data.summary, childCount: children.length });
      } catch {
        /* A corrupt/partially imported case never blocks healthy cases. */
      }
    }
    return results.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }
  async save(
    attempt: TraceAttempt,
    requestProvenance?: SavedCaseSourceResult['requestProvenance'],
  ): Promise<SavedCaseSummary> {
    const candidate = usableAttempt(attempt);
    const id = randomUUID();
    const savedAt = new Date().toISOString();
    const summary: SavedCaseSummary = {
      id,
      savedAt,
      attemptId: attempt.id,
      runId: attempt.runId,
      cycle: attempt.cycle,
      attempt: attempt.attempt,
      modelId: attempt.modelId!,
      seed: attempt.seed,
      frameCount: candidate.frames.length,
      childCount: 0,
    };
    const manifest: Manifest = {
      version: VERSION,
      summary,
      request: replaceImages(candidate.request, (url) => 'saved-frame:' + sha(jpeg(url))),
      input: {
        ...candidate.input,
        frames: candidate.frames.map((frame) => ({ ...frame, dataUrl: frame.ref })),
      },
      frames: candidate.frames,
      sourceResult: sourceResult(attempt, requestProvenance),
    };
    return this.commit(manifest, candidate.blobs);
  }
  private commit(
    manifest: Manifest,
    blobs: Map<string, Buffer>,
    children: SavedCaseChild[] = [],
  ): Promise<SavedCaseSummary> {
    return this.withWriteLock(async () => {
      const manifestBytes = Buffer.from(json(manifest));
      const childBytes = children.map((child) => Buffer.from(json(child)));
      const added =
        manifestBytes.length +
        [...blobs.values()].reduce((n, b) => n + b.length, 0) +
        childBytes.reduce((n, b) => n + b.length, 0);
      const usage = await this.total();
      if (
        added > MAX_CASE_BYTES ||
        usage.count >= MAX_CASES ||
        usage.bytes + added > MAX_TOTAL_BYTES
      )
        throw new Error('Saved case storage limit reached; no existing cases were removed.');
      const temporary = path.join(this.directory, '.tmp-' + randomUUID());
      await mkdir(temporary, { mode: 0o700 });
      try {
        for (const [hash, bytes] of blobs) {
          await writeFile(path.join(temporary, hash + '.jpg'), bytes, { mode: 0o600, flag: 'wx' });
        }
        for (const [index, child] of children.entries())
          await writeFile(path.join(temporary, 'child-' + child.id + '.json'), childBytes[index], {
            mode: 0o600,
            flag: 'wx',
          });
        await writeFile(path.join(temporary, 'case.json'), manifestBytes, {
          mode: 0o600,
          flag: 'wx',
        });
        await rename(temporary, this.file(manifest.summary.id));
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
      return manifest.summary;
    });
  }
  private async loadImages(manifest: Manifest): Promise<Map<string, Buffer>> {
    const result = new Map<string, Buffer>();
    for (const frame of manifest.frames) {
      const hash = frame.ref.slice(12);
      if (result.has(hash)) continue;
      const bytes = await readFile(path.join(this.file(manifest.summary.id), hash + '.jpg'));
      if (bytes.byteLength > MAX_FRAME_BYTES || sha(bytes) !== hash)
        throw new Error('Saved case frame is missing or failed integrity verification.');
      jpeg('data:image/jpeg;base64,' + bytes.toString('base64'));
      result.set(hash, bytes);
    }
    return result;
  }
  async get(id: string): Promise<SavedCaseDetail> {
    const manifest = await this.read(id);
    const blobs = await this.loadImages(manifest);
    const children = await this.children(id, manifest.frames.length);
    const frames: SavedCaseFrame[] = manifest.frames.map((frame) => ({
      ...frame,
      dataUrl: 'data:image/jpeg;base64,' + blobs.get(frame.ref.slice(12))!.toString('base64'),
    }));
    return {
      summary: { ...manifest.summary, childCount: children.length },
      request: structuredClone(manifest.request),
      input: structuredClone(manifest.input),
      frames,
      children,
      sourceResult: structuredClone(manifest.sourceResult),
    };
  }
  async children(id: string, frameCount?: number): Promise<SavedCaseChild[]> {
    const totalFrames = frameCount ?? (await this.read(id)).frames.length;
    const entries = await readdir(this.file(id)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const list: SavedCaseChild[] = [];
    for (const name of entries) {
      if (!/^child-[a-f\d-]{36}\.json$/.test(name)) continue;
      try {
        const bytes = await readFile(path.join(this.file(id), name));
        if (bytes.length > 3 * 1024 * 1024) continue;
        const child = validateStoredChild(JSON.parse(bytes.toString('utf8')), id, totalFrames);
        list.push(child);
      } catch {
        /* A torn child write must not hide the original immutable case. */
      }
    }
    return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async prepareFork(value: SavedCaseFork): Promise<{
    modelId: string;
    input: InferenceInput;
    submitted: unknown;
    frames: SavedCaseFrame[];
  }> {
    const id = value?.caseId;
    validId(id);
    const modelId = validateModel(value.modelId);
    if (
      !Array.isArray(value.frameIndices) ||
      value.frameIndices.length > 32 ||
      value.frameIndices.some((n) => !Number.isInteger(n) || n < 0) ||
      new Set(value.frameIndices).size !== value.frameIndices.length ||
      typeof value.rawRequestJson !== 'string' ||
      value.rawRequestJson.length > MAX_FORK_BYTES
    )
      throw new Error('Invalid case experiment draft.');
    const detail = await this.get(id);
    if (detail.children.length >= MAX_CHILDREN)
      throw new Error('Saved case child experiment limit reached.');
    if (value.frameIndices.some((index) => index >= detail.frames.length))
      throw new Error('Selected case frame does not exist.');
    let draft: unknown;
    try {
      draft = JSON.parse(value.rawRequestJson);
    } catch {
      throw new Error('Case experiment request must be valid JSON.');
    }
    const expected = detail.frames.map((frame) => frame.ref);
    const refs = imageUrls(draft);
    if (refs.length !== expected.length || refs.some((url, index) => url !== expected[index]))
      throw new Error(
        'Case draft frame references must match the immutable source. Change frame selection using the frame controls.',
      );
    const request = structuredClone(draft);
    const selected = value.frameIndices.map((index) => detail.frames[index]);
    const urlByRef = new Map(detail.frames.map((frame) => [frame.ref, frame.dataUrl]));
    const body = obj(request);
    const user = obj((body.messages as unknown[])[1]);
    if (Array.isArray(user.content)) {
      let frameIndex = 0;
      const selectedSet = new Set(value.frameIndices);
      const parts = user.content as unknown[];
      const retained: unknown[] = [];
      for (const part of parts) {
        const item = obj(part);
        if (item.type !== 'image_url') {
          retained.push(part);
          continue;
        }
        const keep = selectedSet.has(frameIndex++);
        if (keep) obj(item.image_url).url = urlByRef.get(obj(item.image_url).url as string)!;
        else {
          const previous = retained.at(-1);
          if (
            previous &&
            obj(previous).type === 'text' &&
            /^Visual frame \d+, observedAt=/.test(String(obj(previous).text))
          )
            retained.pop();
        }
        if (keep) retained.push(part);
      }
      user.content = selected.length ? retained : String(obj(retained[0]).text ?? '');
      // Preserve all non-image prompt edits. Never modify the frozen case request.
    }
    const input = obj(detail.input);
    const frames = selected.map((frame) => ({
      sourceId: frame.sourceId,
      observedAt: frame.observedAt,
      width: frame.width,
      height: frame.height,
      dataUrl: frame.dataUrl,
      ...(frame.mediaTimeMs === undefined ? {} : { mediaTimeMs: frame.mediaTimeMs }),
    }));
    validateRawSimulationRequest(json(request), frames, MAX_SIMULATION_FRAME_DATA_URL);
    if (typeof body.seed !== 'number' || !Number.isSafeInteger(body.seed))
      throw new Error('Case experiments require a valid explicit seed.');
    return {
      modelId,
      input: { ...(input as unknown as InferenceInput), seed: body.seed, frames },
      submitted: request,
      frames: selected,
    };
  }
  async saveChild(
    id: string,
    result: SimulationExperimentResult,
    frameIndices: readonly number[],
  ): Promise<SavedCaseChild> {
    const caseRoot = this.file(id);
    const entries = await this.children(id);
    if (entries.length >= MAX_CHILDREN)
      throw new Error('Saved case child experiment limit reached.');
    const body = obj(result.submittedRequest);
    const child: Omit<SavedCaseChild, 'outcome'> = {
      id: randomUUID(),
      parentCaseId: id,
      createdAt: new Date().toISOString(),
      modelId: result.modelId,
      seed: body.seed as number,
      errorStage: result.errorStage,
      error: result.error?.slice(0, 400) ?? null,
      durationMs: result.durationMs,
      frameIndices: [...frameIndices],
    };
    const outcome = {
      submittedRequest: replaceImages(
        result.submittedRequest,
        (url) => 'saved-frame:' + sha(jpeg(url)),
      ),
      rawNativeOutput: result.rawNativeOutput,
      normalizedResult: result.normalizedResult,
      parsedResult: result.parsedResult ?? null,
      accepted: result.accepted,
      usage: result.usage,
    };
    const copy = json(outcome);
    const stored = {
      ...child,
      outcome:
        Buffer.byteLength(copy) <= 2 * 1024 * 1024
          ? outcome
          : {
              submittedRequest: outcome.submittedRequest,
              rawNativeOutput: null,
              normalizedResult: null,
              parsedResult: null,
              accepted: null,
              usage: result.usage,
              omitted: 'Child output exceeded the 2 MiB persistence limit.',
            },
    };
    const payload = json(stored);
    if ((await this.total()).bytes + Buffer.byteLength(payload) > MAX_TOTAL_BYTES)
      throw new Error('Saved case storage limit reached; no existing cases were removed.');
    await writeFile(path.join(caseRoot, 'child-' + child.id + '.json'), payload, {
      flag: 'wx',
      mode: 0o600,
    });
    return stored;
  }
  /** Portable JSON is imported as a new immutable case with new ID after all blob checks. */
  async exportPortable(id: string): Promise<string> {
    const manifest = await this.read(id);
    const blobs = await this.loadImages(manifest);
    const children = await this.children(id);
    return json({
      format: 'lonely-chat-exact-case',
      version: VERSION,
      manifest,
      children,
      images: Object.fromEntries(
        [...blobs].map(([hash, bytes]) => [hash, bytes.toString('base64')]),
      ),
    });
  }
  async importPortable(raw: string): Promise<SavedCaseSummary> {
    if (Buffer.byteLength(raw) > 96 * 1024 * 1024) throw new Error('Imported case is too large.');
    const archive = obj(JSON.parse(raw));
    if (archive.format !== 'lonely-chat-exact-case' || archive.version !== VERSION)
      throw new Error('Unknown saved case archive version.');
    const manifest = validateManifest(archive.manifest);
    const images = obj(archive.images);
    const blobs = new Map<string, Buffer>();
    for (const frame of manifest.frames) {
      const hash = frame.ref.slice(12);
      const value = images[hash];
      if (typeof value !== 'string') throw new Error('Archive is missing a selected JPEG.');
      const bytes = jpeg('data:image/jpeg;base64,' + value);
      if (sha(bytes) !== hash) throw new Error('Imported JPEG failed integrity verification.');
      blobs.set(hash, bytes);
    }
    if (Object.keys(images).some((key) => !blobs.has(key)))
      throw new Error('Archive contains unreferenced images.');
    const expanded = replaceImages(manifest.request, (url) => {
      const match = REF.exec(url);
      if (!match || !blobs.has(match[1])) throw new Error('Invalid imported frame reference.');
      return 'data:image/jpeg;base64,' + blobs.get(match[1])!.toString('base64');
    });
    const frames = manifest.frames.map((frame) => ({
      ...frame,
      dataUrl: 'data:image/jpeg;base64,' + blobs.get(frame.ref.slice(12))!.toString('base64'),
    }));
    validateRawSimulationRequest(json(expanded), frames, MAX_SIMULATION_FRAME_DATA_URL);
    const original = manifest.summary;
    const nextId = randomUUID();
    const childrenRaw = archive.children ?? [];
    if (!Array.isArray(childrenRaw) || childrenRaw.length > MAX_CHILDREN)
      throw new Error('Invalid imported case child list.');
    const seenChildren = new Set<string>();
    const children: SavedCaseChild[] = childrenRaw.map((item) => {
      const child = validateStoredChild(item, original.id, manifest.frames.length);
      if (seenChildren.has(child.id)) throw new Error('Corrupt imported case child.');
      if (imageUrls(child.outcome.submittedRequest).some(
        (ref) => !REF.test(ref) || !blobs.has(ref.slice(12)),
      ))
        throw new Error('Invalid imported child request or evidence.');
      seenChildren.add(child.id);
      return { ...child, id: randomUUID(), parentCaseId: nextId };
    });
    return this.commit(
      {
        ...manifest,
        summary: { ...original, id: nextId, savedAt: new Date().toISOString(), childCount: 0 },
      },
      blobs,
      children,
    );
  }
}
