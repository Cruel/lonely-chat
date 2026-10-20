import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  CredentialFiles,
  CredentialPolicy,
  type CredentialStorage,
} from './credential-persistence';
import {
  validateRemoteConnection,
  validateRemoteModel,
  validRemoteId,
  type RemoteCatalog,
  type RemoteConnection,
  type RemoteModelConfiguration,
} from '../shared/remote-inference-contract';

/** Electron safeStorage is reliable only with a secure keyring (not Linux basic_text). */
export interface SecretProtector {
  available(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

interface CatalogFile {
  version: 1;
  connections: RemoteConnection[];
  models: RemoteModelConfiguration[];
}
function requireId(id: string): void {
  if (!validRemoteId(id)) throw new Error('Invalid remote configuration ID.');
}

export class RemoteInferenceStore {
  private catalog: CatalogFile = { version: 1, connections: [], models: [] };
  private sessionSecrets = new Map<string, string>();
  private persistentSecrets = new Map<string, string>();
  private storage: CredentialStorage = 'session';
  private readonly credentials: CredentialFiles;
  private readonly removedCredentials = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private loaded = false;

  constructor(
    private readonly directory: string,
    private readonly protector: SecretProtector,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly policy: CredentialPolicy = new CredentialPolicy(directory),
  ) {
    this.credentials = new CredentialFiles(
      directory,
      this.secretFile(),
      'remote',
      protector,
      policy,
    );
  }

  private file(): string {
    return path.join(this.directory, 'remote-inference.json');
  }
  private secretFile(): string {
    return path.join(this.directory, 'remote-secrets.bin.json');
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.file(), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      raw = { version: 1, connections: [], models: [] };
    }
    if (!raw || typeof raw !== 'object' || (raw as CatalogFile).version !== 1)
      throw new Error('Invalid remote connection configuration version.');
    const v = raw as CatalogFile;
    if (
      !Array.isArray(v.connections) ||
      !Array.isArray(v.models) ||
      v.connections.length > 100 ||
      v.models.length > 200
    )
      throw new Error('Invalid remote configuration collection.');
    const connections = v.connections.map(validateRemoteConnection);
    const models = v.models.map(validateRemoteModel);
    if (
      new Set(connections.map((item) => item.id)).size !== connections.length ||
      new Set(models.map((item) => item.id)).size !== models.length ||
      models.some((item) => !connections.some((entry) => entry.id === item.connectionId))
    )
      throw new Error('Invalid remote configuration references.');
    this.catalog = { version: 1, connections, models };
    const loaded = await this.credentials.load();
    this.storage = loaded.storage ?? 'session';
    for (const [id, value] of Object.entries(loaded.secrets)) {
      if (
        validRemoteId(id) &&
        connections.some((item) => item.id === id && item.credentialMode === 'managed')
      )
        this.persistentSecrets.set(id, value);
    }
    this.loaded = true;
  }

  private async atomic(file: string, contents: string): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, contents, { mode: 0o600 });
      await rename(temp, file);
    } finally {
      await rm(temp, { force: true });
    }
  }

  private mutate<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn);
    this.queue = next.catch(() => {});
    return next;
  }

  private async persist(): Promise<void> {
    await this.atomic(this.file(), JSON.stringify(this.catalog, null, 2) + '\n');
  }
  private async persistSecrets(): Promise<void> {
    const records: Record<string, string> = {};
    for (const [id, secret] of this.persistentSecrets) {
      if (
        this.catalog.connections.some((item) => item.id === id && item.credentialMode === 'managed')
      )
        records[id] = secret;
    }
    this.storage = await this.credentials.save(records, [...this.removedCredentials]);
    this.removedCredentials.clear();
  }

  async applyCredentialPolicy(): Promise<void> {
    await this.mutate(async () => {
      if (this.policy.persist) {
        for (const [id, secret] of this.sessionSecrets) this.persistentSecrets.set(id, secret);
        this.sessionSecrets.clear();
      } else {
        for (const [id, secret] of this.persistentSecrets) this.sessionSecrets.set(id, secret);
        this.persistentSecrets.clear();
      }
      await this.persistSecrets();
    });
  }

  list(): RemoteCatalog {
    if (!this.loaded) throw new Error('Remote configurations are not loaded.');
    return {
      connections: this.catalog.connections.map((connection) => ({
        ...connection,
        credentialStatus:
          connection.credentialMode === 'managed'
            ? this.persistentSecrets.has(connection.id)
              ? this.storage
              : this.sessionSecrets.has(connection.id)
                ? ('session' as const)
                : ('missing' as const)
            : connection.credentialMode === 'environment'
              ? this.environment[connection.environmentVariable!]
                ? ('session' as const)
                : ('missing' as const)
              : ('session' as const),
      })),
      models: this.catalog.models.map((model) => ({ ...model })),
    };
  }

  async putConnection(value: unknown): Promise<RemoteConnection> {
    return this.mutate(async () => {
      const connection = validateRemoteConnection(value);
      const old = this.catalog.connections.find((item) => item.id === connection.id);
      // Requiring a fresh credential when changing the destination prevents an
      // existing key from being silently redirected to another endpoint.
      if (
        old &&
        (old.credentialMode !== connection.credentialMode || old.baseUrl !== connection.baseUrl)
      ) {
        this.sessionSecrets.delete(connection.id);
        this.persistentSecrets.delete(connection.id);
        this.removedCredentials.add(connection.id);
      }
      this.catalog.connections = [
        ...this.catalog.connections.filter((item) => item.id !== connection.id),
        connection,
      ];
      await this.persist();
      await this.persistSecrets();
      return this.list().connections.find((item) => item.id === connection.id)!;
    });
  }

  async removeConnection(id: string): Promise<void> {
    return this.mutate(async () => {
      requireId(id);
      this.catalog.connections = this.catalog.connections.filter((item) => item.id !== id);
      this.catalog.models = this.catalog.models.filter((item) => item.connectionId !== id);
      this.sessionSecrets.delete(id);
      this.persistentSecrets.delete(id);
      this.removedCredentials.add(id);
      await this.persist();
      await this.persistSecrets();
    });
  }

  async putModel(value: unknown): Promise<RemoteModelConfiguration> {
    return this.mutate(async () => {
      const model = validateRemoteModel(value);
      const connection = this.catalog.connections.find((item) => item.id === model.connectionId);
      if (!connection) throw new Error('Remote model refers to a missing Connection.');
      if (connection.credentialMode === 'chatgpt' && model.outputFormat !== 'prompt-json')
        throw new Error('ChatGPT plan inference currently requires prompt-guided JSON output.');
      this.catalog.models = [...this.catalog.models.filter((item) => item.id !== model.id), model];
      await this.persist();
      return model;
    });
  }

  async removeModel(id: string): Promise<void> {
    return this.mutate(async () => {
      requireId(id);
      this.catalog.models = this.catalog.models.filter((item) => item.id !== id);
      await this.persist();
    });
  }

  /** A credential travels over one trusted renderer-to-main IPC call, never back. */
  async setCredential(id: string, secret: string): Promise<CredentialStorage> {
    return this.mutate(async () => {
      requireId(id);
      const connection = this.catalog.connections.find((item) => item.id === id);
      if (!connection || connection.credentialMode !== 'managed')
        throw new Error('This Connection does not accept managed credentials.');
      if (typeof secret !== 'string' || !secret.trim() || secret.length > 8192)
        throw new Error('Invalid API credential.');
      if (this.policy.persist) {
        this.persistentSecrets.set(id, secret);
        this.sessionSecrets.delete(id);
        await this.persistSecrets();
        return this.storage;
      }
      this.persistentSecrets.delete(id);
      this.sessionSecrets.set(id, secret);
      await this.persistSecrets();
      return 'session';
    });
  }

  /** Resolved only inside main; no accessor returns this value to the renderer. */
  resolve(id: string): { connection: RemoteConnection; credential: string | null } {
    requireId(id);
    const connection = this.catalog.connections.find((item) => item.id === id);
    if (!connection) throw new Error('Selected remote Connection no longer exists.');
    const credential =
      connection.credentialMode === 'none' || connection.credentialMode === 'chatgpt'
        ? null
        : connection.credentialMode === 'environment'
          ? (this.environment[connection.environmentVariable!] ?? null)
          : (this.persistentSecrets.get(id) ?? this.sessionSecrets.get(id) ?? null);
    if (
      connection.credentialMode !== 'none' &&
      connection.credentialMode !== 'chatgpt' &&
      !credential
    )
      throw new Error('Selected remote Connection requires a configured credential.');
    return { connection, credential };
  }

  selected(modelId: string): {
    connection: RemoteConnection;
    model: RemoteModelConfiguration;
    credential: string | null;
  } {
    requireId(modelId);
    const model = this.catalog.models.find((entry) => entry.id === modelId);
    if (!model) throw new Error('Selected remote Model Configuration no longer exists.');
    return { ...this.resolve(model.connectionId), model };
  }
}
