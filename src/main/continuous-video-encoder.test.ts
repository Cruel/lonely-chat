import { describe, expect, it, vi } from 'vitest';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ffmpegNativeVideoEncoder } from './continuous-video-encoder';
import { selectContinuousVideoWindow } from './continuous-video-window';

const jpeg = 'data:image/jpeg;base64,/9j/';
const window = selectContinuousVideoWindow(
  [
    {
      sourceId: 'recording',
      observedAt: 1000,
      mediaTimeMs: 10000,
      width: 8,
      height: 8,
      dataUrl: jpeg,
    },
    {
      sourceId: 'recording',
      observedAt: 1200,
      mediaTimeMs: 10500,
      width: 8,
      height: 8,
      dataUrl: jpeg,
    },
  ],
  0,
  1200,
)!;

describe('bounded native-video encoding', () => {
  it('gives FFmpeg only the selected frames, preserves media durations and cleans private temp data', async () => {
    let directory = '';
    let manifest = '';
    const runner = vi.fn(async (_file: string, args: string[]) => {
      const source = args[args.indexOf('-i') + 1];
      directory = path.dirname(source);
      manifest = await readFile(source, 'utf8');
      await writeFile(args.at(-1)!, 'synthetic clip');
    });
    const result = await ffmpegNativeVideoEncoder('/test/ffmpeg', runner).encode(
      window,
      new AbortController().signal,
    );
    expect(Buffer.from(result, 'base64').toString()).toBe('synthetic clip');
    expect(manifest).toContain('duration 0.500');
    expect(manifest).toContain('frame-001.jpg');
    expect(runner).toHaveBeenCalledOnce();
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never starts the encoder for an aborted generation', async () => {
    const runner = vi.fn(async () => {});
    const controller = new AbortController();
    controller.abort();
    await expect(
      ffmpegNativeVideoEncoder('/test/ffmpeg', runner).encode(window, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(runner).not.toHaveBeenCalled();
  });
});
