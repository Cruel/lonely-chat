import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_OVERLAY_PORT, validateOverlayPort } from '../shared/overlay-contract';

const FILE = 'overlay-settings.json';
const VERSION = 1;

/** Separate file: existing window preferences remain valid without a schema migration. */
export class OverlayPortStore {
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly directory: string) {}

  async read(): Promise<number> {
    try {
      const raw: unknown = JSON.parse(await readFile(path.join(this.directory, FILE), 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('Invalid overlay settings.');
      }
      const record = raw as Record<string, unknown>;
      if (
        record.version !== VERSION ||
        Object.keys(record).length !== 2 ||
        !Object.hasOwn(record, 'port')
      ) {
        throw new Error('Unsupported overlay settings version or shape.');
      }
      return validateOverlayPort(record.port);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_OVERLAY_PORT;
      throw error;
    }
  }

  async write(value: unknown): Promise<number> {
    const port = validateOverlayPort(value);
    const save = this.writes.then(async () => {
      await mkdir(this.directory, { recursive: true });
      const file = path.join(this.directory, FILE);
      const temporary = `${file}.${process.pid}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ version: VERSION, port }, null, 2) + '\n', {
          mode: 0o600,
        });
        await rename(temporary, file);
      } finally {
        await rm(temporary, { force: true });
      }
    });
    this.writes = save.then(
      () => {},
      () => {},
    );
    await save;
    return port;
  }
}
