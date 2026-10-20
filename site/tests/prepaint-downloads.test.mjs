import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const script = readFileSync(new URL('../src/scripts/prepaint-downloads.js', import.meta.url), 'utf8');
const release = {
  tag_name: 'v0.1.0',
  draft: false,
  prerelease: false,
  html_url: 'https://github.com/Cruel/lonely-chat/releases/tag/v0.1.0',
  assets: [
    {
      name: 'lonely-chat-0.1.0-windows-x64.exe',
      browser_download_url: 'https://github.com/Cruel/lonely-chat/releases/download/v0.1.0/lonely-chat-0.1.0-windows-x64.exe',
      size: 1048576,
    },
    {
      name: 'lonely-chat-0.1.0-macos-arm64.dmg',
      browser_download_url: 'https://github.com/Cruel/lonely-chat/releases/download/v0.1.0/lonely-chat-0.1.0-macos-arm64.dmg',
      size: 2 * 1048576,
    },
  ],
};

function element(attributes = {}, textContent = '') {
  const attrs = new Map(Object.entries(attributes));
  const children = new Map();
  const classes = new Set();
  return {
    textContent,
    hidden: attrs.has('hidden'),
    getAttribute: (name) => attrs.get(name) ?? null,
    setAttribute: (name, value) => attrs.set(name, value),
    removeAttribute: (name) => attrs.delete(name),
    get href() { return attrs.get('href'); },
    set href(value) { attrs.set('href', value); },
    get classList() {
      return { add: (name) => classes.add(name), remove: (name) => classes.delete(name), contains: (name) => classes.has(name) };
    },
    querySelector: (selector) => children.get(selector),
    querySelectorAll: (selector) => children.get(selector) ?? [],
    child: (selector, value) => { children.set(selector, value); return value; },
  };
}

function boot({ cached = release, agent, clientPlatform = '', savedHint = null, blocked = false } = {}) {
  const ua = agent ?? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
  const button = element({ href: '/download' });
  const label = button.child('[data-download-label]', element({}, 'Download'));
  const generic = element({ 'data-download-icon': 'generic' });
  const windows = element({ 'data-download-icon': 'windows', hidden: '' });
  const macos = element({ 'data-download-icon': 'macos', hidden: '' });
  button.child('[data-download-icon]', [generic, windows, macos]);
  const platform = element({ 'data-platform-download': 'windows', href: 'https://github.com/Cruel/lonely-chat/releases' });
  const action = platform.child('[data-platform-label]', element({}, 'Check releases ↗'));
  const size = platform.child('[data-platform-size]', element());
  const status = element({}, 'Checking published releases…');
  const releaseLink = element({ href: 'https://github.com/Cruel/lonely-chat/releases' });
  let unhidden = false;
  const document = {
    documentElement: { removeAttribute(name) { if (name === 'data-download-booting') unhidden = true; } },
    querySelectorAll(selector) {
      return ({
        '[data-auto-download]': [button],
        '[data-platform-download]': [platform],
        '[data-release-status]': [status],
        '[data-release-link]': [releaseLink],
      })[selector] ?? [];
    },
  };
  const storage = {
    getItem(key) {
      if (blocked) throw new Error('Storage unavailable');
      if (key === 'lonely-chat-latest-published-release') return cached && JSON.stringify(cached);
      if (key === 'lonely-chat-platform-hint') return savedHint && JSON.stringify(savedHint);
      return null;
    },
  };
  const navigator = { userAgent: ua, userAgentData: clientPlatform ? { platform: clientPlatform } : undefined };
  runInNewContext(script, { document, navigator, sessionStorage: storage });
  return { button, label, generic, windows, macos, platform, action, size, status, releaseLink, unhidden };
}

test('prepaint restores a Windows installer and release metadata synchronously', () => {
  const state = boot();
  assert.equal(state.unhidden, true);
  assert.equal(state.label.textContent, 'Download for Windows');
  assert.equal(state.button.href, release.assets[0].browser_download_url);
  assert.equal(state.windows.hidden, false);
  assert.equal(state.generic.hidden, true);
  assert.equal(state.platform.href, release.assets[0].browser_download_url);
  assert.equal(state.action.textContent, 'Download');
  assert.equal(state.size.textContent, '1 MiB');
  assert.equal(state.status.textContent, 'Latest release: v0.1.0');
  assert.equal(state.releaseLink.href, release.html_url);
});

test('unverified macOS architecture remains generic, never guessing ARM64', () => {
  const state = boot({ agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0)', clientPlatform: 'macOS' });
  assert.equal(state.unhidden, true);
  assert.equal(state.label.textContent, 'Download');
  assert.equal(state.button.href, '/download');
  assert.equal(state.macos.hidden, true);
});

test('previously verified Apple Silicon platform is reused before paint', () => {
  const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0)';
  const state = boot({
    agent: ua,
    clientPlatform: 'macOS',
    savedHint: { userAgent: ua, clientPlatform: 'macOS', platform: 'macos' },
  });
  assert.equal(state.label.textContent, 'Download for macOS');
  assert.equal(state.button.href, release.assets[1].browser_download_url);
  assert.equal(state.macos.hidden, false);
});

test('cache absence, invalid releases and blocked storage always reveal fallback UI', () => {
  for (const options of [
    { cached: null },
    { cached: { ...release, draft: true } },
    { cached: { ...release, prerelease: true } },
    { blocked: true },
  ]) {
    const state = boot(options);
    assert.equal(state.unhidden, true);
    assert.equal(state.label.textContent, 'Download');
    assert.equal(state.button.href, '/download');
  }
});
