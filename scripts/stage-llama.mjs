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
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const TAG = 'b11700';
const TARGETS = {
  'linux-x64': [
    'llama-b11700-bin-ubuntu-x64.tar.gz',
    '51842656431fc20928123e0c88598f7604a2fe2031fb4e7d45943316817de024',
  ],
  'win32-x64': [
    'llama-b11700-bin-win-cpu-x64.zip',
    '4e2af6b2b39691cd84267a02839596ed6653ea2dde5ee9cdbfeb4dd9677eecbb',
  ],
  'darwin-arm64': [
    'llama-b11700-bin-macos-arm64.tar.gz',
    '75d795f8826e09893d44e040742ca5dd604d9402dc40393aed0aea6866aadd73',
  ],
};
const target = process.argv[2] ?? `${process.platform}-${process.arch}`;
if (!Object.hasOwn(TARGETS, target))
  throw new Error(`Unsupported pinned llama.cpp platform: ${target}`);
const [asset, sha] = TARGETS[target];
const root = path.dirname(fileURLToPath(import.meta.url));
const destination = path.join(root, '..', 'native', 'llama', target);
const marker = path.join(destination, '.release');
try {
  if ((await readFile(marker, 'utf8')).trim() === `${TAG}:${sha}:stage-v2`) {
    console.log(`Pinned llama.cpp already staged for ${target}`);
    process.exit(0);
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const temporary = await mkdtemp(path.join(tmpdir(), 'lonely-chat-llama-'));
try {
  const archive = path.join(temporary, asset);
  const url = `https://github.com/ggml-org/llama.cpp/releases/download/${TAG}/${asset}`;
  console.log(`Downloading pinned llama.cpp ${TAG} for ${target}`);
  const response = await fetch(url);
  if (!response.ok || !response.body || !response.url.startsWith('https://')) {
    throw new Error(`Unable to download llama.cpp artifact (HTTP ${response.status}).`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(archive, { mode: 0o600 }));
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  if (hash.digest('hex') !== sha) throw new Error('Pinned llama.cpp artifact SHA-256 mismatch.');
  const extracted = path.join(temporary, 'extracted');
  await mkdir(extracted);
  const tarArgs = asset.endsWith('.zip')
    ? ['-xf', archive, '-C', extracted]
    : ['-xzf', archive, '-C', extracted];
  // Trusted, SHA-pinned upstream archive; extracted only into a fresh private directory.
  execFileSync('tar', tarArgs, { stdio: 'pipe' });

  const binaryName = target.startsWith('win32') ? 'llama-server.exe' : 'llama-server';
  async function findBin(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const location = path.join(folder, entry.name);
      if (entry.isFile() && entry.name === binaryName) return folder;
      if (entry.isDirectory()) {
        const nested = await findBin(location);
        if (nested) return nested;
      }
    }
    return null;
  }
  const bin = await findBin(extracted);
  if (!bin) throw new Error(`Pinned llama.cpp artifact does not contain ${binaryName}.`);
  const staged = path.join(temporary, 'stage');
  await mkdir(staged);
  // Keep adjacent native shared libraries and their symlinks intact.
  const stagedBin = path.join(staged, 'bin');
  await cp(bin, stagedBin, { recursive: true });
  // Node cp may rewrite symlinks to absolute paths under the extraction directory.
  // Restore same-directory library link chains before deleting the extraction root.
  const contents = await readdir(stagedBin);
  for (const entry of contents) {
    const file = path.join(stagedBin, entry);
    if (!(await lstat(file)).isSymbolicLink()) continue;
    const targetName = path.basename(await readlink(file));
    if (!contents.includes(targetName))
      throw new Error(`Shared-library link escapes bin: ${entry}`);
    await rm(file);
    await symlink(targetName, file);
  }
  await writeFile(path.join(staged, '.release'), `${TAG}:${sha}:stage-v2\n`);
  await mkdir(path.dirname(destination), { recursive: true });
  await rm(destination, { recursive: true, force: true });
  await rename(staged, destination);
  console.log(`Staged ${path.join(destination, 'bin', binaryName)}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
