import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, readFile, readlink, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unpackedPackage } from './package-layout.mjs';
import { verifyNativeStage } from './verify-native-stage.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { executable, resources } = unpackedPackage();
const target = `${process.platform}-${process.arch}`;
const binaries = [
  {
    directory: 'llama',
    name: process.platform === 'win32' ? 'llama-server.exe' : 'llama-server',
    marker: /^b11700:[0-9a-f]{64}:stage-v2$/,
  },
  {
    directory: 'whisper',
    name: process.platform === 'win32' ? 'lonely-whisper-worker.exe' : 'lonely-whisper-worker',
    marker: /^d1be6fde11ac6e0407606b4e42fe72d34add8037:framed-v1$/,
  },
];
for (const candidate of [executable, path.join(resources, 'app.asar')]) {
  const file = await stat(candidate);
  assert.ok(file.isFile() && file.size > 0, `Missing packaged application file: ${candidate}`);
}
for (const { directory, name, marker } of binaries) {
  const staged = path.join(resources, directory, target);
  const executablePath = path.join(staged, 'bin', name);
  assert.match((await readFile(path.join(staged, '.release'), 'utf8')).trim(), marker);
  const binary = await stat(executablePath);
  assert.ok(binary.isFile() && binary.size > 0, `Missing packaged worker: ${executablePath}`);
  const entries = await readdir(path.join(staged, 'bin'));
  for (const entry of entries) {
    const source = path.join(staged, 'bin', entry);
    const info = await lstat(source);
    if (info.isSymbolicLink()) {
      const resolved = path.resolve(path.dirname(source), await readlink(source));
      assert.equal(
        path.dirname(resolved),
        path.dirname(source),
        `Escaping packaged library link: ${entry}`,
      );
      await stat(resolved); // No dangling shared-library links.
    }
  }
}
await verifyNativeStage(resources, target, process.env.LONELY_CHAT_REQUIRE_ACCELERATORS === '1');
console.log(`PASS: ${target} packaged Electron, native workers and staged library links`);
function run(args) {
  const result = spawnSync(process.execPath, args, {
    stdio: 'inherit',
    cwd: root,
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Certification failed: node ${args.join(' ')} (exit ${result.status})`);
}
run(['scripts/smoke-llama.mjs', resources]);
run(['scripts/smoke-whisper.mjs', resources]);
run(['scripts/smoke-electron.mjs', '--packaged']);
console.log(`PASS: ${target} self-contained unpacked package certification`);
