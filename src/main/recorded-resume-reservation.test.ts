import { describe, expect, it } from 'vitest';
import { RecordedResumeReservation } from './recorded-resume-reservation';

describe('Recorded Resume model-ownership reservation', () => {
  it('rejects a running Playground before decoders resume', () => {
    const lock = new RecordedResumeReservation();
    expect(() => lock.prepare(true, true)).toThrow(/Finish Playground/);
    expect(lock.reserved).toBe(false);
    expect(() => lock.commit(false)).toThrow(/Prepare Recorded Resume/);
  });

  it('blocks new Playground starts from prepare through commit, and clears on cancellation', () => {
    const lock = new RecordedResumeReservation();
    expect(() => lock.prepare(false, false)).toThrow(/not paused/);
    lock.prepare(true, false);
    expect(lock.reserved).toBe(true);
    expect(() => lock.prepare(true, false)).toThrow(/already in progress/);
    lock.cancel();
    expect(lock.reserved).toBe(false);
    lock.prepare(true, false);
    expect(() => lock.commit(true)).toThrow(/Finish Playground/);
    expect(lock.reserved).toBe(false);
    lock.prepare(true, false);
    lock.commit(false);
    expect(lock.reserved).toBe(false);
    expect(() => lock.commit(false)).toThrow(/Prepare Recorded Resume/);
  });
});
