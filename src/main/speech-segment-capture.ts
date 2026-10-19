import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CapturedSpeechSegment, SpeechCaptureStatus } from '../shared/speech-capture-contract';

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_RECORDS = 256;
const MAX_SEGMENT_SAMPLES = 16000 * 30;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const errorText = (value: unknown) => (value instanceof Error ? value.message : String(value));

interface Pending {
  meta: Omit<CapturedSpeechSegment, 'result' | 'text' | 'error' | 'durationMs' | 'bytes'>;
  pcm: Buffer;
  reserved: number;
}

/** Private audio capture, independent of Compact/Exact and ordinary logs.
 * Enabling is intentionally process-local: every launch starts with capture OFF.
 * Each admitted segment stays admitted when capture is turned off while Whisper runs.
 */
export class SpeechSegmentCapture {
  private readonly directory: string;
  private enabled = false;
  private storageBlocked = false;
  private warning: string | null = null;
  private bytes = 0;
  private reserved = 0;
  private readonly records = new Map<string, CapturedSpeechSegment>();
  private readonly pending = new Map<string, Pending>();
  private readonly sequences = new Map<string, number>();
  private readonly listeners = new Set<(status: SpeechCaptureStatus) => void>();
  private io: Promise<void> = Promise.resolve();

  constructor(
    root: string,
    private readonly reportError: (error: unknown) => void = () => {},
  ) {
    this.directory = path.join(root, 'speech-segments');
  }

