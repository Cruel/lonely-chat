import path from 'node:path';

/**
 * Installing the electron-builder NSIS artifact can remove an existing Lonely Chat
 * installation even if /D points to a different directory. Never run this on a
 * developer or self-hosted machine; the ephemeral GitHub-hosted Windows runner
 * has no user installation or persistent registry/shortcuts to replace.
 */
export function assertDisposableWindowsRunner(platform, env) {
  if (platform !== 'win32') return;
  if (
    env.CI !== 'true' ||
    env.GITHUB_ACTIONS !== 'true' ||
    env.RUNNER_OS !== 'Windows' ||
    env.RUNNER_ENVIRONMENT !== 'github-hosted'
  ) {
    throw new Error(
      'NSIS installer certification can replace an existing Lonely Chat installation, registry ' +
        'entries, and shortcuts. Run only on disposable GitHub-hosted Windows CI runners; ' +
        'developer machines and self-hosted runners are refused.',
    );
  }
}

/** Accept precisely one installer-owned uninstaller in the temporary install root. */
export function selectNsisUninstaller(directory, names) {
  const matches = names.filter((name) => /^uninstall[^/\\]*\.exe$/i.test(name));
  if (matches.length !== 1) {
    throw new Error(
      'Expected one NSIS uninstaller in ' +
        directory +
        '; cannot safely clean up the temporary installation.',
    );
  }
  return matches[0];
}

/** Fail hard if uninstall cannot execute; caller must not delete the installation. */
export function uninstallNsisInstallation(directory, names, run) {
  const executable = path.join(directory, selectNsisUninstaller(directory, names));
  // NSIS _?=<path> must be the last, unquoted argument. It forces the
  // uninstaller to run synchronously without delegating to a temp copy.
  run(executable, ['/S', '_?=' + directory]);
}
