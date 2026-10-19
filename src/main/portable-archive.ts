import { createHash } from 'node:crypto';

/** Deliberately not a general-purpose archive extractor: entries are data, never file paths. */
const MAX_ARCHIVE_BYTES = 192 * 1024 * 1024;
const MAX_ENTRY_BYTES = 128 * 1024 * 1024;
const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 4096;
const HASH = /^[a-f0-9]{64}$/;
const NAME = /^[a-z0-9][a-z0-9._/-]{0,199}$/;

type Entry = { name: string; sha256: string; size: number; data: string };
export type ArchiveKind = 'scenario' | 'run';

export function archiveHash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function makeArchive(
  kind: ArchiveKind,
  metadata: unknown,
  files: ReadonlyMap<string, Buffer>,
): string {
  if (files.size > MAX_ENTRIES) throw new Error('Too many portable archive entries.');
  const entries: Entry[] = [];
  let total = 0;
  for (const [name, bytes] of files) {
    checkName(name);
    if (bytes.length > MAX_ENTRY_BYTES)
      throw new Error('Portable archive entry exceeds size limit.');
    total += bytes.length;
    if (total > MAX_ARCHIVE_BYTES / 1.4) throw new Error('Portable archive exceeds size limit.');
    entries.push({
      name,
      sha256: archiveHash(bytes),
      size: bytes.length,
      data: bytes.toString('base64'),
    });
  }
  const meta = JSON.stringify(metadata);
  if (!meta || Buffer.byteLength(meta) > MAX_METADATA_BYTES)
    throw new Error('Portable archive metadata exceeds size limit.');
  const raw = JSON.stringify({
    format: 'lonely-chat-portable',
    version: 1,
    kind,
    metadata,
    entries,
  });
  if (Buffer.byteLength(raw) > MAX_ARCHIVE_BYTES)
    throw new Error('Portable archive exceeds size limit.');
  return raw;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid portable archive structure.');
  return value as Record<string, unknown>;
}
/** Linear-time alphabet/padding validation; a repeated-group regex can overflow on video-sized base64. */
function canonicalBase64(value: string, bytes: number): boolean {
  if (value.length !== Math.ceil(bytes / 3) * 4) return false;
  const pad = bytes % 3 === 0 ? 0 : 3 - (bytes % 3);
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (i >= value.length - pad) {
      if (code !== 61) return false;
    } else if (
      !(
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) ||
        (code >= 48 && code <= 57) ||
        code === 43 ||
        code === 47
      )
    ) {
      return false;
    }
  }
  return true;
}

function checkName(name: string): void {
  if (
    !NAME.test(name) ||
    name.includes('..') ||
    name.includes('//') ||
    name.startsWith('/') ||
    name.split('/').some((segment) => segment === '.' || segment === '..')
  )
    throw new Error('Unsafe portable archive entry path.');
}

export function openArchive(
  raw: string,
  expected: ArchiveKind,
): {
  metadata: unknown;
  files: Map<string, Buffer>;
} {
  if (Buffer.byteLength(raw) > MAX_ARCHIVE_BYTES)
    throw new Error('Portable archive exceeds size limit.');
  const archive = record(JSON.parse(raw));
  if (
    archive.format !== 'lonely-chat-portable' ||
    archive.version !== 1 ||
    archive.kind !== expected
  )
    throw new Error('Unsupported portable archive format or version.');
  const metadata = JSON.stringify(archive.metadata);
  if (!metadata || Buffer.byteLength(metadata) > MAX_METADATA_BYTES)
    throw new Error('Invalid portable archive metadata.');
  if (!Array.isArray(archive.entries) || archive.entries.length > MAX_ENTRIES)
    throw new Error('Invalid portable archive entries.');
  const files = new Map<string, Buffer>();
  let total = 0;
  for (const value of archive.entries) {
    const entry = record(value);
    if (typeof entry.name !== 'string') throw new Error('Invalid archive entry name.');
    checkName(entry.name);
    if (files.has(entry.name)) throw new Error('Duplicate portable archive entry.');
    if (
      typeof entry.sha256 !== 'string' ||
      !HASH.test(entry.sha256) ||
      !Number.isSafeInteger(entry.size) ||
      (entry.size as number) < 0 ||
      (entry.size as number) > MAX_ENTRY_BYTES ||
      typeof entry.data !== 'string' ||
      !canonicalBase64(entry.data, entry.size as number)
    )
      throw new Error('Invalid portable archive payload.');
    total += entry.size as number;
    if (total > MAX_ARCHIVE_BYTES / 1.4)
      throw new Error('Portable archive expanded size limit exceeded.');
    const bytes = Buffer.from(entry.data, 'base64');
    if (
      bytes.length !== entry.size ||
      bytes.toString('base64') !== entry.data ||
      archiveHash(bytes) !== entry.sha256
    )
      throw new Error('Portable archive payload failed integrity verification.');
    files.set(entry.name, bytes);
  }
  return { metadata: archive.metadata, files };
}
