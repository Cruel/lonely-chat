/**
 * Full-file, chunked SHA-256 identity. Hash the ordered chunk hashes so a multi-GB
 * recording never needs to be buffered in memory. No media bytes leave the renderer.
 */
const CHUNK_BYTES = 2 * 1024 * 1024;
const pending = new WeakMap<File, Promise<string>>();

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function mediaFingerprint(file: File): Promise<string> {
  const existing = pending.get(file);
  if (existing) return existing;
  const fingerprint = (async () => {
    let hash = new Uint8Array(32);
    for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
      const bytes = await file.slice(offset, offset + CHUNK_BYTES).arrayBuffer();
      const chunkHash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      const combined = new Uint8Array(64);
      combined.set(hash, 0);
      combined.set(chunkHash, 32);
      hash = new Uint8Array(await crypto.subtle.digest('SHA-256', combined));
    }
    const final = new Uint8Array(40);
    final.set(hash);
    new DataView(final.buffer).setBigUint64(32, BigInt(file.size), true);
    return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', final)));
  })();
  pending.set(file, fingerprint);
  void fingerprint.catch(() => pending.delete(file));
  return fingerprint;
}
