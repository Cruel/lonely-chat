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
