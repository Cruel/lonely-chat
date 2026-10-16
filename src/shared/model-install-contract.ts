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
}

export interface ModelInstallRequest {
  readonly source: string;
  readonly candidateId: string;
  /** 'none' opts into text-only operation even when visual projectors are present. */
  readonly projectorId: string | null;
}
