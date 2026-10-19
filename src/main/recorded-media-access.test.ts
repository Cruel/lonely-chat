import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { RecordedMediaAccess } from './recorded-media-access';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});
it('serves only authorized, opaque local media URLs and supports Chromium byte-range requests', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lonely-media-'));
  roots.push(root);
  const video = path.join(root, 'stream.mp4');
  const bytes = Buffer.from('abcdefghijklmnopqrstuvwxyz');
  await writeFile(video, bytes);
  const access = new RecordedMediaAccess();
  const url = await access.open(video);
  expect(url).not.toContain(root);
  const full = await access.serve(new Request(url));
  expect(full.status).toBe(200);
  expect(Buffer.from(await full.arrayBuffer())).toEqual(bytes);
  const partial = await access.serve(new Request(url, { headers: { range: 'bytes=2-6' } }));
  expect(partial.status).toBe(206);
  expect(partial.headers.get('Content-Range')).toBe('bytes 2-6/26');
  expect(Buffer.from(await partial.arrayBuffer()).toString()).toBe('cdefg');
  const suffix = await access.serve(new Request(url, { headers: { range: 'bytes=-3' } }));
  expect(Buffer.from(await suffix.arrayBuffer()).toString()).toBe('xyz');
  expect(
    (await access.serve(new Request(url, { headers: { range: 'bytes=100-200' } }))).status,
  ).toBe(416);
  expect((await access.serve(new Request('lonely-recorded-media://desktop/invalid'))).status).toBe(
    404,
  );
  expect(await readFile(video)).toEqual(bytes);
});
it('fingerprints exact source bytes without copying multi-MB media into storage', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lonely-media-'));
  roots.push(root);
  const media = path.join(root, 'stream.wav');
  await writeFile(media, Buffer.alloc(2 * 1024 * 1024 + 40, 25));
  const access = new RecordedMediaAccess();
  const first = await access.fingerprint(media);
  expect(first).toMatch(/^[a-f0-9]{64}$/);
  expect(await access.fingerprint(media)).toBe(first);
  await writeFile(media, Buffer.alloc(2 * 1024 * 1024 + 40, 26));
  expect(await access.fingerprint(media)).not.toBe(first);
  await expect(access.open('/nonexistent/invalid.mp4')).rejects.toThrow();
  await expect(access.open(path.join(root, 'unexpected.json'))).rejects.toThrow(/supported/);
});
