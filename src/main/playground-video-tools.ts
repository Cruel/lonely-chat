import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, stat, writeFile, rename, mkdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';

import {
  DEFAULT_NATIVE_VIDEO_PREFERENCES,
  validateNativeVideoPreferences,
  type NativeVideoPreferences,
  type VideoToolsStatus,
  type PlaygroundVideoSelection,
} from '../shared/video-tools-contract';

const exec = promisify(execFile);
const TOOL_TIMEOUT_MS = 5000;

/** Only the trusted main process retains source paths; requests carry expiring opaque tokens. */
export class PlaygroundVideoTools {
  private configuredDirectory: string | null = null;
  private videoPreferences: NativeVideoPreferences = DEFAULT_NATIVE_VIDEO_PREFERENCES;

  get preferences(): NativeVideoPreferences {
    return { ...this.videoPreferences };
  }
  private detected: VideoToolsStatus | null = null;
  private selections = new Map<
    string,
    { path: string; detail: PlaygroundVideoSelection; expiresAt: number }
  >();

  constructor(
    private readonly userData: string,
    private readonly environment = process.env,
    private readonly run: typeof exec = exec,
  ) {}

  get directory(): string | null {
    return this.detected?.directory ?? null;
  }

  async open(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(
        await readFile(path.join(this.userData, 'ffmpeg.json'), 'utf8'),
      );
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        if (record.preferences !== undefined) {
          try {
            this.videoPreferences = validateNativeVideoPreferences(record.preferences);
          } catch {
            /* Use safe defaults if configuration was corrupted. */
          }
        }
        const directory = record.directory;
        if (typeof directory === 'string' && path.isAbsolute(directory) && directory.length <= 4096)
          this.configuredDirectory = directory;
      }
    } catch {
      // First start or corrupt optional configuration: continue using PATH.
    }
  }

  async configure(directory: string | null): Promise<VideoToolsStatus> {
    if (directory !== null && (!path.isAbsolute(directory) || directory.length > 4096))
      throw new Error('FFmpeg directory must be an absolute path.');
    const previous = this.configuredDirectory;
    this.configuredDirectory = directory;
    this.detected = null;
    const detected = await this.status();
    if (directory !== null && !detected.available) {
      this.configuredDirectory = previous;
      this.detected = null;
      throw new Error(
        detected.error ?? 'Directory must contain working ffmpeg and ffprobe executables.',
      );
    }
    await this.save();
    this.selections.clear();
    return detected;
  }

  private async save(): Promise<void> {
    await mkdir(this.userData, { recursive: true });
    const file = path.join(this.userData, 'ffmpeg.json');
    const temp = file + '.tmp';
    await writeFile(
      temp,
      JSON.stringify({ directory: this.configuredDirectory, preferences: this.videoPreferences }),
      { mode: 0o600 },
    );
    await rename(temp, file);
  }

  async configurePreferences(value: unknown): Promise<VideoToolsStatus> {
    const next = validateNativeVideoPreferences(value);
    const previous = this.videoPreferences;
    this.videoPreferences = next;
    try {
      await this.save();
    } catch (error) {
      this.videoPreferences = previous;
      throw error;
    }
    if (this.detected) this.detected = { ...this.detected, preferences: this.preferences };
    return this.status();
  }

  async status(refresh = false): Promise<VideoToolsStatus> {
    if (this.detected && !refresh) return this.detected;
    const dirs = this.configuredDirectory
      ? [this.configuredDirectory]
      : [
          ...(this.environment.PATH ?? this.environment.Path ?? '').split(path.delimiter),
          ...(process.platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : []),
          ...(process.platform === 'linux' ? ['/usr/bin', '/usr/local/bin'] : []),
        ];
    for (const directory of new Set(dirs.filter((part) => part && path.isAbsolute(part)))) {
      const executable = path.join(
        directory,
        process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
      );
      const probe = path.join(directory, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
      try {
        const [a, b] = await Promise.all([
          this.run(executable, ['-version'], {
            timeout: TOOL_TIMEOUT_MS,
            windowsHide: true,
            maxBuffer: 8192,
          }),
          this.run(probe, ['-version'], {
            timeout: TOOL_TIMEOUT_MS,
            windowsHide: true,
            maxBuffer: 8192,
          }),
        ]);
        if (!a.stdout.startsWith('ffmpeg version') || !b.stdout.startsWith('ffprobe version'))
          continue;
        return (this.detected = {
          available: true,
          preferences: this.preferences,
          directory,
          configuredDirectory: this.configuredDirectory,
          version: a.stdout.split(/\r?\n/, 1)[0].slice(0, 160),
          error: null,
        });
      } catch {
        // Not a usable paired installation.
      }
    }
    return (this.detected = {
      available: false,
      preferences: this.preferences,
      directory: null,
      configuredDirectory: this.configuredDirectory,
      version: null,
      error: this.configuredDirectory
        ? 'Selected directory does not contain working ffmpeg and ffprobe executables.'
        : 'Install FFmpeg and FFprobe together or configure their directory in Settings.',
    });
  }

  /** Probe selected clips without decoding or transcoding them. */
  async select(
    filePath: string,
    limits: NativeVideoPreferences = this.preferences,
  ): Promise<PlaygroundVideoSelection> {
    const config = validateNativeVideoPreferences(limits);
    const tools = await this.status();
    if (!tools.available || !tools.directory) throw new Error(tools.error ?? 'FFmpeg unavailable.');
    const metadata = await stat(filePath);
    if (
      !metadata.isFile() ||
      metadata.size <= 0 ||
      metadata.size > config.maxClipSizeMiB * 1024 * 1024
    )
      throw new Error(
        `Native video clips must be nonempty files no larger than ${config.maxClipSizeMiB} MiB.`,
      );
    const probe = path.join(
      tools.directory,
      process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe',
    );
    const { stdout } = await this.run(
      probe,
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=codec_type:format=duration',
        '-of',
        'json',
        filePath,
      ],
      { timeout: TOOL_TIMEOUT_MS, windowsHide: true, maxBuffer: 16384 },
    );
    const parsed = JSON.parse(stdout) as {
      streams?: Array<{ codec_type?: string }>;
      format?: { duration?: string };
    };
    const seconds = Number(parsed.format?.duration);
    if (
      !parsed.streams?.some((stream) => stream.codec_type === 'video') ||
      !Number.isFinite(seconds) ||
      seconds <= 0 ||
      seconds > config.maxClipDurationSeconds
    )
      throw new Error(
        `Choose a decodable video clip with a duration of at most ${config.maxClipDurationSeconds} seconds.`,
      );
    const detail = {
      token: randomUUID(),
      name: path.basename(filePath).slice(0, 160),
      sizeBytes: metadata.size,
      durationSeconds: seconds,
    };
    for (const [key, value] of this.selections) {
      if (value.expiresAt < Date.now()) this.selections.delete(key);
    }
    if (this.selections.size >= 8) this.selections.delete(this.selections.keys().next().value!);
    this.selections.set(detail.token, {
      path: filePath,
      detail,
      expiresAt: Date.now() + 15 * 60_000,
    });
    return detail;
  }

  async encoded(token: string, limits: NativeVideoPreferences = this.preferences): Promise<string> {
    const config = validateNativeVideoPreferences(limits);
    const selection = this.selections.get(token);
    if (!selection || Date.now() > selection.expiresAt)
      throw new Error('Video selection expired. Choose the clip again.');
    const metadata = await stat(selection.path);
    if (
      !metadata.isFile() ||
      metadata.size <= 0 ||
      metadata.size > config.maxClipSizeMiB * 1024 * 1024 ||
      selection.detail.durationSeconds > config.maxClipDurationSeconds ||
      metadata.size !== selection.detail.sizeBytes
    )
      throw new Error('Selected video changed. Choose the clip again.');
    return (await readFile(selection.path)).toString('base64');
  }
}
