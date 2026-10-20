import assert from 'node:assert/strict';
import test from 'node:test';
import { detectPlatform, formatDownloadSize, getInstaller, getPrimaryDownload, PLATFORMS, RELEASES_URL } from '../src/lib/downloads.mjs';

const version = '0.1.0';
const names = {
  windows: `lonely-chat-${version}-windows-x64.exe`,
  linux: `lonely-chat-${version}-linux-x86_64.AppImage`,
  macos: `lonely-chat-${version}-macos-arm64.dmg`,
};
const published = {
  draft: false,
  prerelease: false,
  assets: Object.values(names).map((name) => ({
    name,
    browser_download_url: `${RELEASES_URL}/download/v${version}/${name}`,
  })),
};

test('selects the released installer for every supported platform', () => {
  for (const platform of PLATFORMS) {
    const asset = getInstaller(published, platform.id);
    assert.equal(asset?.name, names[platform.id]);
    assert.match(asset?.url ?? '', /^https:\/\/github\.com\/Cruel\/lonely-chat\/releases\/download\//);
  }
});

test('the homepage button directly downloads the matching published asset', () => {
  for (const platform of PLATFORMS) {
    const primary = getPrimaryDownload(published, platform.id);
    assert.equal(primary.href, getInstaller(published, platform.id)?.url);
    assert.equal(primary.label, `Download for ${platform.name}`);
    assert.equal(primary.platform, platform.id);
  }
});

test('the homepage button routes unknown or unavailable platforms to /download', () => {
  for (const candidate of [null, 'android', 'mac-intel']) {
    assert.deepEqual(getPrimaryDownload(published, candidate), {
      href: '/download', label: 'Download', platform: null,
    });
  }
  assert.equal(getPrimaryDownload({ ...published, assets: [] }, 'windows').href, '/download');
  assert.equal(getPrimaryDownload(null, 'windows').href, '/download');
});

test('format release sizes only when GitHub provides a positive byte count', () => {
  assert.equal(formatDownloadSize(1048576), '1 MiB');
  assert.equal(formatDownloadSize(135 * 1048576), '135 MiB');
  assert.equal(formatDownloadSize(undefined), '');
  assert.equal(formatDownloadSize(-4), '');
});

test('never guesses download URLs for missing or unsupported releases', () => {
  assert.equal(getInstaller({ ...published, assets: [] }, 'windows'), null);
  assert.equal(getInstaller(null, 'linux'), null);
  assert.equal(getInstaller(published, 'android'), null);
  assert.equal(getInstaller({ ...published, draft: true }, 'windows'), null);
  assert.equal(getInstaller({ ...published, prerelease: true }, 'windows'), null);
});

test('ignores mismatched architectures, formats and foreign links', () => {
  const invalid = [
    { name: 'lonely-chat-0.1.0-windows-arm64.exe', browser_download_url: 'https://github.com/Cruel/lonely-chat/releases/download/v0.1.0/arm64.exe' },
    { name: 'lonely-chat-0.1.0-macos-x64.dmg', browser_download_url: 'https://github.com/Cruel/lonely-chat/releases/download/v0.1.0/mac.dmg' },
    { name: names.windows, browser_download_url: 'https://downloads.example.com/malicious.exe' },
  ];
  assert.equal(getInstaller({ ...published, assets: invalid }, 'windows'), null);
  assert.equal(getInstaller({ ...published, assets: invalid }, 'macos'), null);
});

test('recognizes desktop systems without treating mobile browsers as desktop', () => {
  assert.equal(detectPlatform({ clientPlatform: 'Windows', userAgent: 'Mozilla/5.0' }), 'windows');
  assert.equal(detectPlatform({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)'}), 'linux');
  assert.equal(detectPlatform({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0)' }), null);
  assert.equal(detectPlatform({ clientPlatform: 'macOS', architecture: 'arm' }), 'macos');
  assert.equal(detectPlatform({ clientPlatform: 'macOS', architecture: 'x86' }), null);
  assert.equal(detectPlatform({ userAgent: 'Darwin 23.0' }), null);
  assert.equal(detectPlatform({ clientPlatform: 'Linux', architecture: 'arm' }), null);
  assert.equal(detectPlatform({ clientPlatform: 'Windows', bitness: '32' }), null);
  assert.equal(detectPlatform({ clientPlatform: 'Linux', userAgent: 'Mozilla/5.0 (Linux; Android 16; Pixel)' }), null);
  assert.equal(detectPlatform({ clientPlatform: 'macOS', userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0)' }), null);
  assert.equal(detectPlatform({ userAgent: '' }), null);
});
