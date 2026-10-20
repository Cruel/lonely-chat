/** Native-video defaults and strict bounds for user preferences and desktop IPC. */
export interface NativeVideoPreferences {
  readonly fps: number;
  readonly timestampIntervalMs: number;
  readonly maxClipSizeMiB: number;
  readonly maxClipDurationSeconds: number;
}
export const DEFAULT_NATIVE_VIDEO_PREFERENCES: NativeVideoPreferences = {
  fps: 4,
  timestampIntervalMs: 5000,
  maxClipSizeMiB: 20,
  maxClipDurationSeconds: 15,
};
export const NATIVE_VIDEO_LIMITS = {
  fps: { min: 1, max: 16, step: 1 },
  timestampIntervalMs: { min: 250, max: 60000, step: 250 },
  maxClipSizeMiB: { min: 1, max: 500, step: 1 },
  maxClipDurationSeconds: { min: 1, max: 300, step: 1 },
} as const;
export function validateNativeVideoPreferences(value: unknown): NativeVideoPreferences {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid native video preferences.');
  const data = value as Record<string, unknown>;
  const keys = Object.keys(NATIVE_VIDEO_LIMITS);
  if (
    Object.keys(data).length !== keys.length ||
    Object.keys(data).some((key) => !keys.includes(key))
  )
    throw new Error('Unexpected native video preference fields.');
  const result: Record<string, number> = {};
  for (const key of keys) {
    const bounds = NATIVE_VIDEO_LIMITS[key as keyof NativeVideoPreferences];
    const number = data[key];
    if (
      typeof number !== 'number' ||
      !Number.isInteger(number) ||
      number < bounds.min ||
      number > bounds.max ||
      (number - bounds.min) % bounds.step !== 0
    )
      throw new Error(
        `Invalid native video ${key} (expected ${bounds.min}–${bounds.max}, step ${bounds.step}).`,
      );
    result[key] = number;
  }
  return result as unknown as NativeVideoPreferences;
}
/** Optional host dependency; never bundled with Lonely Chat. */
export interface VideoToolsStatus {
  readonly available: boolean;
  readonly directory: string | null;
  readonly configuredDirectory: string | null;
  readonly version: string | null;
  readonly error: string | null;
  readonly preferences: NativeVideoPreferences;
}

/** Opaque, short-lived selection. The source path never enters renderer IPC. */
export interface PlaygroundVideoSelection {
  readonly token: string;
  readonly name: string;
  readonly durationSeconds: number;
  readonly sizeBytes: number;
}
