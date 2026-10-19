import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Certification of the *distributed* artifact, not electron-builder --dir.
 * Linux launches the AppImage; Windows installs the NSIS exe into an isolated folder;
 * macOS mounts the DMG and copies its app bundle into an isolated install directory.
 */
const output = path.resolve('out');
const platform = process.platform;
const suffix = platform === 'linux' ? '.AppImage' : platform === 'win32' ? '.exe' : '.dmg';
const files = readdirSync(output).filter(
  (file) => file.startsWith('lonely-chat-') && file.endsWith(suffix),
);
if (files.length !== 1)
  throw new Error('Expected exactly one distributed ' + suffix + ' in out/; found ' + files.length);
const artifact = path.join(output, files[0]);
const temporary = mkdtempSync(path.join(tmpdir(), 'lonely-distribution-cert-'));
let mount = null;
function run(program, args, env = process.env) {
  const result = spawnSync(program, args, {
    stdio: 'inherit',
    env,
    timeout: 180_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(program + ' exited with ' + result.status);
}
try {
  let executable;
  if (platform === 'linux') {
    executable = artifact;
  } else if (platform === 'win32') {
    const installed = path.join(temporary, 'installed');
    // NSIS requires /D=<install folder> to be the final, unquoted argument.
    run(artifact, ['/S', '/D=' + installed]);
    executable = path.join(installed, 'Lonely Chat.exe');
  } else if (platform === 'darwin') {
    mount = path.join(temporary, 'mounted-dmg');
    mkdirSync(mount);
    run('hdiutil', ['attach', '-quiet', '-nobrowse', '-readonly', '-mountpoint', mount, artifact]);
    const imageApp = path.join(mount, 'Lonely Chat.app');
    const installedApp = path.join(temporary, 'Applications', 'Lonely Chat.app');
    mkdirSync(path.dirname(installedApp), { recursive: true });
    cpSync(imageApp, installedApp, { recursive: true, verbatimSymlinks: true });
    executable = path.join(installedApp, 'Contents', 'MacOS', 'Lonely Chat');
  } else {
    throw new Error('Unsupported distributed certification platform: ' + platform);
  }
  if (!existsSync(executable))
    throw new Error('Distributed application is not installed or executable: ' + executable);
  console.info('CERTIFY: distributed ' + suffix + ' via ' + executable);
  run(process.execPath, [path.resolve('scripts/certify-e2e.mjs'), executable]);
  console.info('PASS: ' + platform + ' installed/distributed artifact E2E certification');
} finally {
  if (mount) {
    const result = spawnSync('hdiutil', ['detach', '-quiet', mount], { stdio: 'inherit' });
    if (result.status !== 0) console.error('WARNING: Failed to unmount certification DMG.');
  }
  rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
