/** Private desktop-only model discovery data; never transmitted to the browser overlay. */
export type ModelRole = 'vision-language' | 'speech-to-text';

export interface ModelFile {
  readonly path: string;
  /** Unknown when the Hub does not provide a trustworthy file size. */
  readonly sizeBytes: number | null;
  /** SHA-256 provided by Hugging Face LFS metadata, when present. */
  readonly sha256?: string;
}

export interface ModelCandidate {
  /** Stable within a repository and revision; a multipart model has one ID. */
  readonly id: string;
  readonly role: ModelRole;
  readonly format: 'gguf' | 'whisper-ggml';
  readonly quantization: string | null;
  readonly sizeBytes: number | null;
  readonly files: readonly ModelFile[];
  readonly compatibleProjectorIds: readonly string[];
  /** Only automatically selected for one unambiguous matching projector. */
  readonly suggestedProjectorId: string | null;
}

export interface ModelProjector {
  readonly id: string;
  readonly quantization: string | null;
  readonly sizeBytes: number | null;
  readonly files: readonly ModelFile[];
}

export interface ModelDiscoveryResult {
  readonly repo: string;
  readonly revision: string;
  readonly role: ModelRole | 'mixed';
  readonly candidates: readonly ModelCandidate[];
  readonly projectors: readonly ModelProjector[];
  readonly preselectedCandidateId: string | null;
  readonly preselectedProjectorId: string | null;
  readonly warnings: readonly string[];
}
