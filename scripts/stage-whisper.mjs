import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { WHISPER_COMMIT, WHISPER_ARCHIVE_SHA256, TARGETS } from './native-release.mjs';

// Pinned whisper.cpp v1.9.5 commit. Build a small native framed-IPC executable on each target.
const COMMIT = WHISPER_COMMIT;
const SOURCE_SHA256 = WHISPER_ARCHIVE_SHA256;
const target = process.argv[2] ?? `${process.platform}-${process.arch}`;
if (!TARGETS.includes(target) || target !== `${process.platform}-${process.arch}`) {
  throw new Error(`Build whisper.cpp on its target host: ${target}`);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(root, 'native', 'whisper', target);
const marker = `${COMMIT}:framed-v1`;
try {
  if (
    (await readFile(path.join(destination, '.release'), 'utf8')).trim() === marker &&
    JSON.parse(await readFile(path.join(destination, 'manifest.json'), 'utf8')).buildConfig ===
      'cpu-static-msvc-crt-no-openmp-v4' &&
    JSON.parse(await readFile(path.join(destination, 'manifest.json'), 'utf8')).sourceSha256 ===
      SOURCE_SHA256
  ) {
    console.log(`Pinned whisper.cpp already staged for ${target}`);
    process.exit(0);
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`);
}
// CMake output and the final staged worker must be on the same volume so
// publication via rename also works with Windows CI's C:/D: drive split.
await mkdir(path.dirname(destination), { recursive: true });
const temporary = await mkdtemp(path.join(path.dirname(destination), '.lonely-whisper-'));
try {
  const archive = path.join(temporary, 'source.tar.gz');
  const response = await fetch(`https://github.com/ggml-org/whisper.cpp/archive/${COMMIT}.tar.gz`);
  if (!response.ok || !response.body || !response.url.startsWith('https://')) {
    throw new Error(`Unable to fetch pinned whisper.cpp source: HTTP ${response.status}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(archive, { mode: 0o600 }));
  const sourceHash = createHash('sha256');
  for await (const chunk of createReadStream(archive)) sourceHash.update(chunk);
  if (sourceHash.digest('hex') !== SOURCE_SHA256)
    throw new Error('Pinned whisper.cpp source SHA-256 mismatch.');
  run('tar', ['-xzf', archive, '-C', temporary]);
  const source = path.join(temporary, `whisper.cpp-${COMMIT}`);
  const build = path.join(temporary, 'build');
  run('cmake', [
    '-S',
    path.join(root, 'native', 'whisper-worker'),
    '-B',
    build,
    `-DWHISPER_SOURCE_DIR=${source}`,
    '-DCMAKE_BUILD_TYPE=Release',
    '-DGGML_BLAS=OFF',
    '-DGGML_NATIVE=OFF',
    '-DGGML_OPENMP=OFF',
  ]);
  run('cmake', [
    '--build',
    build,
    '--config',
    'Release',
    '--target',
    'lonely-whisper-worker',
    '--parallel',
    '2',
  ]);
  const binaryName =
    process.platform === 'win32' ? 'lonely-whisper-worker.exe' : 'lonely-whisper-worker';
  async function findBinary(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isFile() && entry.name === binaryName) return file;
      if (entry.isDirectory()) {
        const nested = await findBinary(file);
        if (nested) return nested;
      }
    }
    return null;
  }
  const binary = await findBinary(build);
  if (!binary) throw new Error('The native whisper.cpp worker was not produced.');
  const staged = path.join(temporary, 'stage');
  await mkdir(path.join(staged, 'bin'), { recursive: true });
  await cp(binary, path.join(staged, 'bin', binaryName));
  await cp(path.join(source, 'LICENSE'), path.join(staged, 'bin', 'LICENSE'));
  await writeFile(path.join(staged, '.release'), marker + '\n');
  const workerHash = createHash('sha256');
  for await (const chunk of createReadStream(binary)) workerHash.update(chunk);
  await writeFile(
    path.join(staged, 'manifest.json'),
    JSON.stringify(
      {
        schema: 1,
        target,
        upstreamCommit: COMMIT,
        sourceSha256: SOURCE_SHA256,
        workerSha256: workerHash.digest('hex'),
        cpuOnly: true,
        buildConfig: 'cpu-static-msvc-crt-no-openmp-v4',
      },
      null,
      2,
    ) + '\n',
  );
  await mkdir(path.dirname(destination), { recursive: true });
  await rm(destination, { recursive: true, force: true });
  await rename(staged, destination);
  console.log(`Staged pinned whisper.cpp worker: ${path.join(destination, 'bin', binaryName)}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
