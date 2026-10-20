import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchLatestRelease } from '../src/lib/release-cache.mjs';
import { LATEST_RELEASE_API, RELEASES_URL } from '../src/lib/downloads.mjs';

const published = {
  tag_name: 'v0.1.0',
  html_url: `${RELEASES_URL}/tag/v0.1.0`,
  draft: false,
  prerelease: false,
  assets: [{
    name: 'lonely-chat-0.1.0-windows-x64.exe',
    browser_download_url: `${RELEASES_URL}/download/v0.1.0/lonely-chat-0.1.0-windows-x64.exe`,
  }],
};

function memoryStorage() {
  const entries = new Map();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
    removeItem: (key) => entries.delete(key),
    entries,
  };
}

function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

test('shares the latest published release across navigations and reloads in a tab', async () => {
  const storage = memoryStorage();
  let requests = 0;
  const fetchImpl = async (url, options) => {
    requests += 1;
    assert.equal(url, LATEST_RELEASE_API);
    assert.equal(options.headers.Accept, 'application/vnd.github+json');
    return response(published);
  };
  const first = await fetchLatestRelease({ fetchImpl, storage });
  assert.deepEqual(first, { status: 'published', release: published });
  assert.equal(storage.entries.size, 1);

  const second = await fetchLatestRelease({
    fetchImpl: () => { throw new Error('a cached visit must not reach GitHub'); },
    storage,
  });
  assert.deepEqual(second, first);
  assert.equal(requests, 1);

  // Different browser tabs have separate sessionStorage areas.
  await fetchLatestRelease({ fetchImpl, storage: memoryStorage() });
  assert.equal(requests, 2);
});

test('404 and invalid release responses are not cached', async () => {
  const storage = memoryStorage();
  assert.deepEqual(
    await fetchLatestRelease({ fetchImpl: async () => response(null, 404), storage }),
    { status: 'not-found', release: null },
  );
  assert.deepEqual(
    await fetchLatestRelease({ fetchImpl: async () => response({ draft: true, assets: [] }), storage }),
    { status: 'unavailable', release: null },
  );
  assert.equal(storage.entries.size, 0);
});

test('malformed or invalid cached data triggers a fresh lookup', async () => {
  for (const cached of ['{broken json', JSON.stringify({ prerelease: true, assets: [] })]) {
    const storage = memoryStorage();
    storage.setItem('lonely-chat-latest-published-release', cached);
    const fresh = await fetchLatestRelease({
      fetchImpl: async () => response(published),
      storage,
    });
    assert.equal(fresh.status, 'published');
    assert.deepEqual(JSON.parse([...storage.entries.values()][0]), published);
  }
});

test('blocked session storage does not prevent fetching the release', async () => {
  const blockedStorage = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
  };
  assert.deepEqual(await fetchLatestRelease({
    fetchImpl: async () => response(published),
    storage: blockedStorage,
  }), { status: 'published', release: published });
});

test('API failures are not cached as releases', async () => {
  const storage = memoryStorage();
  await assert.rejects(fetchLatestRelease({
    fetchImpl: async () => response(null, 503),
    storage,
  }), /Could not fetch/);
  assert.equal(storage.entries.size, 0);
  assert.deepEqual(await fetchLatestRelease({
    fetchImpl: async () => response(published),
    storage,
  }), { status: 'published', release: published });
});
