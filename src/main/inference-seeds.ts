import { createHash, randomInt } from 'node:crypto';

export const MAX_INFERENCE_SEED = 0x7fffffff;

/** Seeds are llama.cpp-compatible signed 31-bit nonnegative integers. */
export function validInferenceSeed(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    typeof value === 'number' &&
    value >= 0 &&
    value <= MAX_INFERENCE_SEED
  );
}

export function randomInferenceSeed(): number {
  return randomInt(MAX_INFERENCE_SEED + 1);
}

/**
 * Domain-separated, deterministic operation seeds. Adding the attempt after hashing
 * guarantees distinct seeds for retries of the same operation, even at wraparound.
 * This controls sampling, not capture timing or the chat scheduler.
 */
export function deriveInferenceSeed(
  sessionSeed: number,
  operation: 'roster' | 'cycle',
  operationIndex: number,
  attempt: number,
): number {
  if (
    !validInferenceSeed(sessionSeed) ||
    !Number.isSafeInteger(operationIndex) ||
    operationIndex < 0 ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1 ||
    attempt > MAX_INFERENCE_SEED
  ) {
    throw new Error('Invalid inference seed derivation.');
  }
  const hash =
    createHash('sha256')
      .update(`lonely-chat/v1:${sessionSeed}:${operation}:${operationIndex}`)
      .digest()
      .readUInt32BE(0) & MAX_INFERENCE_SEED;
  return (hash + attempt - 1) % (MAX_INFERENCE_SEED + 1);
}
