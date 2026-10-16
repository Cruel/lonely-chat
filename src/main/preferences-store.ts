import { readFile, writeFile, rename, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_PREFERENCES,
  validatePreferences,
  type SessionPreferences,
} from '../shared/session-contract';

const VERSION = 2;
const FILE = 'preferences.json';

/** Only approved UI preferences are persisted, never manual context or observed content. */
export class PreferencesStore {
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly userDataDirectory: string) {}

  async read(): Promise<SessionPreferences> {
    try {
      const raw: unknown = JSON.parse(
        await readFile(path.join(this.userDataDirectory, FILE), 'utf8'),
      );
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('Invalid preferences document.');
      }
      const document = raw as Record<string, unknown>;
      if (document.version === 1) {
        // Migrate existing cycle-only settings without losing the user's selected pace.
        const legacy = document.simulation as Record<string, unknown>;
        if (!legacy || Object.keys(legacy).length !== 1) {
          throw new Error('Invalid legacy simulation preferences.');
        }
        return validatePreferences(legacy);
      }
      if (document.version !== VERSION) {
        throw new Error('Unsupported preferences version.');
      }
      const validated = validatePreferences(document.simulation);
      if (Object.keys(document.simulation as Record<string, unknown>).length !== 4) {
        throw new Error('Incomplete simulation preferences.');
      }
      return validated;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_PREFERENCES };
      throw error;
    }
  }

  async write(prefs: unknown): Promise<SessionPreferences> {
    const validated = validatePreferences(prefs);
    // Serialize concurrent IPC saves so temporary files and publication order cannot collide.
    const save = this.writes.then(async () => {
      await mkdir(this.userDataDirectory, { recursive: true });
      const destination = path.join(this.userDataDirectory, FILE);
      const temporary = `${destination}.${process.pid}.tmp`;
      try {
        await writeFile(
          temporary,
          JSON.stringify({ version: VERSION, simulation: validated }, null, 2) + '\n',
          { mode: 0o600 },
        );
        await rename(temporary, destination);
      } finally {
        await rm(temporary, { force: true });
      }
      return validated;
    });
    this.writes = save.then(
      () => {},
      () => {},
    );
    return save;
  }
}
