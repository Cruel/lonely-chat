import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PreferencesStore } from './preferences-store';
import { DEFAULT_PREFERENCES } from '../shared/session-contract';

const dirs: string[] = [];
async function store(): Promise<{ store: PreferencesStore; directory: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), 'lonely-chat-prefs-'));
  dirs.push(directory);
  return { store: new PreferencesStore(directory), directory };
}

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('versioned preferences', () => {
  it('starts with defaults, saves only approved preferences, and reloads them', async () => {
    const { store: settings, directory } = await store();
    expect(await settings.read()).toEqual(DEFAULT_PREFERENCES);
    expect(await settings.write({ cycleIntervalMs: 1500 })).toEqual({ cycleIntervalMs: 1500 });
    const data = JSON.parse(await readFile(path.join(directory, 'preferences.json'), 'utf8'));
    expect(data).toEqual({ version: 1, simulation: { cycleIntervalMs: 1500 } });
    expect(await settings.read()).toEqual({ cycleIntervalMs: 1500 });
    expect(await readdir(directory)).toEqual(['preferences.json']);
    expect(JSON.stringify(data)).not.toContain('manual context');
  });

  it('serializes concurrent preference saves without colliding or losing the final value', async () => {
    const { store: settings, directory } = await store();
    const values = await Promise.all([
      settings.write({ cycleIntervalMs: 1500 }),
      settings.write({ cycleIntervalMs: 3000 }),
      settings.write({ cycleIntervalMs: 5000 }),
    ]);
    expect(values).toEqual([
      { cycleIntervalMs: 1500 },
      { cycleIntervalMs: 3000 },
      { cycleIntervalMs: 5000 },
    ]);
    expect(await settings.read()).toEqual({ cycleIntervalMs: 5000 });
    expect(await readdir(directory)).toEqual(['preferences.json']);
  });

  it('refuses unexpected keys or future versions without overwriting existing values', async () => {
    const { store: settings, directory } = await store();
    await settings.write({ cycleIntervalMs: 3000 });
    await expect(
      settings.write({ cycleIntervalMs: 3000, manualContext: 'private' }),
    ).rejects.toThrow();
    expect(await settings.read()).toEqual({ cycleIntervalMs: 3000 });
    await writeFile(
      path.join(directory, 'preferences.json'),
      JSON.stringify({
        version: 2,
        simulation: { cycleIntervalMs: 3000 },
      }),
    );
    await expect(settings.read()).rejects.toThrow(/Unsupported/);
  });
});
