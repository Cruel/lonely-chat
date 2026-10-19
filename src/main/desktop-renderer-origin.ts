import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Packaged Electron may expand Windows 8.3 aliases (RUNNER~1), or resolve a
 * junction/symlink, when loading file:// URLs. The main process may still use
 * the original installation pathname. Compare canonical file identities,
 * never an arbitrary file:// origin or a suffix alone.
 *
 * ASAR entries are virtual files, so canonicalize the real archive file on
 * disk and retain the exact relative path inside it.
 */
function canonicalFilePath(file: string): string | null {
  try {
    const normalized = path.resolve(file);
    const archive = /\.asar(?=[\\/])/i.exec(normalized);
    let resolved: string;
    if (archive) {
      const end = archive.index + '.asar'.length;
      resolved = path.join(
        realpathSync.native(normalized.slice(0, end)),
        normalized.slice(end + 1),
      );
    } else {
      resolved = realpathSync.native(normalized);
    }
    return resolved;
  } catch {
    return null;
  }
}

function canonicalFileURL(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'file:' || url.search || url.hash) return null;
    return canonicalFilePath(fileURLToPath(url));
  } catch {
    return null;
  }
}

/** URL authorization in addition to webContents/mainFrame identity checks. */
export function trustedDesktopURL(
  frameURL: string,
  rendererFile: string,
  devOrigin: string | undefined,
): boolean {
  if (devOrigin) return frameURL === devOrigin || frameURL === `${devOrigin}/`;
  const expected = canonicalFilePath(rendererFile);
  return expected !== null && canonicalFileURL(frameURL) === expected;
}
