import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = (await readFile(path.join(root, 'VERSION'), 'utf8')).trim();
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const nodeVersion = (await readFile(path.join(root, '.node-version'), 'utf8')).trim();

assert.match(version, /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/);
assert.equal(pkg.version, version, 'package.json version must equal authoritative VERSION');
assert.equal(pkg.packageManager, 'pnpm@11.15.0', 'pnpm lockfile toolchain pin changed');
assert.equal(nodeVersion, '24.18.0', 'Node toolchain pin changed');
const tag = process.argv[2];
if (tag !== undefined) {
  assert.equal(tag, `v${version}`, 'Release tag must exactly match VERSION');
}
console.log(`PASS: VERSION=${version}, Node=${nodeVersion}, ${pkg.packageManager}`);
