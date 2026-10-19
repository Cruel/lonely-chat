import { randomUUID, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat, open } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
};
export const MEDIA_SCHEME = 'lonely-recorded-media';

export function supportedRecordedMediaPath(file: string, kind: 'audio' | 'video'): boolean {
  const extension = path.extname(file).toLowerCase();
  if (!Object.hasOwn(MIME, extension)) return false;
  return kind === 'video'
    ? ['.mp4', '.m4v', '.webm', '.mov', '.mkv'].includes(extension)
    : ['.wav', '.flac', '.mp3', '.ogg', '.oga', '.m4a', '.aac'].includes(extension);
}

/** Opaque per-process URLs, scoped to approved desktop file selections. No path in URLs. */
export class RecordedMediaAccess {
  private readonly files = new Map<string, string>();
  async open(file: string): Promise<string> {
    if (
      typeof file !== 'string' ||
      !path.isAbsolute(file) ||
      file.length > 4096 ||
      !Object.hasOwn(MIME, path.extname(file).toLowerCase())
    )
      throw new Error('Select a supported local audio or video file.');
    const info = await stat(file);
    if (!info.isFile() || info.size === 0)
      throw new Error('The selected recording is empty or not a regular file.');
    const token = randomUUID();
    if (this.files.size >= 128) this.files.delete(this.files.keys().next().value!);
    this.files.set(token, file);
    return `${MEDIA_SCHEME}://desktop/${token}`;
  }

  /** Identical chunked fingerprint semantics to the renderer's File hashing. */
  async fingerprint(file: string): Promise<string> {
    if (
      typeof file !== 'string' ||
      !path.isAbsolute(file) ||
      file.length > 4096 ||
      !Object.hasOwn(MIME, path.extname(file).toLowerCase())
    )
      throw new Error('Unsupported recorded media path.');
    const handle = await open(file, 'r');
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size === 0) throw new Error('Invalid media file.');
      const chunkSize = 2 * 1024 * 1024;
      let hash = Buffer.alloc(32);
      for (let position = 0; position < info.size; position += chunkSize) {
        const size = Math.min(chunkSize, info.size - position);
        const data = Buffer.allocUnsafe(size);
        let used = 0;
        while (used < size) {
          const { bytesRead } = await handle.read(data, used, size - used, position + used);
          if (!bytesRead) throw new Error('Media file changed during fingerprinting.');
          used += bytesRead;
        }
        const chunkHash = createHash('sha256').update(data).digest();
        hash = createHash('sha256')
          .update(Buffer.concat([hash, chunkHash]))
          .digest();
      }
      const final = Buffer.alloc(40);
      hash.copy(final);
      final.writeBigUInt64LE(BigInt(info.size), 32);
      return createHash('sha256').update(final).digest('hex');
    } finally {
      await handle.close();
    }
  }

  async serve(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const token = url.hostname === 'desktop' ? url.pathname.slice(1) : '';
    const file = this.files.get(token);
    if (!file || !/^[a-f0-9-]{36}$/i.test(token))
      return new Response('Media not authorized', { status: 404 });
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size === 0) return new Response(null, { status: 404 });
      const range = request.headers.get('range');
      let start = 0;
      let end = info.size - 1;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match || (!match[1] && !match[2]))
          return new Response(null, {
            status: 416,
            headers: { 'Content-Range': `bytes */${info.size}` },
          });
        if (!match[1]) {
          start = Math.max(0, info.size - Number(match[2]));
        } else {
          start = Number(match[1]);
          if (match[2]) end = Math.min(end, Number(match[2]));
        }
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start >= info.size ||
          end < start
        )
          return new Response(null, {
            status: 416,
            headers: { 'Content-Range': `bytes */${info.size}` },
          });
      }
      const headers: Record<string, string> = {
        'Content-Type': MIME[path.extname(file).toLowerCase()],
        'Content-Length': String(end - start + 1),
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      };
      if (range) headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
      if (request.method === 'HEAD')
        return new Response(null, { status: range ? 206 : 200, headers });
      if (request.method !== 'GET') return new Response(null, { status: 405 });
      return new Response(
        Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream,
        { status: range ? 206 : 200, headers },
      );
    } catch {
      return new Response(null, { status: 404 });
    }
  }
}
