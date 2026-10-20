import { LATEST_RELEASE_API } from './downloads.mjs';

const CACHE_KEY = 'lonely-chat-latest-published-release';

function sessionStorageOrNull() {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    // Storage can be blocked by browser privacy settings.
    return null;
  }
}

function isPublishedRelease(release) {
  return release &&
    typeof release === 'object' &&
    !release.draft &&
    !release.prerelease &&
    Array.isArray(release.assets);
}

/**
 * Cache only successful published releases for the lifetime of the tab.
 * Homepage and /download share the same entry, with no time-based expiry.
 */
export async function fetchLatestRelease({
  fetchImpl = fetch,
  storage = sessionStorageOrNull(),
} = {}) {
  try {
    const cached = storage?.getItem(CACHE_KEY);
    if (cached) {
      const release = JSON.parse(cached);
      if (isPublishedRelease(release)) {
        return { status: 'published', release };
      }
      storage.removeItem(CACHE_KEY);
    }
  } catch {
    // Malformed data or unavailable storage should never block downloads.
  }

  const response = await fetchImpl(LATEST_RELEASE_API, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (response.status === 404) {
    return { status: 'not-found', release: null };
  }
  if (!response.ok) throw new Error('Could not fetch the latest release');

  const release = await response.json();
  if (!isPublishedRelease(release)) {
    return { status: 'unavailable', release: null };
  }

  try {
    storage?.setItem(CACHE_KEY, JSON.stringify(release));
  } catch {
    // Browsers without writable session storage still get live downloads.
  }

  return { status: 'published', release };
}
