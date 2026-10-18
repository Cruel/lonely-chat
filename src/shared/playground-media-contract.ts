/**
 * Ephemeral JPEG snapshots for desktop-only one-shot requests.
 * Source media never crosses IPC; only explicitly selected decoded frames do.
 */
export interface PlaygroundFrame {
  readonly sourceId: string;
  readonly width: number;
  readonly height: number;
  readonly dataUrl: string;
  /** Video playback timestamp; absent for imported still images. */
  readonly mediaTimeMs?: number;
}

export const MAX_PLAYGROUND_FRAMES = 8;
export const MAX_PLAYGROUND_FRAME_DATA_URL = 120_000;
export const MAX_PLAYGROUND_SOURCE_VIDEO_BYTES = 512 * 1024 * 1024;
export const MAX_PLAYGROUND_VIDEO_DURATION_SECONDS = 2 * 60 * 60;

const JPEG_URL = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/;

/** Validate actual JPEG dimensions, not just the renderer-provided width/height. */
function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 10 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let at = 2;
  while (at < bytes.length - 3) {
    if (bytes[at++] !== 0xff) return null;
    while (bytes[at] === 0xff) at++;
    const marker = bytes[at++];
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (at + 2 > bytes.length) return null;
    const size = (bytes[at] << 8) | bytes[at + 1];
    if (size < 2 || at + size > bytes.length) return null;
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      if (size < 7 || bytes[at + 2] !== 8) return null;
      return {
        height: (bytes[at + 3] << 8) | bytes[at + 4],
        width: (bytes[at + 5] << 8) | bytes[at + 6],
      };
    }
    at += size;
  }
  return null;
}

export function validatePlaygroundFrames(value: unknown): PlaygroundFrame[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_PLAYGROUND_FRAMES)
    throw new Error(`Choose at most ${MAX_PLAYGROUND_FRAMES} Playground frames.`);
  let total = 0;
  return value.map((item: unknown, index) => {
    const fail = (message: string): never => {
      throw new Error(`Selected frame ${index + 1}: ${message}`);
    };
    if (!item || typeof item !== 'object' || Array.isArray(item))
      return fail('invalid frame data.');
    const frame = item as Record<string, unknown>;
    if (
      Object.keys(frame).some(
        (key) => !['sourceId', 'width', 'height', 'dataUrl', 'mediaTimeMs'].includes(key),
      )
    )
      return fail('unexpected frame fields.');
    if (typeof frame.sourceId !== 'string' || !frame.sourceId.trim() || frame.sourceId.length > 100)
      return fail('invalid source label.');
    if (
      !Number.isSafeInteger(frame.width) ||
      !Number.isSafeInteger(frame.height) ||
      (frame.width as number) < 1 ||
      (frame.width as number) > 640 ||
      (frame.height as number) < 1 ||
      (frame.height as number) > 360
    )
      return fail('dimensions must be 1–640 × 1–360 pixels.');
    if (
      frame.mediaTimeMs !== undefined &&
      (typeof frame.mediaTimeMs !== 'number' ||
        !Number.isFinite(frame.mediaTimeMs) ||
        frame.mediaTimeMs < 0 ||
        frame.mediaTimeMs > MAX_PLAYGROUND_VIDEO_DURATION_SECONDS * 1000)
    )
      return fail('invalid video timestamp.');
    if (typeof frame.dataUrl !== 'string' || frame.dataUrl.length > MAX_PLAYGROUND_FRAME_DATA_URL)
      return fail('JPEG is too large; reduce source resolution or image complexity.');
    const match = JPEG_URL.exec(frame.dataUrl);
    if (!match || match[1].length % 4 === 1) return fail('expected a JPEG data URL.');
    const bytes = Buffer.from(match[1], 'base64');
    if (
      bytes.toString('base64') !== match[1] ||
      bytes[bytes.length - 2] !== 0xff ||
      bytes[bytes.length - 1] !== 0xd9
    )
      return fail('JPEG data is incomplete or incorrectly encoded.');
    const dimensions = jpegDimensions(bytes);
    if (!dimensions || dimensions.width !== frame.width || dimensions.height !== frame.height)
      return fail('JPEG could not be verified or reported dimensions do not match.');
    total += frame.dataUrl.length;
    if (total > MAX_PLAYGROUND_FRAMES * MAX_PLAYGROUND_FRAME_DATA_URL)
      return fail('combined media is too large.');
    return {
      sourceId: frame.sourceId,
      width: frame.width as number,
      height: frame.height as number,
      dataUrl: frame.dataUrl,
      ...(frame.mediaTimeMs === undefined ? {} : { mediaTimeMs: frame.mediaTimeMs as number }),
    };
  });
}
