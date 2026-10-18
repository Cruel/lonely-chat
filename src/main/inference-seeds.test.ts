import { describe, expect, it } from 'vitest';
import {
  deriveInferenceSeed,
  MAX_INFERENCE_SEED,
  randomInferenceSeed,
  validInferenceSeed,
} from './inference-seeds';

describe('per-operation model sampling seeds', () => {
  it('generates valid explicit effective seeds even when unspecified', () => {
    for (let index = 0; index < 100; index++) {
      const seed = randomInferenceSeed();
      expect(validInferenceSeed(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThanOrEqual(MAX_INFERENCE_SEED);
    }
    for (const seed of [-1, MAX_INFERENCE_SEED + 1, 1.5, NaN, Infinity, null, '123']) {
      expect(validInferenceSeed(seed)).toBe(false);
    }
    expect(validInferenceSeed(0)).toBe(true);
  });

  it('derives repeatable, distinct attempt seeds independent of scheduling and native worker state', () => {
    for (const base of [0, 42, MAX_INFERENCE_SEED]) {
      const roster = [1, 2, 3].map((attempt) => deriveInferenceSeed(base, 'roster', 0, attempt));
      const cycle1 = [1, 2, 3].map((attempt) => deriveInferenceSeed(base, 'cycle', 1, attempt));
      const cycle2 = deriveInferenceSeed(base, 'cycle', 2, 1);
      expect(new Set(roster).size).toBe(3);
      expect(new Set(cycle1).size).toBe(3);
      expect(cycle1[0]).not.toBe(cycle2);
      expect(roster[0]).not.toBe(cycle1[0]);
      expect(deriveInferenceSeed(base, 'cycle', 1, 2)).toBe(cycle1[1]);
    }
  });
});
