export const GITHUB_URL = 'https://github.com/Cruel/lonely-chat';
export const RELEASES_URL = `${GITHUB_URL}/releases`;
export const LATEST_RELEASE_API = 'https://api.github.com/repos/Cruel/lonely-chat/releases/latest';

/** Only installer formats actually produced by the release workflow are offered. */
export const PLATFORMS = Object.freeze([
  { id: 'windows', name: 'Windows', detail: 'Installer · x64', buttonLabel: 'Windows' },
  { id: 'linux', name: 'Linux', detail: 'AppImage · x86_64', buttonLabel: 'Linux' },
  { id: 'macos', name: 'macOS', detail: 'Apple silicon · ARM64', buttonLabel: 'macOS' },
]);

const assetPatterns = {
  windows: /^lonely-chat-.+-windows-x64\.exe$/,
  linux: /^lonely-chat-.+-linux-x86_64\.AppImage$/,
  macos: /^lonely-chat-.+-macos-arm64\.dmg$/,
};

/**
 * Recommend an installer only if the available hints are compatible with the
 * published architecture. A generic macOS user agent cannot distinguish
 * Apple silicon from Intel Macs, so without an ARM hint those users choose
 * the explicitly labeled installer themselves.
 */
export function detectPlatform({ clientPlatform = '', userAgent = '', architecture = '', bitness = '' } = {}) {
  const agent = userAgent.toLowerCase();
  if (/android|iphone|ipad|ipod|mobile/.test(agent)) return null;

  const system = (clientPlatform || userAgent).toLowerCase();
  const arch = architecture.toLowerCase();
  if (/macos|macintosh|mac os|macintel|darwin/.test(system)) {
    return /^(arm|arm64|aarch64)$/.test(arch) ? 'macos' : null;
  }

  // Both Windows and Linux releases are x64-only.
  if (/\b(arm|aarch64|arm64)\b/.test(agent) || (arch && !/^(x86|x86_64|amd64)$/.test(arch)) || bitness === '32') {
    return null;
  }
  if (/windows|win32|win64|winnt/.test(system)) return 'windows';
  if (/linux|x11/.test(system)) return 'linux';
  return null;
}

/** Reject unexpected download URLs, even if the API supplies a matching filename. */
export function getInstaller(release, platform) {
  const pattern = assetPatterns[platform];
  if (!pattern || !release || !Array.isArray(release.assets) || release.draft || release.prerelease) {
    return null;
  }

  const asset = release.assets.find((candidate) =>
    candidate &&
    typeof candidate.name === 'string' &&
    pattern.test(candidate.name) &&
    typeof candidate.browser_download_url === 'string' &&
    candidate.browser_download_url.startsWith(`${RELEASES_URL}/download/`)
  );
  return asset ? { name: asset.name, url: asset.browser_download_url } : null;
}
