import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SecretProtector } from './remote-inference-store';

export type CredentialStorage = 'protected' | 'file' | 'session';
type PersistedSecrets = Record<string, string>;

function object(value: unknown): PersistedSecrets {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid credential file.');
  const entries = Object.entries(value);
  if (
    entries.length > 250 ||
    entries.some(
      ([id, value]) =>
        (id !== '$deleted' && !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) ||
        typeof value !== 'string' ||
        value.length > 200_000,
    )
  )
    throw new Error('Invalid credential file.');
  return value as PersistedSecrets;
}

async function readExisting(file: string, privateFile = false): Promise<PersistedSecrets | null> {
  let stat;
  try {
    stat = await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.size > 5_000_000)
    throw new Error('Unsafe credential file type or size.');
  if (
    privateFile &&
    process.platform !== 'win32' &&
    (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
  )
    throw new Error('Credential file must be owned by this user and inaccessible to others.');
  return object(JSON.parse(await readFile(file, 'utf8')) as unknown);
}

async function atomicWrite(file: string, value: unknown): Promise<void> {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temp, file);
    // Ensure restrictive permissions even after replacing a preexisting file.
    if (process.platform !== 'win32') await chmod(file, 0o600);
  } finally {
    await rm(temp, { force: true });
  }
}

/** One application-wide preference for ChatGPT OAuth and managed remote keys. */
export class CredentialPolicy {
  private enabled = true;
  constructor(private readonly directory: string) {}

  get persist(): boolean {
    return this.enabled;
  }

  async load(): Promise<void> {
    const file = path.join(this.directory, 'credential-policy.json');
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(file, 'utf8')) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const settings = raw as { version?: unknown; persist?: unknown };
    if (!settings || settings.version !== 1 || typeof settings.persist !== 'boolean')
      throw new Error('Invalid credential persistence preference.');
    this.enabled = settings.persist;
  }

  async setPersist(enabled: boolean): Promise<void> {
    await atomicWrite(path.join(this.directory, 'credential-policy.json'), {
      version: 1,
      persist: enabled,
    });
    this.enabled = enabled;
  }
}

/** Existing encrypted format is preserved. Fallback stores secrets only in a 0700 subdirectory. */
export class CredentialFiles {
  constructor(
    private readonly directory: string,
    private readonly encryptedFile: string,
    private readonly fileName: 'chatgpt' | 'remote',
    private readonly protector: SecretProtector,
    private readonly policy: CredentialPolicy,
  ) {}

  private localDirectory(): string {
    return path.join(this.directory, 'private-credentials');
  }
  private localFile(): string {
    return path.join(this.localDirectory(), `${this.fileName}.json`);
  }

  private async verifyDirectory(): Promise<void> {
    let stat;
    try {
      stat = await lstat(this.localDirectory());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(this.localDirectory(), { mode: 0o700 });
      stat = await lstat(this.localDirectory());
    }
    if (
      !stat.isDirectory() ||
      (process.platform !== 'win32' &&
        (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))
    )
      throw new Error('Private credential directory must belong to this user and be mode 0700.');
  }

  async load(): Promise<{ secrets: PersistedSecrets; storage: 'protected' | 'file' | null }> {
    if (!this.policy.persist) return { secrets: {}, storage: null };
    await this.verifyDirectory();
    const rawLocal = await readExisting(this.localFile(), true);
    const local = { ...rawLocal };
    const removed = this.deletedIds(local.$deleted);
    delete local.$deleted;
    if (!this.protector.available())
      return rawLocal ? { secrets: local, storage: 'file' } : { secrets: {}, storage: null };

    const encrypted = await readExisting(this.encryptedFile);
    const decrypted: PersistedSecrets = {};
    let unavailable = false;
    for (const [id, value] of Object.entries(encrypted ?? {})) {
      try {
        decrypted[id] = this.protector.decrypt(Buffer.from(value, 'base64'));
      } catch {
        unavailable = true;
      }
    }
    if (rawLocal) {
      // Merge older encrypted values with the new local writes, excluding keys
      // explicitly removed or rebound while the OS keyring was unavailable.
      const merged = { ...decrypted, ...local };
      for (const id of removed) if (!(id in local)) delete merged[id];
      if (!unavailable) {
        await this.save(merged);
        return { secrets: merged, storage: 'protected' };
      }
      // Keep the unopenable encrypted records intact until that key is available.
      return { secrets: merged, storage: 'file' };
    }
    return encrypted
      ? { secrets: decrypted, storage: 'protected' }
      : { secrets: {}, storage: null };
  }

  private deletedIds(raw: string | undefined): Set<string> {
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (
      !Array.isArray(parsed) ||
      parsed.some((id) => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id))
    )
      throw new Error('Invalid credential deletion metadata.');
    return new Set(parsed);
  }

  async save(
    secrets: PersistedSecrets,
    removedIds: readonly string[] = [],
  ): Promise<CredentialStorage> {
    object(secrets);
    if (removedIds.some((id) => !/^[a-zA-Z0-9_-]{1,100}$/.test(id)))
      throw new Error('Invalid credential deletion ID.');
    if (!this.policy.persist) {
      await this.clear();
      return 'session';
    }
    if (this.protector.available()) {
      const encoded = Object.fromEntries(
        Object.entries(secrets).map(([id, secret]) => [
          id,
          this.protector.encrypt(secret).toString('base64'),
        ]),
      );
      await atomicWrite(this.encryptedFile, encoded);
      await rm(this.localFile(), { force: true });
      return 'protected';
    }
    await this.verifyDirectory();
    const previous = await readExisting(this.localFile(), true);
    const deleted = this.deletedIds(previous?.$deleted);
    for (const id of removedIds) deleted.add(id);
    for (const id of Object.keys(secrets)) deleted.delete(id);
    await atomicWrite(this.localFile(), {
      ...secrets,
      ...(deleted.size ? { $deleted: JSON.stringify([...deleted]) } : {}),
    });
    // Do not discard an older encrypted file when its OS keyring is temporarily absent.
    return 'file';
  }

  async clear(): Promise<void> {
    await rm(this.encryptedFile, { force: true });
    await rm(this.localFile(), { force: true });
  }
}
