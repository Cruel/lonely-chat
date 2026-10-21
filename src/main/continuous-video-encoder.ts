import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ContinuousVideoWindow } from './continuous-video-window';

const run = promisify(execFile);
const MAX_CLIP_BYTES = 16 * 1024 * 1024;
const MAX_FRAME_BYTES = 3 * 1024 * 1024;
const MIN_FRAME_DURATION_MS = 40;

export interface NativeVideoEncoder {
  encode(window: ContinuousVideoWindow, signal: AbortSignal): Promise<string>;
}

/**
 * Encodes only the selected window, never a backing recorded-media file or
 * unbounded live stream. FFmpeg's concat demuxer consumes explicit per-frame
 * durations from capture/media timestamps. The final frame is repeated to
 * preserve its exposure duration. No raw frame bytes enter command arguments.
 */
export function ffmpegNativeVideoEncoder(
  executable: string,
  execute: (
    file: string,
    args: string[],
    options: { signal: AbortSignal; timeout: number; windowsHide: boolean; maxBuffer: number },
  ) => Promise<unknown> = (file, args, options) => run(file, args, options),
): NativeVideoEncoder {
  return {
    async encode(window, signal) {
      if (signal.aborted) throw new DOMException('Video encoding cancelled.', 'AbortError');
      if (
        !window.frames.length ||
        window.frames.length > 32 ||
        window.frames.length !== window.timeline.length ||
        window.throughMs - window.fromMs > 60_000
      )
        throw new Error('Invalid bounded native-video window.');
      const directory = await mkdtemp(path.join(tmpdir(), 'lonely-chat-video-'));
      try {
        const names: string[] = [];
        for (let index = 0; index < window.frames.length; index++) {
          if (signal.aborted) throw new DOMException('Video encoding cancelled.', 'AbortError');
          const data = Buffer.from(
            window.frames[index].dataUrl.slice('data:image/jpeg;base64,'.length),
            'base64',
          );
          if (!data.length || data.byteLength > MAX_FRAME_BYTES)
            throw new Error('Native-video frame exceeds its encoded size limit.');
          const name = `frame-${String(index).padStart(3, '0')}.jpg`;
          await writeFile(path.join(directory, name), data, { mode: 0o600 });
          names.push(name);
        }
        const commands: string[] = ['ffconcat version 1.0'];
        for (let index = 0; index < names.length; index++) {
          const delta =
            index + 1 < window.timeline.length
              ? window.timeline[index + 1].outputOffsetMs - window.timeline[index].outputOffsetMs
              : MIN_FRAME_DURATION_MS;
          if (!Number.isFinite(delta) || delta < 0 || delta > 60_000)
            throw new Error('Native-video timestamps are discontinuous.');
          commands.push(
            `file '${names[index]}'`,
            `duration ${(Math.max(MIN_FRAME_DURATION_MS, delta) / 1000).toFixed(3)}`,
          );
        }
        commands.push(`file '${names[names.length - 1]}'`);
        const manifest = path.join(directory, 'frames.ffconcat');
        const target = path.join(directory, 'clip.mp4');
        await writeFile(manifest, commands.join('\n') + '\n', { mode: 0o600 });
        await execute(
          executable,
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-nostdin',
            '-y',
            '-safe',
            '0',
            '-f',
            'concat',
            '-i',
            manifest,
            '-an',
            '-vf',
            'pad=ceil(iw/2)*2:ceil(ih/2)*2',
            '-c:v',
            'libx264',
            '-pix_fmt',
            'yuv420p',
            '-vsync',
            'vfr',
            '-movflags',
            '+faststart',
            target,
          ],
          { signal, timeout: 30_000, windowsHide: true, maxBuffer: 8192 },
        );
        if (signal.aborted) throw new DOMException('Video encoding cancelled.', 'AbortError');
        const result = await stat(target);
        if (!result.isFile() || result.size === 0 || result.size > MAX_CLIP_BYTES)
          throw new Error('Native-video clip exceeds its size limit.');
        return (await readFile(target)).toString('base64');
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
