import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_WINDOW_PREFERENCES,
  validateWindowPreferences,
  type WindowPreferences,
} from '../shared/window-preferences-contract';

const VERSION = 1;
const FILE = 'window-preferences.json';

/** Window/tray configuration only. No ephemeral capture, chat, or transcripts. */
export class WindowPreferencesStore {
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly directory: string) {}

  async read(): Promise<WindowPreferences> {
    try {
      const raw: unknown = JSON.parse(await readFile(path.join(this.directory, FILE), 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new Error('Invalid window preferences file.');
      const record = raw as Record<string, unknown>;
      if (
        record.version !== VERSION ||
        Object.keys(record).length !== 2 ||
        !Object.hasOwn(record, 'window')
      ) {
        throw new Error('Unsupported window preferences version or shape.');
      }
      return validateWindowPreferences(record.window);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return {
          ...DEFAULT_WINDOW_PREFERENCES,
          floating: { ...DEFAULT_WINDOW_PREFERENCES.floating },
        };
      throw error;
    }
  }

  async write(value: unknown): Promise<WindowPreferences> {
    const preferences = validateWindowPreferences(value);
    const save = this.writes.then(async () => {
      await mkdir(this.directory, { recursive: true });
      const file = path.join(this.directory, FILE);
      const temporary = `${file}.${process.pid}.tmp`;
      try {
        await writeFile(
          temporary,
          JSON.stringify({ version: VERSION, window: preferences }, null, 2) + '\n',
          { mode: 0o600 },
        );
        await rename(temporary, file);
      } finally {
        await rm(temporary, { force: true });
      }
      return preferences;
    });
    this.writes = save.then(
      () => {},
      () => {},
    );
    return save;
  }
}
