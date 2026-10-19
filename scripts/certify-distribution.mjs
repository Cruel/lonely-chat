import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assertDisposableWindowsRunner,
  uninstallNsisInstallation,
} from './distribution-safety.mjs';

/**
 * Certification of the *distributed* artifact, not electron-builder --dir.
 * Linux launches the AppImage; Windows installs the NSIS exe only on disposable
 * GitHub-hosted CI (NSIS can uninstall the registered app even with a new /D path),
 * then runs its real uninstaller. macOS copies the app from a mounted DMG.
 */
const platform = process.platform;
// Refuse before inspecting artifacts, allocating directories, or launching an installer.
assertDisposableWindowsRunner(platform, process.env);
const output = path.resolve('out');
const suffix = platform === 'linux' ? '.AppImage' : platform === 'win32' ? '.exe' : '.dmg';
const files = readdirSync(output).filter(
  (file) => file.startsWith('lonely-chat-') && file.endsWith(suffix),
);
if (files.length !== 1)
  throw new Error('Expected exactly one distributed ' + suffix + ' in out/; found ' + files.length);
const artifact = path.join(output, files[0]);
const temporary = mkdtempSync(path.join(tmpdir(), 'lonely-distribution-cert-'));
let mount = null;
let windowsInstall = null;
let windowsInstallerStarted = false;
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
let certificationError = null;
try {
  let executable;
  if (platform === 'linux') {
    executable = artifact;
  } else if (platform === 'win32') {
    windowsInstall = path.join(temporary, 'installed');
    // /D changes file placement, not NSIS registry/shortcuts or app identity.
    // Guard above must remain in place regardless of the destination.
    windowsInstallerStarted = true;
    run(artifact, ['/S', '/D=' + windowsInstall]);
    executable = path.join(windowsInstall, 'Lonely Chat.exe');
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
} catch (error) {
  certificationError = error;
}

let uninstallError = null;
if (windowsInstallerStarted) {
  try {
    uninstallNsisInstallation(windowsInstall, readdirSync(windowsInstall), run);
    console.info('PASS: temporary Windows NSIS installation uninstalled');
  } catch (error) {
    // Preserve the install directory and its uninstaller. Deleting it here would
    // leave NSIS registry registration and shortcuts pointing at missing files.
    uninstallError = error;
    console.error(
      'FAIL: NSIS uninstallation failed. Preserving ' +
        temporary +
        ' for recovery; registry entries/shortcuts may still exist.',
      error,
    );
  }
}
if (mount) {
  const result = spawnSync('hdiutil', ['detach', '-quiet', mount], { stdio: 'inherit' });
  if (result.status !== 0) console.error('WARNING: Failed to unmount certification DMG.');
}
// An incomplete NSIS uninstall is a failure, not permission to remove its files.
if (!uninstallError)
  rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
if (uninstallError) {
  if (certificationError)
    throw new AggregateError([certificationError, uninstallError], 'E2E and NSIS cleanup failed.');
  throw uninstallError;
}
if (certificationError) throw certificationError;
console.info('PASS: ' + platform + ' installed/distributed artifact E2E certification');
