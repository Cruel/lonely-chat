import type { ModelRole } from './model-contract';

export interface InstalledModelFile {
  readonly path: string;
  /** Relative to this installation's managed directory, never an arbitrary filesystem path. */
  readonly relativePath: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface InstalledModel {
  readonly id: string;
  readonly repo: string;
  readonly revision: string;
  readonly candidateId: string;
  readonly projectorId: string | null;
  readonly role: ModelRole;
  readonly files: readonly InstalledModelFile[];
  readonly installedAt: number;
  /** Standalone GGUF installed for reuse as a projector, not a selectable inference model. */
  readonly projectorOnly?: boolean;
}

export interface InstallProgress {
  readonly phase: 'idle' | 'downloading' | 'verifying';
  readonly file: string | null;
  readonly receivedBytes: number;
  readonly totalBytes: number | null;
}

export interface ModelManagerSnapshot {
  readonly storageDirectory: string;
  readonly installations: readonly InstalledModel[];
  readonly active: Readonly<Record<ModelRole, string | null>>;
  readonly progress: InstallProgress;
  /** Overrides for installed model IDs. null means explicitly text-only. */
  readonly projectorAssignments?: Readonly<Record<string, string | null>>;
}

/** A reference to another installed GGUF, a bundled companion, or no projector. */
export type ProjectorAssignment = string | 'bundled' | null;

export interface ModelInstallRequest {
  readonly source: string;
  readonly candidateId: string;
  /** 'none' opts into text-only operation even when visual projectors are present. */
  readonly projectorId: string | null;
  /** Reuse an existing verified GGUF without downloading its bytes again. */
  readonly installedProjectorId?: string;
}
