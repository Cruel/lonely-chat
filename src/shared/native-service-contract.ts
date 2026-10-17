/** Private diagnostics; the public overlay never receives native worker lifecycle data. */
export type NativeServicePhase = 'stopped' | 'loading' | 'ready' | 'failed';

export interface NativeServiceStatus {
  readonly revision: number;
  readonly phase: NativeServicePhase;
  readonly error: string | null;
}
