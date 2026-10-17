import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ModelDiscovery } from './model-discovery';
import { ModelInstallManager } from './model-install-manager';
import type { ModelInstallRequest } from '../shared/model-install-contract';

const folders: string[] = [];
const q4 = 'weights/vision-Q4_K_M-00001-of-00002.gguf';
const q4b = 'weights/vision-Q4_K_M-00002-of-00002.gguf';
const proj = 'weights/mmproj-F16.gguf';
const speech = 'ggml-base.en.bin';
const selection: ModelInstallRequest = {
  source: 'acme/vision',
  candidateId: 'weights/vision-Q4_K_M.gguf',
  projectorId: 'weights/mmproj-F16.gguf',
};

async function fixture(options?: { capacity?: number }) {
  const userData = await mkdtemp(path.join(tmpdir(), 'lonely-chat-install-'));
  folders.push(userData);
  const bytes: Record<string, Buffer> = {
    [q4]: Buffer.from('first shard'),
    [q4b]: Buffer.from('second shard'),
    [proj]: Buffer.from('vision projector'),
    [speech]: Buffer.from('speech weights'),
  };
  const requests: { file: string; range: string | undefined }[] = [];
  let interrupt: string | null = null;
  let corrupt: string | null = null;
  let ignoreRange = false;
  let etag = '"stable-etag"';
  let capacity = options?.capacity ?? Number.MAX_SAFE_INTEGER;
  const fetcher = vi.fn(async (raw: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(raw));
    if (url.pathname === '/api/models/acme/vision') {
      return new Response(JSON.stringify({ id: 'acme/vision' }), { status: 200 });
    }
    if (url.pathname === '/api/models/acme/vision/tree/main') {
      return new Response(
        JSON.stringify(
          Object.entries(bytes).map(([file, data]) => ({
            type: 'file',
            path: file,
            size: data.byteLength,
            lfs: { size: data.byteLength, oid: createHash('sha256').update(data).digest('hex') },
          })),
        ),
      );
    }
    if (url.pathname.startsWith('/acme/vision/resolve/main/')) {
      const file = decodeURIComponent(url.pathname.slice('/acme/vision/resolve/main/'.length));
      const original = bytes[file];
      if (!original) return new Response(null, { status: 404 });
      const range = new Headers(init?.headers).get('range') ?? undefined;
      requests.push({ file, range });
      const offset = range && !ignoreRange ? Number(range.match(/^bytes=(\d+)-$/)?.[1]) : 0;
      const payload = corrupt === file ? Buffer.alloc(original.byteLength, 'X') : original;
      const data = payload.subarray(offset);
      let chunks = 0;
      const body = new ReadableStream({
        pull(controller) {
          if (interrupt === file && chunks > 0) {
            controller.error(new Error('Connection interrupted'));
            return;
          }
          if (chunks >= data.byteLength) {
            controller.close();
            return;
          }
          const end = Math.min(chunks + 4, data.byteLength);
          controller.enqueue(data.subarray(chunks, end));
          chunks = end;
        },
      });
      return new Response(body, {
        status: offset ? 206 : 200,
        headers: {
          etag,
          'content-length': String(data.byteLength),
          ...(offset
            ? {
                'content-range': `bytes ${offset}-${original.byteLength - 1}/${original.byteLength}`,
              }
            : {}),
        },
      });
    }
    throw new Error(`Unexpected URL ${url}`);
  });
  const make = () =>
    new ModelInstallManager(
      userData,
      new ModelDiscovery(fetcher as typeof fetch),
      fetcher as typeof fetch,
      async () => capacity,
    );
  const manager = make();
  await manager.open();
  return {
    userData,
    bytes,
    requests,
    fetcher,
    manager,
    make,
    setInterrupt: (file: string | null) => {
      interrupt = file;
    },
    setCorrupt: (file: string | null) => {
      corrupt = file;
    },
    ignoreRanges: () => {
      ignoreRange = true;
    },
    changeEtag: () => {
      etag = '"changed-etag"';
    },
    setCapacity: (amount: number) => {
      capacity = amount;
    },
  };
}

afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

