import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { trustedDesktopURL } from './desktop-renderer-origin';

const folders: string[] = [];
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'lonely-renderer-origin-'));
  folders.push(root);
  const canonical = path.join(root, 'renderer-target');
  mkdirSync(path.join(canonical, 'resources'), { recursive: true });
  writeFileSync(path.join(canonical, 'resources', 'app.asar'), 'fake Electron archive');
  // Do not use RUNNER~1: Windows may reserve it as the 8.3 alias of runneradmin.
  const alias = path.join(root, 'renderer-link');
  symlinkSync(canonical, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const suffix = path.join('resources', 'app.asar', 'dist-electron', 'renderer', 'index.html');
  return {
    linkedFile: path.join(alias, suffix),
    targetFile: path.join(canonical, suffix),
  };
}
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

it('trusts the same packaged ASAR renderer across a junction or symlink alias', () => {
  const { linkedFile, targetFile } = fixture();
  expect(trustedDesktopURL(pathToFileURL(targetFile).href, linkedFile, undefined)).toBe(true);
  expect(trustedDesktopURL(pathToFileURL(linkedFile).href, targetFile, undefined)).toBe(true);
});

it('rejects neighboring archive entries, different origins and injected query/hash', () => {
  const { linkedFile, targetFile } = fixture();
  const actual = pathToFileURL(targetFile).href;
  expect(trustedDesktopURL(actual, linkedFile, undefined)).toBe(true);
  expect(
    trustedDesktopURL(actual.replace('/index.html', '/other.html'), linkedFile, undefined),
  ).toBe(false);
  expect(trustedDesktopURL(actual + '?redirect=1', linkedFile, undefined)).toBe(false);
  expect(trustedDesktopURL(actual + '#other', linkedFile, undefined)).toBe(false);
  expect(trustedDesktopURL('https://example.org/', linkedFile, undefined)).toBe(false);
  expect(trustedDesktopURL('file:///totally/unrelated.html', linkedFile, undefined)).toBe(false);
});

it('keeps the development URL restricted to its configured origin', () => {
  const expected = 'http://localhost:5173';
  expect(trustedDesktopURL(expected, 'index.html', expected)).toBe(true);
  expect(trustedDesktopURL(expected + '/', 'index.html', expected)).toBe(true);
  expect(trustedDesktopURL(expected + '/elsewhere', 'index.html', expected)).toBe(false);
  expect(trustedDesktopURL('https://example.org/', 'index.html', expected)).toBe(false);
});
