import { describe, expect, it, vi } from 'vitest';
import {
  assertDisposableWindowsRunner,
  selectNsisUninstaller,
  uninstallNsisInstallation,
} from '../../scripts/distribution-safety.mjs';

const hosted = {
  CI: 'true',
  GITHUB_ACTIONS: 'true',
  RUNNER_OS: 'Windows',
  RUNNER_ENVIRONMENT: 'github-hosted',
};

describe('distributed Windows installer safety', () => {
  it('refuses developer Windows, self-hosted CI, and incomplete CI markers', () => {
    const unsafe = [
      {},
      { CI: 'true' },
      { ...hosted, GITHUB_ACTIONS: undefined },
      { ...hosted, RUNNER_OS: 'Linux' },
      { ...hosted, RUNNER_ENVIRONMENT: 'self-hosted' },
      { ...hosted, CI: 'false' },
    ];
    for (const env of unsafe)
      expect(() => assertDisposableWindowsRunner('win32', env)).toThrow(
        /can replace an existing Lonely Chat installation/,
      );
  });

  it('allows disposable GitHub-hosted Windows only; other platforms need no installer', () => {
    expect(() => assertDisposableWindowsRunner('win32', hosted)).not.toThrow();
    expect(() => assertDisposableWindowsRunner('linux', {})).not.toThrow();
    expect(() => assertDisposableWindowsRunner('darwin', {})).not.toThrow();
  });

  it('identifies the installed NSIS uninstaller without guessing a path', () => {
    expect(
      selectNsisUninstaller('C:/isolated', ['Lonely Chat.exe', 'Uninstall Lonely Chat.exe']),
    ).toBe('Uninstall Lonely Chat.exe');
    expect(() => selectNsisUninstaller('C:/isolated', ['Lonely Chat.exe'])).toThrow(
      /cannot safely clean up/,
    );
    expect(() =>
      selectNsisUninstaller('C:/isolated', ['Uninstall Lonely Chat.exe', 'Uninstall Other.exe']),
    ).toThrow(/cannot safely clean up/);
  });

  it('executes the uninstaller in silent synchronous mode and propagates failure', () => {
    const invoke = vi.fn();
    uninstallNsisInstallation('C:/isolated', ['Uninstall Lonely Chat.exe'], invoke);
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0][0]).toMatch(/Uninstall Lonely Chat\.exe$/);
    expect(invoke.mock.calls[0][1]).toEqual(['/S', '_?=C:/isolated']);
    expect(() => uninstallNsisInstallation('C:/isolated', ['Lonely Chat.exe'], invoke)).toThrow(
      /cannot safely clean up/,
    );
    expect(invoke).toHaveBeenCalledOnce();
    const fail = vi.fn(() => {
      throw new Error('uninstaller failed');
    });
    expect(() =>
      uninstallNsisInstallation('C:/isolated', ['Uninstall Lonely Chat.exe'], fail),
    ).toThrow('uninstaller failed');
  });
});
