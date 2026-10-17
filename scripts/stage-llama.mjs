import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  cp,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { LLAMA_ASSETS, LLAMA_RELEASE } from './native-release.mjs';

const target = process.argv[2] ?? `${process.platform}-${process.arch}`;
if (!Object.hasOwn(LLAMA_ASSETS, target))
  throw new Error(`Unsupported llama.cpp target: ${target}`);
// Upstream llama.cpp artifacts can be downloaded and SHA-verified on any host;
// whisper.cpp is compiled separately on the actual target OS.
const gpu = process.argv.includes('--accelerators') || process.argv.includes('--vulkan');
const includeCuda = process.argv.includes('--accelerators');
const variants =
  gpu && target !== 'darwin-arm64'
    ? includeCuda
      ? ['cpu', 'vulkan', 'cuda']
      : ['cpu', 'vulkan']
    : ['cpu'];
const assets = LLAMA_ASSETS[target];
const script = path.dirname(fileURLToPath(import.meta.url));
const destination = path.resolve(script, '..', 'native', 'llama', target);
const marker = `${LLAMA_RELEASE}:${assets.cpu[1]}:stage-v2`;
const manifest = {
  schema: 1,
  target,
  release: LLAMA_RELEASE,
  variants: Object.fromEntries(
    variants.map((name) => [
      name,
      {
        artifact: assets[name][0],
        sha256: assets[name][1],
        ...(name === 'cuda'
          ? {
              cudart: {
                artifact: assets.cudart[0],
                sha256: assets.cudart[1],
              },
            }
          : {}),
      },
    ]),
  ),
};
try {
  const saved = JSON.parse(await readFile(path.join(destination, 'manifest.json'), 'utf8'));
  if (
    (await readFile(path.join(destination, '.release'), 'utf8')).trim() === marker &&
    JSON.stringify(saved) === JSON.stringify(manifest)
  ) {
    console.log(`Pinned llama.cpp already staged for ${target}: ${variants.join(', ')}`);
    process.exit(0);
  }
} catch (error) {
  if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
}
// The staging directory must share a volume with its final destination:
// Windows CI may put the OS temp directory on C: but check out sources on D:.
await mkdir(path.dirname(destination), { recursive: true });
const temporary = await mkdtemp(path.join(path.dirname(destination), '.lonely-chat-llama-'));
const staged = path.join(temporary, 'stage');
await mkdir(staged);

async function download(asset, sha) {
  const archive = path.join(temporary, asset);
  const url = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_RELEASE}/${asset}`;
  console.log(`Downloading pinned ${asset}`);
  const response = await fetch(url);
  if (!response.ok || !response.body || !response.url.startsWith('https://')) {
    throw new Error(`Cannot download ${asset} (HTTP ${response.status}).`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(archive, { mode: 0o600 }));
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  if (hash.digest('hex') !== sha) throw new Error(`SHA-256 mismatch: ${asset}`);
  const extracted = path.join(temporary, `extract-${asset.replace(/[^a-z0-9]/gi, '-')}`);
  await mkdir(extracted);
  if (asset.endsWith('.zip') && process.platform !== 'win32') {
    execFileSync('unzip', ['-q', archive, '-d', extracted], { stdio: 'pipe' });
  } else {
    // Windows ships BSD tar with ZIP support, and all target hosts support tar.gz.
    execFileSync('tar', [asset.endsWith('.zip') ? '-xf' : '-xzf', archive, '-C', extracted], {
      stdio: 'pipe',
    });
  }
  return extracted;
}
async function findBinary(folder, name) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const file = path.join(folder, entry.name);
    if (entry.isFile() && entry.name === name) return folder;
    if (entry.isDirectory()) {
      const found = await findBinary(file, name);
      if (found) return found;
    }
  }
  return null;
}
async function normalizeLinks(folder) {
  const names = await readdir(folder);
  for (const name of names) {
    const file = path.join(folder, name);
    if (!(await lstat(file)).isSymbolicLink()) continue;
    const next = path.basename(await readlink(file));
    if (!names.includes(next)) throw new Error(`Dangling or escaping library symlink: ${file}`);
    await rm(file);
    await symlink(next, file);
  }
}
async function mergeCudaRuntime(extracted, binaryDirectory) {
  // CUDA redistributables contain their shared-library closure in nested release folders.
  // Flatten only library files, not unrelated executables, docs or developer headers.
  const libraries = new Map();
  async function visit(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() || entry.isSymbolicLink()) {
        if (/\.dll$|\.dylib$|\.so(?:\.[\d.]+)?$/i.test(entry.name)) {
          if (libraries.has(entry.name))
            throw new Error(`Ambiguous CUDA shared library: ${entry.name}`);
          libraries.set(entry.name, file);
        }
      }
    }
  }
  await visit(extracted);
  if (libraries.size === 0) throw new Error('Pinned CUDA runtime contains no shared libraries.');
  // Real files first, followed by symlinks recreated within the bundled bin directory.
  for (const [name, source] of libraries) {
    if (!(await lstat(source)).isSymbolicLink())
      await cp(source, path.join(binaryDirectory, name), { force: false, errorOnExist: true });
  }
  for (const [name, source] of libraries) {
    if (!(await lstat(source)).isSymbolicLink()) continue;
    const link = path.basename(await readlink(source));
    if (!libraries.has(link) && !(await readdir(binaryDirectory)).includes(link)) {
      throw new Error(`CUDA symlink target missing: ${name} -> ${link}`);
    }
    await symlink(link, path.join(binaryDirectory, name));
  }
}
try {
  for (const variant of variants) {
    const [asset, sha] = assets[variant];
    const extracted = await download(asset, sha);
    const name = target.startsWith('win32') ? 'llama-server.exe' : 'llama-server';
    const sourceBin = await findBinary(extracted, name);
    if (!sourceBin) throw new Error(`${asset} is missing ${name}`);
    const destBin = path.join(staged, ...(variant === 'cpu' ? [] : [variant]), 'bin');
    await mkdir(path.dirname(destBin), { recursive: true });
    await cp(sourceBin, destBin, { recursive: true, dereference: false });
    await normalizeLinks(destBin);
    if (variant === 'cuda') {
      const [runtime, hash] = assets.cudart;
      await mergeCudaRuntime(await download(runtime, hash), destBin);
    }
  }
  await writeFile(path.join(staged, '.release'), marker + '\n');
  await writeFile(path.join(staged, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await mkdir(path.dirname(destination), { recursive: true });
  await rm(destination, { recursive: true, force: true });
  await rename(staged, destination);
  console.log(`Staged ${target} llama.cpp variants: ${variants.join(', ')}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
