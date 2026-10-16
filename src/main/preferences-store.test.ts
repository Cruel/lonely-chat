import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PreferencesStore } from './preferences-store';
import { DEFAULT_PREFERENCES } from '../shared/session-contract';

const dirs: string[] = [];
const pace = (cycleIntervalMs: number) => ({ ...DEFAULT_PREFERENCES, cycleIntervalMs });
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
    expect(await settings.write(pace(1500))).toEqual(pace(1500));
    const data = JSON.parse(await readFile(path.join(directory, 'preferences.json'), 'utf8'));
    expect(data).toEqual({ version: 3, simulation: pace(1500) });
    expect(await settings.read()).toEqual(pace(1500));
    expect(await readdir(directory)).toEqual(['preferences.json']);
    expect(JSON.stringify(data)).not.toContain('manual context');
  });

  it('serializes concurrent preference saves without colliding or losing the final value', async () => {
    const { store: settings, directory } = await store();
    const values = await Promise.all([
      settings.write(pace(1500)),
      settings.write(pace(3000)),
      settings.write(pace(5000)),
    ]);
    expect(values).toEqual([pace(1500), pace(3000), pace(5000)]);
    expect(await settings.read()).toEqual(pace(5000));
    expect(await readdir(directory)).toEqual(['preferences.json']);
  });

  it('migrates version-one cycle-only preferences to the expanded settings', async () => {
    const { store: settings, directory } = await store();
    await writeFile(
      path.join(directory, 'preferences.json'),
      JSON.stringify({
        version: 1,
        simulation: { cycleIntervalMs: 1500 },
      }),
    );
    expect(await settings.read()).toEqual(pace(1500));
    expect(
      await settings.write({
        ...pace(1500),
        baselineMs: 1000,
        historyMaxCount: 16,
        historyMaxAgeMs: 30000,
      }),
    ).toMatchObject({ baselineMs: 1000, historyMaxCount: 16, historyMaxAgeMs: 30000 });
    expect(
      JSON.parse(await readFile(path.join(directory, 'preferences.json'), 'utf8')).version,
    ).toBe(3);
  });

  it('migrates existing version-two preferences with reasoning disabled by default', async () => {
    const { store: settings, directory } = await store();
    const { reasoningEnabled: _ignored, ...previous } = pace(5000);
    await writeFile(
      path.join(directory, 'preferences.json'),
      JSON.stringify({ version: 2, simulation: previous }),
    );
    expect(await settings.read()).toEqual(pace(5000));
    expect(await settings.write({ ...pace(5000), reasoningEnabled: true })).toMatchObject({
      reasoningEnabled: true,
    });
    expect(await settings.read()).toMatchObject({ reasoningEnabled: true });
  });

  it('refuses unexpected keys or future versions without overwriting existing values', async () => {
    const { store: settings, directory } = await store();
    await settings.write(pace(3000));
    await expect(settings.write({ ...pace(3000), manualContext: 'private' })).rejects.toThrow();
    expect(await settings.read()).toEqual(pace(3000));
    await writeFile(
      path.join(directory, 'preferences.json'),
      JSON.stringify({
        version: 4,
        simulation: { cycleIntervalMs: 3000 },
      }),
    );
    await expect(settings.read()).rejects.toThrow(/Unsupported/);
  });
});
