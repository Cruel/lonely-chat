import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readlink, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LLAMA_ASSETS,
  LLAMA_RELEASE,
  WHISPER_COMMIT,
  WHISPER_ARCHIVE_SHA256,
} from './native-release.mjs';

const SOURCE_SHA256 = WHISPER_ARCHIVE_SHA256;

async function requireFile(file) {
  const info = await stat(file);
  assert.ok(info.isFile() && info.size > 0, `Missing executable/library: ${file}`);
}
async function verifyBin(directory) {
  const entries = await readdir(directory);
  for (const name of entries) {
    const item = path.join(directory, name);
    const info = await lstat(item);
    if (!info.isSymbolicLink()) continue;
    const raw = await readlink(item);
    const resolved = path.resolve(directory, raw);
    assert.equal(path.dirname(resolved), directory, `Escaping symlink: ${item}`);
    await requireFile(resolved);
  }
}
async function sha256(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

/** Verify a staged or packaged native root using only the authoritative pins. */
export async function verifyNativeStage(root, target, requireAccelerators = false) {
  const assets = LLAMA_ASSETS[target];
  assert.ok(assets, `Unsupported native target ${target}`);
  const llama = path.join(path.resolve(root), 'llama', target);
  const manifest = JSON.parse(await readFile(path.join(llama, 'manifest.json'), 'utf8'));
  assert.equal(manifest.schema, 1);
  assert.equal(manifest.target, target);
  assert.equal(manifest.release, LLAMA_RELEASE);
  assert.equal(
    (await readFile(path.join(llama, '.release'), 'utf8')).trim(),
    `${LLAMA_RELEASE}:${assets.cpu[1]}:stage-v2`,
  );
  const variants = Object.keys(manifest.variants).sort();
  const required =
    requireAccelerators && target !== 'darwin-arm64' ? ['cpu', 'cuda', 'vulkan'] : ['cpu'];
  for (const variant of required) {
    assert.ok(variants.includes(variant), `Missing release accelerator: ${variant}`);
  }
  for (const variant of variants) {
    const pinned = assets[variant];
    assert.ok(pinned, `Unknown native variant ${variant}`);
    assert.equal(manifest.variants[variant].artifact, pinned[0]);
    assert.equal(manifest.variants[variant].sha256, pinned[1]);
    if (variant === 'cuda') {
      assert.deepEqual(manifest.variants.cuda.cudart, {
        artifact: assets.cudart[0],
        sha256: assets.cudart[1],
      });
    }
    const binaryDir = path.join(llama, ...(variant === 'cpu' ? [] : [variant]), 'bin');
    await requireFile(
      path.join(binaryDir, target.startsWith('win32') ? 'llama-server.exe' : 'llama-server'),
    );
    await verifyBin(binaryDir);
    if (target === 'darwin-arm64') {
      assert.ok(
        (await readdir(binaryDir)).some((name) => /ggml-metal.*\.dylib/.test(name)),
        'macOS Metal backend dylib must be bundled with the native executable',
      );
    }
    if (variant !== 'cpu') {
      const entries = await readdir(binaryDir);
      const pattern = variant === 'vulkan' ? /ggml.vulkan/i : /ggml.cuda/i;
      assert.ok(
        entries.some((item) => pattern.test(item)),
        `No ${variant} GPU backend library included in ${binaryDir}`,
      );
    }
  }
  const whisper = path.join(path.resolve(root), 'whisper', target);
  const info = JSON.parse(await readFile(path.join(whisper, 'manifest.json'), 'utf8'));
  assert.equal(info.schema, 1);
  assert.equal(info.target, target);
  assert.equal(info.upstreamCommit, WHISPER_COMMIT);
  assert.equal(info.sourceSha256, SOURCE_SHA256);
  assert.equal(info.cpuOnly, true);
  assert.equal(info.buildConfig, 'cpu-static-msvc-crt-no-openmp-v4');
  assert.match(info.workerSha256, /^[0-9a-f]{64}$/);
  assert.equal(
    (await readFile(path.join(whisper, '.release'), 'utf8')).trim(),
    `${WHISPER_COMMIT}:framed-v1`,
  );
  const worker = path.join(
    whisper,
    'bin',
    target.startsWith('win32') ? 'lonely-whisper-worker.exe' : 'lonely-whisper-worker',
  );
  await requireFile(worker);
  assert.equal(await sha256(worker), info.workerSha256, 'Whisper executable hash mismatch');
  await verifyBin(path.dirname(worker));
  return { target, variants };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const script = path.dirname(fileURLToPath(import.meta.url));
  const root = process.argv[2] ?? path.resolve(script, '..', 'native');
  const target = process.argv[3] ?? `${process.platform}-${process.arch}`;
  const result = await verifyNativeStage(root, target, process.argv.includes('--accelerators'));
  console.log(
    `PASS: pinned ${result.target} native manifests, workers and libraries [${result.variants}]`,
  );
}
