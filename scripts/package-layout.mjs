import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Paths produced by electron-builder --dir on the current CI target. */
export function unpackedPackage() {
  const out = path.join(root, 'out');
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    const app = path.join(out, 'mac-arm64', 'Lonely Chat.app', 'Contents');
    return {
      executable: path.join(app, 'MacOS', 'Lonely Chat'),
      resources: path.join(app, 'Resources'),
    };
  }
  if (process.platform === 'win32' && process.arch === 'x64') {
    const folder = path.join(out, 'win-unpacked');
    return {
      executable: path.join(folder, 'Lonely Chat.exe'),
      resources: path.join(folder, 'resources'),
    };
  }
  if (process.platform === 'linux' && process.arch === 'x64') {
    const folder = path.join(out, 'linux-unpacked');
    return {
      executable: path.join(folder, 'lonely-chat'),
      resources: path.join(folder, 'resources'),
    };
  }
  throw new Error(`Unsupported certification platform: ${process.platform}-${process.arch}`);
}
