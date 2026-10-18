import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SimulationExperimentValues } from '../shared/playground-contract';
import type { PromptPreset } from '../shared/prompt-preset-contract';
import {
  validateSimulationExperiment,
  buildSimulationExperimentInput,
  constructedSimulationRequest,
} from './simulation-experiment';

const FILE = 'prompt-presets.json';

/** Revisions are immutable snapshots: returning copies prevents experiments mutating saved presets. */
export class PromptPresetStore {
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private readonly directory: string) {}

  async list(): Promise<PromptPreset[]> {
    const latest = new Map<string, PromptPreset>();
    for (const preset of await this.history()) latest.set(preset.id, preset);
    return [...latest.values()];
  }

  async revisions(id: string): Promise<PromptPreset[]> {
    return (await this.history()).filter((preset) => preset.id === id);
  }

  private async history(): Promise<PromptPreset[]> {
    try {
      const data: unknown = JSON.parse(await readFile(path.join(this.directory, FILE), 'utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data))
        throw new Error('Invalid presets file.');
      const document = data as { version?: unknown; presets?: unknown };
      if (
        document.version !== 1 ||
        !Array.isArray(document.presets) ||
        document.presets.length > 1000
      )
        throw new Error('Invalid presets file.');
      const keys = new Set<string>();
      return document.presets.map((entry: unknown) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry))
          throw new Error('Invalid preset.');
        const p = entry as Record<string, unknown>;
        if (
          typeof p.id !== 'string' ||
          !/^[0-9a-f-]{36}$/i.test(p.id) ||
          keys.has(`${p.id}:${p.revision}`) ||
          typeof p.name !== 'string' ||
          !p.name.trim() ||
          p.name.length > 80 ||
          !Number.isSafeInteger(p.revision) ||
          (p.revision as number) < 1
        )
          throw new Error('Invalid preset metadata.');
        keys.add(`${p.id}:${p.revision}`);
        const values = this.validateValues(p.values);
        return { id: p.id, name: p.name, revision: p.revision as number, values };
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private validateValues(value: unknown): SimulationExperimentValues {
    const request = validateSimulationExperiment({ modelId: 'preset-validation', values: value });
    // Validate with the actual production request construction, not a separate prompt template.
    constructedSimulationRequest(buildSimulationExperimentInput(request.values, Date.now()));
    return request.values;
  }

  async save(input: {
    id?: string;
    name: string;
    values: SimulationExperimentValues;
  }): Promise<PromptPreset> {
    if (!input || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80)
      throw new Error('Preset name must be 1–80 characters.');
    if (
      input.id !== undefined &&
      (typeof input.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(input.id))
    )
      throw new Error('Invalid preset ID.');
    const values = this.validateValues(input.values);
    return this.serialize(async () => {
      const presets = await this.history();
      const latest = new Map<string, PromptPreset>();
      for (const preset of presets) latest.set(preset.id, preset);
      const index = presets.findIndex((preset) => preset === latest.get(input.id ?? ''));
      if (input.id && index < 0) throw new Error('Preset not found.');
      if (
        [...latest.values()].some(
          (p) => p.id !== input.id && p.name.toLowerCase() === input.name.trim().toLowerCase(),
        )
      )
        throw new Error('Preset names must be unique.');
      if (index < 0 && latest.size >= 100) throw new Error('At most 100 presets are supported.');
      if (presets.length >= 1000) throw new Error('At most 1,000 preset revisions are supported.');
      const preset: PromptPreset = {
        id: index < 0 ? randomUUID() : presets[index].id,
        name: input.name.trim(),
        revision: index < 0 ? 1 : presets[index].revision + 1,
        values,
      };
      presets.push(preset);
      await this.publish(presets);
      return preset;
    });
  }

  async delete(id: string): Promise<void> {
    return this.serialize(async () => {
      const presets = await this.history();
      if (!presets.some((p) => p.id === id)) throw new Error('Preset not found.');
      await this.publish(presets.filter((p) => p.id !== id));
    });
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.writes.then(fn);
    this.writes = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private async publish(presets: PromptPreset[]): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const dest = path.join(this.directory, FILE);
    const temp = dest + '.' + process.pid + '.tmp';
    try {
      await writeFile(temp, JSON.stringify({ version: 1, presets }, null, 2) + '\n', {
        mode: 0o600,
      });
      await rename(temp, dest);
    } finally {
      await rm(temp, { force: true });
    }
  }
}
