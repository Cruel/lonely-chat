import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PromptPresetStore } from './prompt-preset-store';
import type { SimulationExperimentValues } from '../shared/playground-contract';

const values: SimulationExperimentValues = {
  context: 'Playing chess',
  cycle: 1,
  playbackWindowMs: 3000,
  chatActivity: 'normal',
  roster: [{ author: 'chessfan', color: '#aabbcc' }],
  events: [],
  transcripts: [],
  observations: [],
  recentChat: [],
};

describe('prompt preset persistence and revisions', () => {
  it('saves, reloads, revises and deletes with production request validation', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'lonely-presets-'));
    try {
      const store = new PromptPresetStore(dir);
      expect(await store.list()).toEqual([]);
      const first = await store.save({ name: 'Chess', values });
      expect(first.revision).toBe(1);
      const copy = new PromptPresetStore(dir);
      expect(await copy.list()).toEqual([first]);
      const second = await copy.save({
        id: first.id,
        name: 'Chess',
        values: { ...values, context: 'Go' },
      });
      expect(second).toMatchObject({ id: first.id, revision: 2 });
      expect(first.values.context).toBe('Playing chess');
      expect((await copy.revisions(first.id)).map((p) => p.revision)).toEqual([1, 2]);
      expect((await copy.revisions(first.id))[0].values.context).toBe('Playing chess');
      expect((await store.list())[0].values.context).toBe('Go');
      await expect(store.save({ name: 'Other', values: { ...values, cycle: 0 } })).rejects.toThrow(
        /cycle/,
      );
      await expect(store.save({ name: 'chess', values })).rejects.toThrow(/unique/);
      await expect(store.save({ id: 'missing', name: 'Missing', values })).rejects.toThrow(/ID/);
      const raw = JSON.parse(await readFile(path.join(dir, 'prompt-presets.json'), 'utf8'));
      expect(raw.version).toBe(1);
      await store.delete(first.id);
      expect(await store.list()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('serializes simultaneous updates without losing revisions', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'lonely-presets-'));
    try {
      const store = new PromptPresetStore(dir);
      const first = await store.save({ name: 'Test', values });
      const updates = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          store.save({ id: first.id, name: 'Test', values: { ...values, context: 'Edit ' + i } }),
        ),
      );
      expect(updates.map((p) => p.revision)).toEqual([2, 3, 4, 5, 6]);
      expect((await store.list())[0].revision).toBe(6);
      expect((await store.revisions(first.id)).map((p) => p.revision)).toEqual([1, 2, 3, 4, 5, 6]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
