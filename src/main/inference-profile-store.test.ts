import { afterEach, expect, test } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { InferenceProfileStore } from './inference-profile-store';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lonely-profile-'));
  dirs.push(dir);
  const models = new Set(['remote:chat', 'local:vision']);
  return {
    dir,
    models,
    store: new InferenceProfileStore(dir, (ref) => models.has(`${ref.kind}:${ref.modelId}`)),
  };
}
const unified = {
  topology: 'unified' as const,
  roles: { unified: { kind: 'remote' as const, modelId: 'chat' } },
  stageDefaults: { unified: { settings: { cycleIntervalMs: 5000 } } },
};
const split = {
  topology: 'split' as const,
  roles: {
    observer: { kind: 'local' as const, modelId: 'vision' },
    chat: { kind: 'remote' as const, modelId: 'chat' },
  },
  stageDefaults: {},
};

test('persists immutable revisions, resolves pinned and latest, and deletes all revisions', async () => {
  const { dir, store } = await fixture();
  const first = await store.save({ name: 'Production', values: unified });
  const second = await store.save({ id: first.id, name: 'Production', values: split });
  expect(first.revision).toBe(1);
  expect(second.revision).toBe(2);
  expect((await store.list()).map((p) => p.revision)).toEqual([2]);
  const reopened = new InferenceProfileStore(dir, () => true);
  expect(await reopened.resolve(first.id, 1)).toEqual(first);
  expect(await reopened.resolve(first.id)).toEqual(second);
  expect(
    (await readFile(path.join(dir, 'inference-profiles.json'), 'utf8')).includes('apiKey'),
  ).toBe(false);
  await store.delete(first.id);
  expect(await store.list()).toEqual([]);
  await expect(reopened.resolve(first.id)).rejects.toThrow(/missing or deleted/);
});

test('does not allow invalid roles, unknown models, duplicated names or invalid policy defaults', async () => {
  const { store } = await fixture();
  await expect(
    store.save({ name: 'Bad', values: { ...split, roles: { observer: split.roles.observer } } }),
  ).rejects.toThrow(/requires/);
  await expect(
    store.save({
      name: 'Bad',
      values: {
        ...unified,
        roles: { unified: { kind: 'remote', modelId: 'deleted' } },
      },
    }),
  ).rejects.toThrow(/Missing or incompatible unified/);
  await expect(
    store.save({
      name: 'Bad',
      values: {
        ...unified,
        stageDefaults: { unified: { settings: { cycleIntervalMs: -1 } } },
      },
    }),
  ).rejects.toThrow();
  await store.save({ name: 'Production', values: unified });
  await expect(store.save({ name: 'production', values: unified })).rejects.toThrow(/unique/);
});

test('retains revision history after a referenced Model Configuration is deleted but refuses to resolve it', async () => {
  const { store, models } = await fixture();
  const profile = await store.save({ name: 'Production', values: unified });
  models.delete('remote:chat');
  expect(await store.list()).toHaveLength(1);
  expect(await store.revisions(profile.id)).toHaveLength(1);
  await expect(store.resolve(profile.id)).rejects.toThrow(
    /Missing or incompatible unified remote Model Configuration/,
  );
  await store.delete(profile.id);
});

test('permits the same installed model for both Split roles', async () => {
  const { store } = await fixture();
  const saved = await store.save({
    name: 'Reuse',
    values: {
      ...split,
      roles: { observer: split.roles.observer, chat: split.roles.observer },
    },
  });
  expect(saved.values.roles.observer).toEqual(saved.values.roles.chat);
});
