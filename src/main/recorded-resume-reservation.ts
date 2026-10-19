/** Atomic IPC-side lock across the renderer's decoder-resume interval.
 * Session inference stays paused until the final resume commit.
 * A Stop or decoder failure must release the lock.
 */
export class RecordedResumeReservation {
  private active = false;

  get reserved(): boolean {
    return this.active;
  }

  prepare(paused: boolean, experimentBusy: boolean): void {
    if (this.active) throw new Error('Recorded Resume is already in progress.');
    if (!paused) throw new Error('Recorded Simulation is not paused.');
    if (experimentBusy)
      throw new Error('Finish Playground experiments before resuming Recorded Simulation.');
    this.active = true;
  }

  cancel(): void {
    this.active = false;
  }

  commit(experimentBusy: boolean): void {
    if (!this.active) throw new Error('Prepare Recorded Resume before restarting media.');
    this.active = false;
    if (experimentBusy)
      throw new Error('Finish Playground experiments before resuming Recorded Simulation.');
  }
}
