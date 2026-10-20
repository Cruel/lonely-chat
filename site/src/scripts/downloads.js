import {
  detectPlatform,
  formatDownloadSize,
  getInstaller,
  getPrimaryDownload,
  RELEASES_URL,
} from '../lib/downloads.mjs';
import { fetchLatestRelease } from '../lib/release-cache.mjs';

const automaticButtons = [...document.querySelectorAll('[data-auto-download]')];
const platformLinks = [...document.querySelectorAll('[data-platform-download]')];
const releaseStatuses = [...document.querySelectorAll('[data-release-status]')];
const releaseLinks = [...document.querySelectorAll('[data-release-link]')];

function setText(element, value) {
  if (element && element.textContent !== value) element.textContent = value;
}

function setHref(element, url) {
  if (element.getAttribute('href') !== url) element.setAttribute('href', url);
}

function showStatus(message) {
  for (const element of releaseStatuses) setText(element, message);
}

function updatePrimaryButtons(release, platform) {
  const selected = getPrimaryDownload(release, platform);
  for (const button of automaticButtons) {
    setHref(button, selected.href);
    setText(button.querySelector('[data-download-label]'), selected.label);
    for (const icon of button.querySelectorAll('[data-download-icon]')) {
      const hidden = icon.getAttribute('data-download-icon') !== (selected.platform ?? 'generic');
      if (icon.hidden !== hidden) icon.hidden = hidden;
    }
  }
}

function updatePlatformLinks(release, failed = false) {
  for (const link of platformLinks) {
    const platform = link.getAttribute('data-platform-download');
    const installer = getInstaller(release, platform);
    const label = link.querySelector('[data-platform-label]');
    const size = link.querySelector('[data-platform-size]');

    if (installer) {
      setHref(link, installer.url);
      link.removeAttribute('target');
      link.removeAttribute('aria-disabled');
      link.classList.remove('unavailable');
      setText(label, 'Download');
      setText(size, formatDownloadSize(installer.size));
    } else if (failed) {
      setHref(link, RELEASES_URL);
      link.setAttribute('target', '_blank');
      link.removeAttribute('aria-disabled');
      link.classList.remove('unavailable');
      setText(label, 'Check GitHub ↗');
      setText(size, '');
    } else {
      link.removeAttribute('href');
      link.removeAttribute('target');
      link.setAttribute('aria-disabled', 'true');
      link.classList.add('unavailable');
      setText(label, 'Not available');
      setText(size, '');
    }
  }
}

async function identifyPlatform() {
  const hints = navigator.userAgentData;
  const userAgent = navigator.userAgent;
  const clientPlatform = hints?.platform || '';
  try {
    const saved = JSON.parse(sessionStorage.getItem('lonely-chat-platform-hint') || 'null');
    if (saved && saved.userAgent === userAgent && saved.clientPlatform === clientPlatform &&
        ['windows', 'linux', 'macos', null].includes(saved.platform)) {
      return saved.platform;
    }
  } catch {
    // Ignore unavailable or malformed tab-local platform hints.
  }
  let architecture = '';
  let bitness = '';
  if (hints?.getHighEntropyValues) {
    try {
      const values = await hints.getHighEntropyValues(['architecture', 'bitness']);
      architecture = values.architecture ?? '';
      bitness = values.bitness ?? '';
    } catch {
      // Browsers may decline high-entropy hints; let visitors choose instead.
    }
  }
  const platform = detectPlatform({ clientPlatform, userAgent, architecture, bitness });
  try {
    sessionStorage.setItem('lonely-chat-platform-hint', JSON.stringify({
      userAgent, clientPlatform, platform,
    }));
  } catch {
    // Downloads still work when browser storage is blocked.
  }
  return platform;
}

function setReleaseLink(url) {
  for (const link of releaseLinks) setHref(link, url);
}

async function loadRelease() {
  const platformPromise = identifyPlatform();
  try {
    const { status, release } = await fetchLatestRelease();
    if (status !== 'published') {
      showStatus(status === 'not-found'
        ? 'First public release coming soon.'
        : 'No published desktop release available yet.');
      updatePlatformLinks(null);
      return;
    }

    const platform = await platformPromise;
    updatePrimaryButtons(release, platform);
    updatePlatformLinks(release);
    showStatus(release.tag_name ? `Latest release: ${release.tag_name}` : 'Latest public release');

    if (typeof release.html_url === 'string' && release.html_url.startsWith(`${RELEASES_URL}/tag/`)) {
      setReleaseLink(release.html_url);
    }

    if (!['windows', 'linux', 'macos'].some((id) => getInstaller(release, id))) {
      showStatus('No desktop installers found in the latest release.');
    }
  } catch {
    showStatus('Unable to check releases right now. Check GitHub for available downloads.');
    updatePlatformLinks(null, true);
  }
}

loadRelease();
