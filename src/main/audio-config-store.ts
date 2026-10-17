import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateAudioConfiguration, type AudioInputConfiguration } from '../shared/audio-contract';

const FILE = 'audio-inputs.json';

/** Device identities/labels only. No samples or transcripts are ever persisted. */
export class AudioConfigStore {
  private writes = Promise.resolve();

  constructor(private readonly userDataDirectory: string) {}

  async read(): Promise<AudioInputConfiguration[]> {
    try {
      const data: unknown = JSON.parse(
        await readFile(path.join(this.userDataDirectory, FILE), 'utf8'),
      );
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('Invalid audio input settings.');
      }
      const document = data as Record<string, unknown>;
      if (document.version !== 1 || Object.keys(document).length !== 2) {
        throw new Error('Unsupported audio input settings.');
      }
      return validateAudioConfiguration(document.inputs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async write(value: unknown): Promise<AudioInputConfiguration[]> {
    const inputs = validateAudioConfiguration(value);
    const task = this.writes.then(async () => {
      await mkdir(this.userDataDirectory, { recursive: true });
      const destination = path.join(this.userDataDirectory, FILE);
      const temporary = `${destination}.${process.pid}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ version: 1, inputs }, null, 2) + '\n', {
          mode: 0o600,
        });
        await rename(temporary, destination);
      } finally {
        await rm(temporary, { force: true });
      }
      return inputs;
    });
    this.writes = task.then(
      () => {},
      () => {},
    );
    return task;
  }
}
