/** Certification may run the NSIS installer only on disposable hosted Windows CI. */
export declare function assertDisposableWindowsRunner(
  platform: string,
  env: Readonly<Record<string, string | undefined>>,
): void;

export declare function selectNsisUninstaller(directory: string, names: readonly string[]): string;

export declare function uninstallNsisInstallation(
  directory: string,
  names: readonly string[],
  run: (executable: string, args: string[]) => void,
): void;
