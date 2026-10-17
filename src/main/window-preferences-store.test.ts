import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WindowPreferencesStore } from './window-preferences-store';
import { DEFAULT_WINDOW_PREFERENCES } from '../shared/window-preferences-contract';

describe('window and tray preferences', () => {
  const directories: string[] = [];
  afterEach(async () => {
    for (const directory of directories.splice(0))
      await rm(directory, { recursive: true, force: true });
  });
  const setup = async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'lonely-window-'));
    directories.push(directory);
    return { directory, store: new WindowPreferencesStore(directory) };
  };
  it('defaults on first launch and persists floating dimensions/appearance and tray policy', async () => {
    const { store } = await setup();
    expect(await store.read()).toEqual(DEFAULT_WINDOW_PREFERENCES);
    const edited = {
      closeToTray: false,
      floating: { width: 840, height: 520, transparent: true, decorated: false, alwaysOnTop: true },
    };
    await store.write(edited);
    expect(await store.read()).toEqual(edited);
    expect(JSON.stringify(await store.read())).not.toContain('chat');
  });
  it('serializes consecutive saves so the final preference wins', async () => {
    const { store, directory } = await setup();
    const first = { ...DEFAULT_WINDOW_PREFERENCES, closeToTray: false };
    const second = { ...first, floating: { ...first.floating, width: 760 } };
    await Promise.all([store.write(first), store.write(second)]);
    expect(await new WindowPreferencesStore(directory).read()).toEqual(second);
    expect(await readFile(path.join(directory, 'window-preferences.json'), 'utf8')).toContain(
      '"version": 1',
    );
  });
  it('rejects unsupported versions and malformed flags rather than silently overwriting', async () => {
    const { store, directory } = await setup();
    await writeFile(
      path.join(directory, 'window-preferences.json'),
      JSON.stringify({ version: 2, window: DEFAULT_WINDOW_PREFERENCES }),
    );
    await expect(store.read()).rejects.toThrow(/version/);
    await expect(
      store.write({ ...DEFAULT_WINDOW_PREFERENCES, closeToTray: 'yes' }),
    ).rejects.toThrow(/Invalid/);
    await expect(
      store.write({
        ...DEFAULT_WINDOW_PREFERENCES,
        floating: { ...DEFAULT_WINDOW_PREFERENCES.floating, width: -100 },
      }),
    ).rejects.toThrow(/Invalid/);
  });
});
