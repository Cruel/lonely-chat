import { readFile, writeFile, rename, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_PREFERENCES,
  validatePreferences,
  type SessionPreferences,
} from '../shared/session-contract';

const VERSION = 9;
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
      if (![2, 3, 4, 5, 6, 7, 8, VERSION].includes(document.version as number)) {
        throw new Error('Unsupported preferences version.');
      }
      const validated = validatePreferences(document.simulation);
      // Historical versions require their entire original schema, with no newer fields.
      // Migrations append only new defaults and preserve all existing customized values.
      const fields = [
        'cycleIntervalMs',
        'baselineMs',
        'historyMaxCount',
        'historyMaxAgeMs',
        ...(Number(document.version) >= 3 ? ['reasoningEnabled'] : []),
        ...(Number(document.version) >= 4 ? ['inferenceTimeoutMs'] : []),
        ...(Number(document.version) >= 5
          ? [
              'videoCaptureIntervalMs',
              'videoCoverageMs',
              'videoMinFrames',
              'videoMaxFrames',
              'videoSamplingStrategy',
            ]
          : []),
        ...(Number(document.version) >= 6 ? ['audienceCount', 'chatActivity'] : []),
        ...(Number(document.version) >= 7
          ? [
              'ramBudgetMiB',
              'vramBudgetMiB',
              'gpuComputeTargetPercent',
              'computeBackend',
              'cpuThreads',
              'contextTokens',
              'gpuOffloadLayers',
            ]
          : []),
        ...(Number(document.version) >= 8 ? ['imageMaxTokens'] : []),
        ...(Number(document.version) >= 9 ? ['videoCaptureMaxWidth', 'videoCaptureMaxHeight'] : []),
      ];
      const keys = Object.keys(document.simulation as Record<string, unknown>);
      if (keys.length !== fields.length || fields.some((field) => !keys.includes(field))) {
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
