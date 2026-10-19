import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, statSync } from 'node:fs';
import { writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import type {
  TranscriptCacheAvailability,
  TranscriptCacheQuery,
} from '../shared/recorded-transcript-cache';
import { validateTranscriptCacheQuery } from '../shared/recorded-transcript-cache';

// Bump when resampling, VAD, transcript normalization or timing semantics change.
const PIPELINE_REVISION = 'mono16k-energy-vad-v1-whisper-v1';
const MAX_ENTRIES = 128;
const MAX_TRANSCRIPTS = 4096;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;

export interface CachedTranscript {
  readonly text: string;
  /** End-of-speech in the shared media timeline, relative to the run origin. */
  readonly observedMs: number;
  /** Earliest media-clock position when Whisper's reply was available to inference. */
  readonly availableMs: number;
}

interface Entry {
  readonly key: string;
  readonly fingerprint: string;
  readonly transcripts: readonly CachedTranscript[];
}

function validTranscripts(value: unknown): value is CachedTranscript[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_TRANSCRIPTS &&
    value.every(
      (item) =>
        item &&
        typeof item === 'object' &&
        typeof item.text === 'string' &&
        item.text.trim() === item.text &&
        item.text.length > 0 &&
        item.text.length <= 2000 &&
        Number.isFinite(item.observedMs) &&
        item.observedMs >= 0 &&
        item.observedMs <= 86_400_000 &&
        Number.isFinite(item.availableMs) &&
        item.availableMs >= item.observedMs &&
        item.availableMs <= 86_520_000,
    )
  );
}

/** Explicit opt-in text-only cache. Key never includes a filesystem path or source label. */
export class RecordedTranscriptCache {
  private readonly file: string;
  private readonly entries = new Map<string, Entry>();
  private invalid = false;
  private writing: Promise<void> = Promise.resolve();

  constructor(directory: string) {
    this.file = path.join(directory, 'recorded-transcripts.json');
    try {
      if (statSync(this.file).size > MAX_CACHE_BYTES)
        throw new Error('Transcript cache exceeds its storage limit.');
      const data: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (
        !data ||
        typeof data !== 'object' ||
        (data as { version?: unknown }).version !== 1 ||
        !Array.isArray((data as { entries?: unknown }).entries)
      )
        throw new Error('Invalid transcript cache format.');
      const items = (data as { entries: unknown[] }).entries;
      if (items.length > MAX_ENTRIES) throw new Error('Transcript cache is oversized.');
      for (const item of items) {
        const entry = item as Entry;
        if (
          !entry ||
          typeof entry.key !== 'string' ||
          !/^[a-f0-9]{64}$/.test(entry.key) ||
          typeof entry.fingerprint !== 'string' ||
          !/^[a-f0-9]{64}$/.test(entry.fingerprint) ||
          !validTranscripts(entry.transcripts) ||
          this.entries.has(entry.key)
        )
          throw new Error('Invalid transcript cache entry.');
        this.entries.set(entry.key, entry);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.invalid = true;
        this.entries.clear();
      }
    }
  }

  key(query: TranscriptCacheQuery, modelId: string): string {
    const descriptor = validateTranscriptCacheQuery(query);
    if (!modelId || typeof modelId !== 'string') throw new Error('Activate a speech model first.');
    return createHash('sha256')
      .update(
        JSON.stringify([
          PIPELINE_REVISION,
          modelId,
          descriptor.fingerprint,
          descriptor.offsetMs,
          descriptor.startMs,
          descriptor.endMs,
          descriptor.embeddedTrackIndex,
          descriptor.sampleRate,
        ]),
      )
      .digest('hex');
  }

  check(query: TranscriptCacheQuery, modelId: string): TranscriptCacheAvailability {
    const key = this.key(query, modelId);
    const entry = this.entries.get(key);
    if (entry) return { available: true, reason: 'ready', count: entry.transcripts.length };
    const stale = [...this.entries.values()].some(
      (candidate) => candidate.fingerprint === query.fingerprint,
    );
    return {
      available: false,
      reason: this.invalid ? 'invalid' : stale ? 'stale' : 'unavailable',
      count: 0,
    };
  }

  read(query: TranscriptCacheQuery, modelId: string): readonly CachedTranscript[] {
    const key = this.key(query, modelId);
    const entry = this.entries.get(key);
    if (!entry)
      throw new Error(
        'Transcript cache is unavailable or stale; transcribe and save this media first.',
      );
    return entry.transcripts.map((item) => ({ ...item }));
  }

  async save(
    query: TranscriptCacheQuery,
    modelId: string,
    transcripts: readonly CachedTranscript[],
  ): Promise<void> {
    const key = this.key(query, modelId);
    if (!validTranscripts(transcripts)) throw new Error('Invalid transcript cache content.');
    const entry: Entry = {
      key,
      fingerprint: query.fingerprint,
      transcripts: transcripts.map((item) => ({ ...item })),
    };
    if (Buffer.byteLength(JSON.stringify(entry)) > MAX_CACHE_BYTES - 128)
      throw new Error('Transcript cache entry exceeds the 32 MiB storage limit.');
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value!);
    this.invalid = false;
    let data = JSON.stringify({ version: 1, entries: [...this.entries.values()] });
    while (Buffer.byteLength(data) > MAX_CACHE_BYTES && this.entries.size > 1) {
      this.entries.delete(this.entries.keys().next().value!);
      data = JSON.stringify({ version: 1, entries: [...this.entries.values()] });
    }
    if (Buffer.byteLength(data) > MAX_CACHE_BYTES)
      throw new Error('Transcript cache entry exceeds the 32 MiB storage limit.');
    const next = this.writing
      .catch(() => {})
      .then(async () => {
        mkdirSync(path.dirname(this.file), { recursive: true });
        const temporary = this.file + '.tmp';
        await writeFile(temporary, data, { encoding: 'utf8', mode: 0o600 });
        await rename(temporary, this.file);
      });
    this.writing = next;
    await next;
  }
}
