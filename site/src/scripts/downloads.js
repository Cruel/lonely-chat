import { detectPlatform, getInstaller, LATEST_RELEASE_API, PLATFORMS, RELEASES_URL } from '../lib/downloads.mjs';

const releaseStatus = document.querySelector('#release-status');
const primaryLink = document.querySelector('#primary-download');
const platformElements = [...document.querySelectorAll('[data-platform]')];

function setPlatformLinks(release) {
  for (const element of platformElements) {
    const platform = element.getAttribute('data-platform');
    const installer = getInstaller(release, platform);
    const action = element.querySelector('[data-platform-action]');

    if (installer) {
      element.setAttribute('href', installer.url);
      element.removeAttribute('aria-disabled');
      element.classList.remove('unavailable');
      if (action) action.textContent = 'Download ↗';
    } else {
      element.removeAttribute('href');
      element.setAttribute('aria-disabled', 'true');
      element.classList.add('unavailable');
      if (action) action.textContent = 'Not available';
    }
  }
}

function showNoRelease() {
  releaseStatus.textContent = 'First public release coming soon.';
  primaryLink.textContent = 'Browse on GitHub ↗';
  primaryLink.setAttribute('href', RELEASES_URL);
  setPlatformLinks(null);
}

function showLookupError() {
  releaseStatus.textContent = 'Could not check the latest release. Visit GitHub to see downloads.';
  primaryLink.textContent = 'Browse releases ↗';
  primaryLink.setAttribute('href', RELEASES_URL);
  // A temporary API failure must not be mistaken for a missing installer.
  for (const element of platformElements) {
    element.setAttribute('href', RELEASES_URL);
    const action = element.querySelector('[data-platform-action]');
    if (action) action.textContent = 'Check GitHub ↗';
  }
}

async function loadRelease() {
  try {
    const response = await fetch(LATEST_RELEASE_API, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (response.status === 404) {
      showNoRelease();
      return;
    }
    if (!response.ok) throw new Error('Release lookup failed');

    const release = await response.json();
    if (!release || release.draft || release.prerelease || !Array.isArray(release.assets)) {
      showNoRelease();
      return;
    }

    const clientHints = navigator.userAgentData;
    let architecture = '';
    let bitness = '';
    if (clientHints?.getHighEntropyValues) {
      try {
        const values = await clientHints.getHighEntropyValues(['architecture', 'bitness']);
        architecture = values.architecture ?? '';
        bitness = values.bitness ?? '';
      } catch {
        // Platform hints are optional; manual downloads remain available.
      }
    }
    const platform = detectPlatform({
      clientPlatform: clientHints?.platform,
      userAgent: navigator.userAgent,
      architecture,
      bitness,
    });
    const recommended = platform && getInstaller(release, platform);

    setPlatformLinks(release);
    releaseStatus.textContent = release.tag_name
      ? `Latest published release: ${release.tag_name}`
      : 'Latest public release available';

    if (recommended) {
      const name = PLATFORMS.find((item) => item.id === platform)?.buttonLabel ?? 'desktop';
      primaryLink.textContent = `Download for ${name} ↗`;
      primaryLink.setAttribute('href', recommended.url);
      const selected = platformElements.find((element) => element.getAttribute('data-platform') === platform);
      selected?.classList.add('recommended');
    } else {
      primaryLink.textContent = 'Browse downloads ↗';
      primaryLink.setAttribute('href', RELEASES_URL);
      // Platforms not supported by the release still have the GitHub fallback.
      if (!PLATFORMS.some((item) => getInstaller(release, item.id))) {
        releaseStatus.textContent = 'No desktop installers found in the latest release.';
        primaryLink.textContent = 'Browse releases ↗';
        primaryLink.setAttribute('href', RELEASES_URL);
      }
    }
  } catch {
    showLookupError();
  }
}

loadRelease();
