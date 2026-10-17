import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AudioConfigStore } from './audio-config-store';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('saved audio input configuration', () => {
  it('restores labeled devices without ever saving media or starting capture', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'lonely-audio-config-'));
    dirs.push(dir);
    const store = new AudioConfigStore(dir);
    expect(await store.read()).toEqual([]);
    const input = [
      { id: 'streamer', sourceId: 'device-a', label: 'Streamer' },
      { id: 'voice', sourceId: 'device-b', label: 'Voice chat' },
    ];
    await store.write(input);
    expect(await new AudioConfigStore(dir).read()).toEqual(input);
    const raw = await readFile(path.join(dir, 'audio-inputs.json'), 'utf8');
    expect(JSON.parse(raw)).toEqual({ version: 1, inputs: input });
    expect(raw).not.toContain('transcript');
    await store.write([input[1]!]);
    expect(await store.read()).toEqual([input[1]]);
  });

  it('rejects invalid names and duplicate identities before modifying the saved configuration', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'lonely-audio-config-'));
    dirs.push(dir);
    const store = new AudioConfigStore(dir);
    const valid = [{ id: 'mic', sourceId: 'microphone', label: 'Mic' }];
    await store.write(valid);
    await expect(store.write([{ ...valid[0], label: '' }])).rejects.toThrow(/label/);
    await expect(store.write([...valid, ...valid])).rejects.toThrow(/Duplicate/);
    await expect(store.write([{ ...valid[0], sourceId: 'contains a space' }])).rejects.toThrow(
      /configuration/,
    );
    expect(await store.read()).toEqual(valid);
  });
});
