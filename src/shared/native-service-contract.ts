/** Private diagnostics; the public overlay never receives native worker lifecycle data. */
export type NativeServicePhase = 'stopped' | 'loading' | 'ready' | 'failed';

export interface NativeRuntimeResources {
  readonly backend: 'cpu' | 'cuda' | 'vulkan' | 'metal';
  readonly availableBackends: readonly ('cpu' | 'cuda' | 'vulkan' | 'metal')[];
  readonly cpuThreads: number;
  readonly contextTokens: number;
  readonly gpuOffloadLayers: number;
  readonly ramTargetMiB: number;
  readonly vramTargetMiB: number;
  readonly gpuComputeTargetPercent: number;
  readonly workerRamMiB: number | null;
  readonly diagnostic: string | null;
}

export interface NativeServiceStatus {
  readonly revision: number;
  readonly phase: NativeServicePhase;
  readonly error: string | null;
  readonly resources?: NativeRuntimeResources | null;
}