describe('managed model packages via public model-manager service', () => {
  it('atomically installs model shards and its projector, reports progress, persists and activates', async () => {
    const app = await fixture();
    const events: number[] = [];
    const unsubscribe = app.manager.subscribe((status) => {
      if (status.progress.phase === 'downloading') events.push(status.progress.receivedBytes);
    });
    const result = await app.manager.install(selection);
    unsubscribe();
    expect(result.installations).toHaveLength(1);
    expect(result.installations[0].files.map((file) => file.path)).toEqual([q4, q4b, proj]);
    expect(result.installations[0].files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(
      true,
    );
    expect(result.progress.phase).toBe('idle');
    expect(events.some((size) => size > 0)).toBe(true);
    const entry = result.installations[0];
    const installed = path.join(result.storageDirectory, 'installed', entry.id);
    expect(await readFile(path.join(installed, 'files', q4), 'utf8')).toBe('first shard');
    expect(await readdir(path.join(result.storageDirectory, '.partial'))).toEqual([]);
    await app.manager.setActive('vision-language', entry.id);
    const reopened = app.make();
    const restored = await reopened.open();
    expect(restored.installations).toEqual(result.installations);
    expect(restored.active).toEqual({ 'vision-language': entry.id, 'speech-to-text': null });
    await reopened.setActive('vision-language', null);
    expect((await app.make().open()).active['vision-language']).toBeNull();
  });

  it('resolves verified active model shards/projector and rejects modified weights before launch', async () => {
    const app = await fixture();
    await expect(app.manager.activeVisionFiles()).rejects.toThrow(/Activate an installed/);
    const installed = await app.manager.install(selection);
    const model = installed.installations[0];
    await app.manager.setActive('vision-language', model.id);
    const resolved = await app.manager.activeVisionFiles();
    expect(resolved.modelPath).toBe(
      path.join(installed.storageDirectory, 'installed', model.id, 'files', q4),
    );
    expect(resolved.projectorPath).toBe(
      path.join(installed.storageDirectory, 'installed', model.id, 'files', proj),
    );
    await writeFile(resolved.modelPath, 'tampered model');
    await expect(app.manager.activeVisionFiles()).rejects.toThrow(/verification/);
  });

  it('keeps interrupted bytes private, resumes with HTTP Range and publishes only after verification', async () => {
    const app = await fixture();
    app.setInterrupt(q4);
    await expect(app.manager.install(selection)).rejects.toThrow(/interrupted/);
    expect(app.manager.snapshot().installations).toEqual([]);
    expect(app.manager.snapshot().progress.phase).toBe('idle');
    const stage = path.join(app.manager.snapshot().storageDirectory, '.partial');
    expect((await readdir(stage)).length).toBe(1);
    app.setInterrupt(null);
    const result = await app.manager.install(selection);
    expect(result.installations).toHaveLength(1);
    expect(app.requests.filter((r) => r.file === q4).map((r) => r.range)).toEqual([
      undefined,
      'bytes=4-',
    ]);
  });

  it('restarts rather than appending if the server ignores an HTTP Range request', async () => {
    const app = await fixture();
    app.setInterrupt(q4);
    await expect(app.manager.install(selection)).rejects.toThrow();
    app.setInterrupt(null);
    app.ignoreRanges();
    const installed = await app.manager.install(selection);
    expect(installed.installations).toHaveLength(1);
    expect(app.requests.filter((r) => r.file === q4).map((r) => r.range)).toEqual([
      undefined,
      'bytes=4-',
    ]);
    const entry = installed.installations[0];
    expect(
      await readFile(
        path.join(installed.storageDirectory, 'installed', entry.id, 'files', q4),
        'utf8',
      ),
    ).toBe('first shard');
  });

  it('resumes after application restart and restarts when the ETag changes during a resumed transfer', async () => {
    const app = await fixture();
    app.setInterrupt(q4);
    await expect(app.manager.install(selection)).rejects.toThrow(/interrupted/);
    app.setInterrupt(null);
    app.changeEtag();
    const reopened = app.make();
    await reopened.open();
    expect((await reopened.install(selection)).installations).toHaveLength(1);
    expect(
      app.requests.filter((request) => request.file === q4).map((request) => request.range),
    ).toEqual([undefined, 'bytes=4-', undefined]);
  });

  it('recovers a verified package published before its registry entry was saved', async () => {
    const app = await fixture();
    const original = (await app.manager.install(selection)).installations[0];
    await rm(path.join(app.userData, 'model-manager.json'));
    const reopened = app.make();
    expect((await reopened.open()).installations).toEqual([]);
    const before = app.requests.length;
    expect((await reopened.install(selection)).installations).toEqual([original]);
    expect(app.requests).toHaveLength(before);
    expect((await app.make().open()).installations).toEqual([original]);
  });

  it('cancels an in-progress stream without publishing and resumes on retry', async () => {
    const app = await fixture();
    const unsubscribe = app.manager.subscribe((snapshot) => {
      if (snapshot.progress.receivedBytes > 0) app.manager.cancel();
    });
    await expect(app.manager.install(selection)).rejects.toThrow(/cancelled/i);
    unsubscribe();
    expect(app.manager.snapshot().installations).toEqual([]);
    expect((await app.manager.install(selection)).installations).toHaveLength(1);
  });

  it('rejects bad SHA-256, never registers corrupted files, and retries cleanly', async () => {
    const app = await fixture();
    app.setCorrupt(q4);
    await expect(app.manager.install(selection)).rejects.toThrow(/SHA-256 verification failed/);
    expect(app.manager.snapshot().installations).toHaveLength(0);
    app.setCorrupt(null);
    const installed = await app.manager.install(selection);
    expect(installed.installations).toHaveLength(1);
    const entry = installed.installations[0];
    const filename = path.join(installed.storageDirectory, 'installed', entry.id, 'files', q4);
    await writeFile(filename, Buffer.alloc(app.bytes[q4].byteLength, 'Z'));
    await expect(app.manager.setActive(entry.role, entry.id)).rejects.toThrow(/verification/);
    const reopened = app.make();
    expect((await reopened.open()).installations).toEqual([]);
    expect(await readFile(filename)).toHaveLength(app.bytes[q4].byteLength);
  });

  it('checks available disk space before streaming and supports retry after space is available', async () => {
    const app = await fixture({ capacity: 1 });
    await expect(app.manager.install(selection)).rejects.toThrow(/disk space/);
    expect(app.manager.snapshot().installations).toEqual([]);
    app.setCapacity(10_000);
    expect((await app.manager.install(selection)).installations).toHaveLength(1);
  });

  it('refuses duplicate installations, unsafe role selection and a projector on speech', async () => {
    const app = await fixture();
    const one = (await app.manager.install(selection)).installations[0];
    await expect(app.manager.install(selection)).rejects.toThrow(/already installed/);
    await expect(app.manager.setActive('speech-to-text', one.id)).rejects.toThrow(/requested role/);
    await expect(
      app.manager.install({
        source: 'acme/vision',
        candidateId: speech,
        projectorId: proj,
      }),
    ).rejects.toThrow(/Speech models/);
    const two = (
      await app.manager.install({
        source: 'acme/vision',
        candidateId: speech,
        projectorId: null,
      })
    ).installations.find((entry) => entry.role === 'speech-to-text');
    expect(two?.files.map((file) => file.path)).toEqual([speech]);
    const active = await app.manager.setActive('speech-to-text', two!.id);
    expect(active.active).toEqual({ 'vision-language': null, 'speech-to-text': two!.id });
    const resolvedSpeech = await app.manager.activeSpeechFile();
    expect(await readFile(resolvedSpeech, 'utf8')).toBe('speech weights');
    await writeFile(resolvedSpeech, 'tampered speech weights');
    await expect(app.manager.activeSpeechFile()).rejects.toThrow(/verification/);
  });

  it('changes selected storage, removes only owned packages and clears their active role', async () => {
    const app = await fixture();
    const alternate = path.join(app.userData, 'alternate-storage');
    await mkdir(alternate);
    const outside = path.join(alternate, 'personal-notes.txt');
    await writeFile(outside, 'not managed');
    await app.manager.changeDirectory(alternate);
    expect(app.manager.snapshot().storageDirectory).toBe(alternate);
    const entry = (await app.manager.install(selection)).installations[0];
    await app.manager.setActive('vision-language', entry.id);
    await expect(app.manager.changeDirectory(app.userData)).rejects.toThrow(/Remove installed/);
    const after = await app.manager.remove(entry.id);
    expect(after.installations).toHaveLength(0);
    expect(after.active['vision-language']).toBeNull();
    expect(await readFile(outside, 'utf8')).toBe('not managed');
    await expect(app.manager.remove(entry.id)).rejects.toThrow(/not registered/);
    expect((await app.make().open()).storageDirectory).toBe(alternate);
  });

  it('refuses to follow symlinks during removal or touch files outside the managed package', async () => {
    const app = await fixture();
    const entry = (await app.manager.install(selection)).installations[0];
    const directory = path.join(app.manager.snapshot().storageDirectory, 'installed', entry.id);
    const outside = path.join(app.userData, 'precious.txt');
    await writeFile(outside, 'preserve');
    await symlink(outside, path.join(directory, 'external-link'));
    await expect(app.manager.remove(entry.id)).rejects.toThrow(/symlink/i);
    expect(await readFile(outside, 'utf8')).toBe('preserve');
    expect(app.manager.snapshot().installations).toHaveLength(1);
  });
});
