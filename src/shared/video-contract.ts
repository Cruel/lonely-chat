/** Maximum decoded frame bounds; actual capture dimensions preserve source aspect ratio. */
export const MAX_SIMULATION_FRAME_WIDTH = 1920;
export const MAX_SIMULATION_FRAME_HEIGHT = 1080;
/** Under the 2 MiB raw JPEG archival limit after base64 decoding. */
export const MAX_SIMULATION_FRAME_DATA_URL = 2_700_000;

/** Video bytes stay on the privileged desktop channel; never exposed by the overlay. */
export interface VideoSource {
  readonly id: string;
  readonly label: string;
  readonly kind: 'camera' | 'screen' | 'window';
}

export interface VideoFrame {
  readonly sourceId: string;
  readonly observedAt: number;
  readonly width: number;
  readonly height: number;
  readonly dataUrl: string;
  /** Original media presentation position for recorded video; observation time remains authoritative. */
  readonly mediaTimeMs?: number;
}
