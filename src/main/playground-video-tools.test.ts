import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PlaygroundVideoTools } from './playground-video-tools';
import {
  DEFAULT_NATIVE_VIDEO_PREFERENCES,
  validateNativeVideoPreferences,
} from '../shared/video-tools-contract';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function fakeRunner() {
  return vi.fn(async (executable: string, args: readonly string[]) => {
    const probe = path.basename(executable).startsWith('ffprobe');
    if (args.includes('-version')) {
      return { stdout: probe ? 'ffprobe version 7.1\n' : 'ffmpeg version 7.1\n', stderr: '' };
    }
    if (probe && args.includes('-show_entries')) {
      return {
        stdout: JSON.stringify({
          streams: [{ codec_type: 'video' }],
          format: { duration: '4.0' },
        }),
        stderr: '',
      };
    }
    throw new Error('unexpected invocation');
  });
}

describe('optional host FFmpeg discovery and bounded video selections', () => {
  it('finds paired tools, persists a manual directory and restores PATH mode', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lc-video-tools-'));
    roots.push(root);
    const runner = fakeRunner();
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    const manual = path.join(root, 'manual');
    const tools = new PlaygroundVideoTools(
      root,
      { PATH: [first, second].join(path.delimiter) },
      runner as never,
    );
    expect(await tools.status()).toMatchObject({
      available: true,
      directory: first,
      version: 'ffmpeg version 7.1',
    });
    expect(await tools.configure(manual)).toMatchObject({
      available: true,
      directory: manual,
      configuredDirectory: manual,
    });
    const reopened = new PlaygroundVideoTools(root, { PATH: second }, runner as never);
    await reopened.open();
    expect(await reopened.status()).toMatchObject({ directory: manual });
    expect(await reopened.configure(null)).toMatchObject({
      directory: second,
      configuredDirectory: null,
    });
  });

  it('rejects missing FFprobe and invalid overrides without persisting them', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lc-video-tools-'));
    roots.push(root);
    const runner = fakeRunner();
    runner.mockImplementation(async (file, args) => {
      if (path.basename(file).startsWith('ffprobe')) throw new Error('missing');
      if (args.includes('-version')) return { stdout: 'ffmpeg version 7.1', stderr: '' };
      throw new Error('unexpected');
    });
    const tools = new PlaygroundVideoTools(root, { PATH: path.join(root, 'one') }, runner as never);
    expect(await tools.status()).toMatchObject({ available: false });
    await expect(tools.configure(path.join(root, 'manual'))).rejects.toThrow(/ffprobe/i);
    expect((await tools.status()).configuredDirectory).toBeNull();
    await expect(tools.configure('relative')).rejects.toThrow(/absolute/);
  });

  it('persists bounded defaults, preserves them across directory changes and enforces overrides on select and transport', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lc-video-prefs-'));
    roots.push(root);
    const file = path.join(root, 'clip.mp4');
    await writeFile(file, Buffer.alloc(2 * 1024 * 1024));
    const runner = fakeRunner();
    const tools = new PlaygroundVideoTools(root, { PATH: path.join(root, 'bin') }, runner as never);
    const custom = {
      fps: 8,
      timestampIntervalMs: 2000,
      maxClipSizeMiB: 3,
      maxClipDurationSeconds: 10,
    };
    expect(await tools.configurePreferences(custom)).toMatchObject({ preferences: custom });
    expect((await tools.status(true)).preferences).toEqual(custom);
    const reopened = new PlaygroundVideoTools(
      root,
      { PATH: path.join(root, 'bin') },
      runner as never,
    );
    await reopened.open();
    expect(reopened.preferences).toEqual(custom);
    await reopened.configure(path.join(root, 'new-bin'));
    expect(reopened.preferences).toEqual(custom);
    await expect(reopened.select(file, { ...custom, maxClipSizeMiB: 1 })).rejects.toThrow(/1 MiB/);
    const selected = await reopened.select(file, custom);
    await expect(
      reopened.encoded(selected.token, { ...custom, maxClipSizeMiB: 1 }),
    ).rejects.toThrow(/changed/);
    await expect(
      reopened.encoded(selected.token, { ...custom, maxClipDurationSeconds: 3 }),
    ).rejects.toThrow(/changed/);
    expect((await reopened.encoded(selected.token, custom)).length).toBeGreaterThan(2_000_000);
    // Omitting a Playground override must use the newest saved defaults, both
    // when selecting a new clip and when submitting an earlier selection.
    await reopened.configurePreferences({ ...custom, maxClipDurationSeconds: 3 });
    await expect(reopened.select(file)).rejects.toThrow(/at most 3 seconds/);
    await expect(reopened.encoded(selected.token)).rejects.toThrow(/changed/);
    await reopened.configurePreferences({ ...custom, maxClipSizeMiB: 1 });
    await expect(reopened.select(file)).rejects.toThrow(/1 MiB/);
    await reopened.configurePreferences(custom);
    const next = await reopened.select(file);
    expect(await reopened.encoded(next.token)).toBe(await reopened.encoded(selected.token));
    expect(() => validateNativeVideoPreferences({ ...custom, fps: 0 })).toThrow(/fps/);
    expect(() => validateNativeVideoPreferences({ ...custom, timestampIntervalMs: 275 })).toThrow(
      /timestampIntervalMs/,
    );
    expect(() => validateNativeVideoPreferences({ ...custom, maxClipSizeMiB: 501 })).toThrow(
      /maxClipSizeMiB/,
    );
    expect(() => validateNativeVideoPreferences({ ...custom, unknown: 1 })).toThrow(/Unexpected/);
    expect(DEFAULT_NATIVE_VIDEO_PREFERENCES).toMatchObject({ fps: 4, maxClipSizeMiB: 20 });
  });

  it('retains only an opaque token, bounds clips and never exposes file paths', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lc-video-tools-'));
    roots.push(root);
    const file = path.join(root, 'recorded.webm');
    await writeFile(file, Buffer.from('example video container bytes'));
    const runner = fakeRunner();
    const tools = new PlaygroundVideoTools(root, { PATH: path.join(root, 'one') }, runner as never);
    const selection = await tools.select(file);
    expect(selection.name).toBe('recorded.webm');
    expect(selection.durationSeconds).toBe(4);
    expect(JSON.stringify(selection)).not.toContain(root);
    expect(await tools.encoded(selection.token)).toBe(
      Buffer.from('example video container bytes').toString('base64'),
    );
    await expect(tools.encoded('other-token')).rejects.toThrow(/expired/);
    await writeFile(file, Buffer.from('changed'));
    await expect(tools.encoded(selection.token)).rejects.toThrow(/changed/);
  });
});
