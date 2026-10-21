import { describe, expect, it } from 'vitest';
import { LatestStageResult, StageCadence } from './stage-cadence';

describe('independent stage cadence', () => {
  it('enforces start-to-start minimums without overlapping or catch-up bursts', () => {
    const vision = new StageCadence(1000);
    const chat = new StageCadence(300);
    expect(vision.start(0)).toBe(true);
    expect(chat.start(0)).toBe(true);
    chat.finish();
    expect(chat.start(299)).toBe(false);
    expect(chat.start(300)).toBe(true);
    expect(vision.start(5000)).toBe(false);
    vision.finish();
    expect(vision.start(5000)).toBe(true);
    vision.finish();
    expect(vision.nextDelay(5000)).toBe(1000);
    expect(chat.inFlight).toBe(true);
  });

  it('retains only eligible, ordered, run-specific observations', () => {
    const latest = new LatestStageResult<string>();
    latest.publish('newer', 2000, 1500, 'run1:mediaA');
    latest.publish('late-old', 2100, 1000, 'run1:mediaA');
    expect(latest.eligible(2100, 500, 'run1:mediaA')).toBe('newer');
    expect(latest.eligible(2100, 500, 'run2:mediaA')).toBeNull();
    expect(latest.eligible(2501, 500, 'run1:mediaA')).toBeNull();
    latest.clear();
    expect(latest.eligible(2200, 500, 'run1:mediaA')).toBeNull();
  });
});
