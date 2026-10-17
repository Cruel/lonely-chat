import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OverlayPortStore } from './overlay-port-store';
import { DEFAULT_OVERLAY_PORT, validateOverlayPort } from '../shared/overlay-contract';

describe('persisted overlay port', () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });
  const setup = async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lonely-overlay-port-'));
    roots.push(root);
    return { root, store: new OverlayPortStore(root) };
  };

  it('defaults to 18080, persists a custom port and serializes saves', async () => {
    const { root, store } = await setup();
    expect(DEFAULT_OVERLAY_PORT).toBe(18080);
    expect(await store.read()).toBe(18080);
    await Promise.all([store.write(18081), store.write(19000)]);
    expect(await new OverlayPortStore(root).read()).toBe(19000);
    expect(JSON.parse(await readFile(path.join(root, 'overlay-settings.json'), 'utf8'))).toEqual({
      version: 1,
      port: 19000,
    });
  });

  it('rejects invalid ports and replaced settings documents', async () => {
    const { root, store } = await setup();
    for (const port of [0, -1, 65536, 1.5, NaN, Infinity, '18080']) {
      expect(() => validateOverlayPort(port)).toThrow(/port/i);
      await expect(store.write(port)).rejects.toThrow(/port/i);
    }
    await writeFile(
      path.join(root, 'overlay-settings.json'),
      JSON.stringify({ version: 2, port: 18080 }),
    );
    await expect(store.read()).rejects.toThrow(/version/);
    await writeFile(
      path.join(root, 'overlay-settings.json'),
      JSON.stringify({ version: 1, port: 18080, legacy: true }),
    );
    await expect(store.read()).rejects.toThrow(/shape/);
  });
});
