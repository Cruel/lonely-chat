import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  validateProfileValues,
  type InferenceProfile,
  type InferenceProfileValues,
  type ProfileModelReference,
} from '../shared/inference-profile-contract';

const FILE = 'inference-profiles.json';
const ID = /^[0-9a-f-]{36}$/i;

export class InferenceProfileStore {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly directory: string,
    private readonly exists: (
      model: ProfileModelReference,
      role: import('../shared/inference-profile-contract').InferenceRole,
    ) => boolean,
  ) {}

  private async history(): Promise<InferenceProfile[]> {
    let raw: string;
    try {
      raw = await readFile(path.join(this.directory, FILE), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    if (Buffer.byteLength(raw) > 2_000_000)
      throw new Error('Inference Profile storage is too large.');
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data))
      throw new Error('Invalid Inference Profile storage.');
    const document = data as Record<string, unknown>;
    if (
      document.version !== 1 ||
      !Array.isArray(document.profiles) ||
      document.profiles.length > 1000
    )
      throw new Error('Unsupported Inference Profile schema.');
    const seen = new Set<string>();
    return document.profiles.map((rawProfile: unknown) => {
      if (!rawProfile || typeof rawProfile !== 'object' || Array.isArray(rawProfile))
        throw new Error('Invalid Inference Profile.');
      const p = rawProfile as Record<string, unknown>;
      if (
        typeof p.id !== 'string' ||
        !ID.test(p.id) ||
        typeof p.name !== 'string' ||
        !p.name.trim() ||
        p.name.length > 80 ||
        typeof p.revision !== 'number' ||
        !Number.isSafeInteger(p.revision) ||
        p.revision < 1 ||
        seen.has(`${p.id}:${p.revision}`)
      )
        throw new Error('Invalid Inference Profile revision.');
      seen.add(`${p.id}:${p.revision}`);
      return {
        id: p.id,
        name: p.name,
        revision: p.revision,
        values: validateProfileValues(p.values, () => true),
      } as InferenceProfile;
    });
  }

  async list(): Promise<InferenceProfile[]> {
    const latest = new Map<string, InferenceProfile>();
    for (const profile of await this.history()) latest.set(profile.id, profile);
    return [...latest.values()];
  }
  async revisions(id: string): Promise<InferenceProfile[]> {
    if (!ID.test(id)) throw new Error('Invalid Inference Profile ID.');
    return (await this.history()).filter((profile) => profile.id === id);
  }
  async resolve(id: string, revision?: number): Promise<InferenceProfile> {
    const profiles = await this.revisions(id);
    const profile =
      revision === undefined
        ? profiles.at(-1)
        : profiles.find((item) => item.revision === revision);
    if (!profile)
      throw new Error(
        `Inference Profile ${id} revision ${revision ?? 'latest'} is missing or deleted.`,
      );
    validateProfileValues(profile.values, this.exists);
    return profile;
  }
  async save(input: {
    id?: string;
    name: string;
    values: InferenceProfileValues;
  }): Promise<InferenceProfile> {
    if (
      !input ||
      typeof input.name !== 'string' ||
      !input.name.trim() ||
      input.name.length > 80 ||
      (input.id !== undefined && !ID.test(input.id))
    )
      throw new Error('Invalid Inference Profile name or ID.');
    const values = validateProfileValues(input.values, this.exists);
    return this.serialize(async () => {
      const history = await this.history();
      const latest = new Map<string, InferenceProfile>();
      for (const profile of history) latest.set(profile.id, profile);
      if (input.id && !latest.has(input.id)) throw new Error('Inference Profile not found.');
      if (
        [...latest.values()].some(
          (p) => p.id !== input.id && p.name.toLowerCase() === input.name.trim().toLowerCase(),
        )
      )
        throw new Error('Inference Profile names must be unique.');
      if (!input.id && latest.size >= 100)
        throw new Error('At most 100 Inference Profiles are supported.');
      if (history.length >= 1000)
        throw new Error('At most 1,000 Inference Profile revisions are supported.');
      const profile: InferenceProfile = {
        id: input.id ?? randomUUID(),
        name: input.name.trim(),
        revision: (latest.get(input.id ?? '')?.revision ?? 0) + 1,
        values,
      };
      history.push(profile);
      await this.persist(history);
      return profile;
    });
  }
  async delete(id: string): Promise<void> {
    await this.serialize(async () => {
      const history = await this.history();
      if (!history.some((p) => p.id === id)) throw new Error('Inference Profile not found.');
      await this.persist(history.filter((p) => p.id !== id));
    });
  }
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.pending.then(fn);
    this.pending = next.catch(() => {});
    return next;
  }
  private async persist(profiles: InferenceProfile[]): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const file = path.join(this.directory, FILE);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, profiles }, null, 2) + '\n', {
        mode: 0o600,
      });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
