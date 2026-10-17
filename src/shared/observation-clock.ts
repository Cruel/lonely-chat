/** Epoch-shaped timestamps on a monotonic timeline. Never re-read the calendar clock.
 * performance.timeOrigin is fixed for the process. Main owns this timeline;
 * renderer capture aligns to it using the video-selection IPC clock anchor.
 */
export function observationNow(): number {
  return performance.timeOrigin + performance.now();
}