  subscribe(listener: (status: SpeechCaptureStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  status(): SpeechCaptureStatus {
    return {
      enabled: this.enabled,
      bytes: this.bytes + this.reserved,
      maxBytes: MAX_BYTES,
      pending: this.pending.size,
      records: [...this.records.values()].sort(
        (a, b) => b.capturedAt - a.capturedAt || b.id.localeCompare(a.id),
      ),
      warning: this.warning,
    };
  }

  private publish(): void {
    const status = this.status();
    for (const listener of this.listeners) listener(status);
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.io.then(work, work);
    this.io = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  /** Only bounded, regular files under our own UUID filenames are reopened. */
  async load(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const entries = await readdir(this.directory, { withFileTypes: true });
    if (entries.length > MAX_RECORDS + 16) {
      this.storageBlocked = true;
      this.warning = 'Speech evidence directory exceeds the safety limit; review stored files.';
      this.publish();
      return;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      // An interrupted atomic write must not leave hidden private audio behind.
      if (ID_PATTERN.test(entry.name.slice(0, -4)) && entry.name.endsWith('.tmp')) {
        await rm(path.join(this.directory, entry.name));
        continue;
      }
      if (!entry.name.endsWith('.json')) continue;
      const id = entry.name.slice(0, -5);
      if (!ID_PATTERN.test(id)) continue;
      try {
        const file = path.join(this.directory, entry.name);
        const size = (await stat(file)).size;
        if (size > MAX_BYTES || this.bytes + size > MAX_BYTES || this.records.size >= MAX_RECORDS)
          throw new Error('Speech evidence storage limit exceeded');
        const parsed = JSON.parse(await readFile(file, 'utf8')) as {
          version: number;
          meta: CapturedSpeechSegment;
          pcmBase64: string;
        };
        if (
          parsed.version !== 1 ||
          parsed.meta?.id !== id ||
          parsed.meta?.sampleRate !== 16000 ||
          !/^[\w-]{1,80}$/.test(parsed.meta.sourceId) ||
          !/^[\w-]{1,80}$/.test(parsed.meta.captureId) ||
          typeof parsed.meta.label !== 'string' ||
          parsed.meta.label.length > 80 ||
          !['observation', 'input'].includes(parsed.meta.timeBase) ||
          !['transcribed', 'empty', 'failed'].includes(parsed.meta.result) ||
          ![
            parsed.meta.startMs,
            parsed.meta.endMs,
            parsed.meta.observedAt,
            parsed.meta.capturedAt,
            parsed.meta.durationMs,
          ].every(Number.isFinite) ||
          parsed.meta.startMs > parsed.meta.endMs ||
          !Number.isInteger(parsed.meta.sequence) ||
          !Number.isInteger(parsed.meta.sampleCount) ||
          parsed.meta.sampleCount < 1600 ||
          parsed.meta.sampleCount > MAX_SEGMENT_SAMPLES ||
          typeof parsed.pcmBase64 !== 'string' ||
          Buffer.from(parsed.pcmBase64, 'base64').byteLength !== parsed.meta.sampleCount * 4
        )
          throw new Error('Invalid speech evidence record');
        this.bytes += size;
        this.records.set(id, { ...parsed.meta, bytes: size });
      } catch (error) {
        this.storageBlocked = true;
        this.warning = 'Some stored speech evidence could not be loaded; files were not deleted.';
        this.reportError(error);
      }
    }
    this.publish();
  }

  configure(enabled: unknown): SpeechCaptureStatus {
    if (typeof enabled !== 'boolean') throw new Error('Invalid raw speech capture setting.');
    if (enabled && this.storageBlocked)
      throw new Error(
        'Resolve the invalid or excessive private speech evidence before enabling capture.',
      );
    if (enabled && (this.bytes + this.reserved >= MAX_BYTES || this.records.size >= MAX_RECORDS))
      throw new Error('Speech evidence limit reached. Delete records before enabling capture.');
    this.enabled = enabled;
    if (enabled) this.warning = null;
    this.publish();
    return this.status();
  }

  /** Takes a private copy only when explicitly enabled. Never holds caller-owned PCM. */
  begin(
    details: {
      sourceId: string;
      label: string;
      captureId: string;
      startMs: number;
      endMs: number;
      observedAt: number;
      timeBase: 'observation' | 'input';
    },
    samples: Float32Array,
  ): string | null {
    if (!this.enabled) return null;
    if (!ID_PATTERN.test(details.captureId) && !/^[\w-]{1,80}$/.test(details.captureId))
      throw new Error('Invalid speech capture identity.');
    if (
      !(samples instanceof Float32Array) ||
      samples.length < 1600 ||
      samples.length > MAX_SEGMENT_SAMPLES ||
      !samples.every((n) => Number.isFinite(n) && Math.abs(n) <= 1.01) ||
      ![details.startMs, details.endMs, details.observedAt].every(Number.isFinite) ||
      details.endMs < details.startMs
    )
      throw new Error('Invalid captured speech segment.');
    // Reserve the upper bound before copying, including base64 and JSON overhead.
    const reserved = Math.ceil((samples.length * 4 * 4) / 3) + 4096;
    if (
      this.records.size + this.pending.size >= MAX_RECORDS ||
      this.bytes + this.reserved + reserved > MAX_BYTES
    ) {
      this.enabled = false;
      this.warning =
        'Raw speech capture stopped at its 64 MiB / 256 segment cap. Existing evidence was retained.';
      this.publish();
      return null;
    }
    const id = randomUUID();
    const sourceKey = details.captureId;
    const sequence = (this.sequences.get(sourceKey) ?? 0) + 1;
    this.sequences.set(sourceKey, sequence);
    const pcm = Buffer.from(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
    this.pending.set(id, {
      meta: {
        id,
        sourceId: details.sourceId.slice(0, 80),
        label: details.label.slice(0, 80),
        captureId: details.captureId,
        sequence,
        timeBase: details.timeBase,
        startMs: details.startMs,
        endMs: details.endMs,
        observedAt: details.observedAt,
        capturedAt: Date.now(),
        sampleRate: 16000,
        sampleCount: samples.length,
      },
      pcm,
      reserved,
    });
    this.reserved += reserved;
    this.publish();
    return id;
  }

  /** Persist the actual worker outcome/error even if capture was disabled meanwhile. */
  async complete(
    id: string | null,
    outcome: { text?: string; error?: unknown; durationMs: number },
  ): Promise<void> {
    if (!id) return;
    await this.enqueue(async () => {
      const entry = this.pending.get(id);
      if (!entry) return; // Explicit clear cancelled the capture.
      const text = outcome.text?.trim().slice(0, 2000) || null;
      const error = outcome.error === undefined ? null : errorText(outcome.error).slice(0, 2000);
      const result: CapturedSpeechSegment['result'] = error
        ? 'failed'
        : text
          ? 'transcribed'
          : 'empty';
      const meta: CapturedSpeechSegment = {
        ...entry.meta,
        result,
        text,
        error,
        durationMs: Math.max(0, Math.round(outcome.durationMs)),
        bytes: 0,
      };
      const data = Buffer.from(
        JSON.stringify({ version: 1, meta, pcmBase64: entry.pcm.toString('base64') }),
      );
      const target = path.join(this.directory, id + '.json');
      const temporary = path.join(this.directory, id + '.tmp');
      try {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        if (this.bytes + data.length > MAX_BYTES)
          throw new Error('Speech evidence disk cap reached.');
        await writeFile(temporary, data, { mode: 0o600, flag: 'wx' });
        await rename(temporary, target);
        this.bytes += data.length;
        this.records.set(id, { ...meta, bytes: data.length });
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => {});
        this.enabled = false;
        this.warning = 'Raw speech capture stopped because evidence could not be saved.';
        this.reportError(error);
      } finally {
        // Clear may have cancelled this segment during the asynchronous write.
        if (this.pending.delete(id)) this.reserved -= entry.reserved;
        this.publish();
      }
    });
  }

  private requireId(id: unknown): string {
    if (typeof id !== 'string' || !ID_PATTERN.test(id) || !this.records.has(id))
      throw new Error('Unknown captured speech segment.');
    return id;
  }

  private async payload(id: string): Promise<Buffer> {
    const data = await readFile(path.join(this.directory, this.requireId(id) + '.json'));
    if (data.byteLength > MAX_BYTES) throw new Error('Speech evidence is too large.');
    return data;
  }

  async samples(id: string): Promise<{ meta: CapturedSpeechSegment; pcm: Float32Array }> {
    const data = await this.payload(id);
    const parsed = JSON.parse(data.toString('utf8')) as {
      version: number;
      meta: CapturedSpeechSegment;
      pcmBase64: string;
    };
    if (parsed.version !== 1 || parsed.meta?.id !== id || parsed.meta.sampleRate !== 16000)
      throw new Error('Speech evidence is corrupt.');
    const bytes = Buffer.from(parsed.pcmBase64, 'base64');
    if (
      bytes.length !== parsed.meta.sampleCount * 4 ||
      parsed.meta.sampleCount < 1600 ||
      parsed.meta.sampleCount > MAX_SEGMENT_SAMPLES
    )
      throw new Error('Speech PCM evidence is corrupt.');
    const pcm = new Float32Array(bytes.length / 4);
    for (let i = 0; i < pcm.length; i++) pcm[i] = bytes.readFloatLE(i * 4);
    return { meta: this.records.get(id)!, pcm };
  }

  /** Wait for all queued disk updates before application shutdown. */
  async flush(): Promise<void> {
    await this.io;
  }

  /** Versioned, self-contained evidence with no original media paths. */
  async exportRecord(id: string): Promise<Buffer> {
    return this.payload(id);
  }

  async deleteRecord(id: string): Promise<SpeechCaptureStatus> {
    return this.enqueue(async () => {
      const existing = this.records.get(this.requireId(id))!;
      await rm(path.join(this.directory, id + '.json'));
      this.records.delete(id);
      this.bytes -= existing.bytes;
      this.publish();
      return this.status();
    });
  }

  /** Explicit destructive operation: cancel pending writes and remove persisted clips. */
  async clear(): Promise<SpeechCaptureStatus> {
    this.enabled = false;
    this.pending.clear();
    this.reserved = 0;
    this.publish();
    return this.enqueue(async () => {
      for (const entry of await readdir(this.directory)) {
        if (
          (entry.endsWith('.tmp') && ID_PATTERN.test(entry.slice(0, -4))) ||
          (entry.endsWith('.json') && ID_PATTERN.test(entry.slice(0, -5)))
        )
          await rm(path.join(this.directory, entry));
      }
      this.records.clear();
      this.bytes = 0;
      this.storageBlocked = (await readdir(this.directory)).length > MAX_RECORDS + 16;
      this.warning = this.storageBlocked
        ? 'Unknown files remain in private speech evidence storage; capture is blocked.'
        : null;
      this.publish();
      return this.status();
    });
  }
}
