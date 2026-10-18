/** Private desktop diagnostics, never exposed by the public overlay. */
export interface PrivateWorkerLine {
  readonly worker: string;
  readonly stream: 'stdout' | 'stderr';
  readonly line: string;
}

export interface DiagnosticStatus {
  readonly enabled: boolean;
  readonly samples: number;
  readonly workerLines: number;
  readonly bytes: number;
  readonly dropped: number;
}
