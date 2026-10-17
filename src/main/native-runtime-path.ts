import path from 'node:path';

/** Executables live outside asar and bring their own adjacent shared libraries. */
export function bundledWhisperWorker(
  appPath: string,
  packaged: boolean,
  resourcesPath: string,
  platform = process.platform,
  arch = process.arch,
): string {
  const root = packaged
    ? path.join(resourcesPath, 'whisper')
    : path.join(appPath, 'native', 'whisper');
  return path.join(
    root,
    `${platform}-${arch}`,
    'bin',
    platform === 'win32' ? 'lonely-whisper-worker.exe' : 'lonely-whisper-worker',
  );
}

export function bundledLlamaServer(
  appPath: string,
  packaged: boolean,
  resourcesPath: string,
  platform = process.platform,
  arch = process.arch,
): string {
  const root = packaged ? path.join(resourcesPath, 'llama') : path.join(appPath, 'native', 'llama');
  return path.join(
    root,
    `${platform}-${arch}`,
    'bin',
    platform === 'win32' ? 'llama-server.exe' : 'llama-server',
  );
}
