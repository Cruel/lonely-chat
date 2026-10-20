/*
 * Render cached release details synchronously during HTML parsing, before the
 * deferred Astro bundle runs. Kept self-contained to run as a classic inline
 * script (no module fetch or asynchronous operation).
 */
(() => {
  try {
    const cached = JSON.parse(sessionStorage.getItem('lonely-chat-latest-published-release') || 'null');
    if (!cached || typeof cached !== 'object' || cached.draft || cached.prerelease || !Array.isArray(cached.assets)) return;

    const hints = navigator.userAgentData;
    const ua = navigator.userAgent || '';
    const agent = ua.toLowerCase();
    const system = (hints?.platform || ua).toLowerCase();
    let platform = null;

    // Reuse a verified high-entropy platform result from an earlier page visit.
    // Never infer Apple Silicon just from a generic macOS user-agent string.
    try {
      const saved = JSON.parse(sessionStorage.getItem('lonely-chat-platform-hint') || 'null');
      if (saved && saved.userAgent === ua && saved.clientPlatform === (hints?.platform || '') &&
          ['windows', 'linux', 'macos', null].includes(saved.platform)) {
        platform = saved.platform;
      } else if (!/android|iphone|ipad|ipod|mobile/.test(agent) &&
          !/\b(arm|aarch64|arm64)\b/.test(agent) &&
          !/macos|macintosh|mac os|macintel|darwin/.test(system)) {
        if (/windows|win32|win64|winnt/.test(system)) platform = 'windows';
        else if (/linux|x11/.test(system)) platform = 'linux';
      }
    } catch {
      // Invalid/blocked hint storage: only detect obviously supported desktop OSes.
      if (!/android|iphone|ipad|ipod|mobile/.test(agent) &&
          !/\b(arm|aarch64|arm64)\b/.test(agent) &&
          !/macos|macintosh|mac os|macintel|darwin/.test(system)) {
        if (/windows|win32|win64|winnt/.test(system)) platform = 'windows';
        else if (/linux|x11/.test(system)) platform = 'linux';
      }
    }

    const patterns = {
      windows: /^lonely-chat-.+-windows-x64\.exe$/,
      linux: /^lonely-chat-.+-linux-x86_64\.AppImage$/,
      macos: /^lonely-chat-.+-macos-arm64\.dmg$/,
    };
    const releasesUrl = 'https://github.com/Cruel/lonely-chat/releases';
    function installerFor(os) {
      return cached.assets.find((asset) =>
        asset && typeof asset.name === 'string' && patterns[os]?.test(asset.name) &&
        typeof asset.browser_download_url === 'string' &&
        asset.browser_download_url.startsWith(releasesUrl + '/download/')
      ) || null;
    }

    const recommended = installerFor(platform);
    for (const button of document.querySelectorAll('[data-auto-download]')) {
      const label = button.querySelector('[data-download-label]');
      button.href = recommended ? recommended.browser_download_url : '/download';
      if (label) label.textContent = recommended ?
        'Download for ' + ({ windows: 'Windows', linux: 'Linux', macos: 'macOS' })[platform] : 'Download';
      for (const icon of button.querySelectorAll('[data-download-icon]')) {
        icon.hidden = icon.getAttribute('data-download-icon') !== (recommended ? platform : 'generic');
      }
    }

    for (const link of document.querySelectorAll('[data-platform-download]')) {
      const os = link.getAttribute('data-platform-download');
      const installer = installerFor(os);
      const label = link.querySelector('[data-platform-label]');
      const size = link.querySelector('[data-platform-size]');
      if (installer) {
        link.href = installer.browser_download_url;
        link.removeAttribute('target');
        link.removeAttribute('aria-disabled');
        link.classList.remove('unavailable');
        if (label) label.textContent = 'Download';
        if (size) size.textContent = Number.isFinite(installer.size) && installer.size > 0 ?
          Math.round(installer.size / 1048576) + ' MiB' : '';
      } else {
        link.removeAttribute('href');
        link.removeAttribute('target');
        link.setAttribute('aria-disabled', 'true');
        link.classList.add('unavailable');
        if (label) label.textContent = 'Not available';
        if (size) size.textContent = '';
      }
    }

    const available = Object.keys(patterns).some((os) => installerFor(os));
    const status = !available ? 'No desktop installers found in the latest release.' :
      cached.tag_name ? 'Latest release: ' + cached.tag_name : 'Latest public release';
    for (const element of document.querySelectorAll('[data-release-status]')) element.textContent = status;
    if (typeof cached.html_url === 'string' && cached.html_url.startsWith(releasesUrl + '/tag/')) {
      for (const link of document.querySelectorAll('[data-release-link]')) link.href = cached.html_url;
    }
  } catch {
    // Invalid cached state or disabled storage falls back to the normal fetch.
  } finally {
    document.documentElement.removeAttribute('data-download-booting');
  }
})();
