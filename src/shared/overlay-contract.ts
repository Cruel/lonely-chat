/** Desktop-only overlay status; never exposed by the public overlay HTTP server. */
export const DEFAULT_OVERLAY_PORT = 18080;

export interface OverlayStatus {
  readonly port: number;
  readonly url: string | null;
  readonly error: string | null;
}

export function validateOverlayPort(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error('Overlay port must be an integer from 1 to 65535.');
  }
  return value;
}
