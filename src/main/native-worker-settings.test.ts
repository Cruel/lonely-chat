import { expect, it } from 'vitest';
import { DEFAULT_PREFERENCES } from '../shared/session-contract';
import { nativeWorkerSettings } from './native-worker-settings';

it('uses the current stopped preferences for Playground, not the prior frozen Run', () => {
  let current = { ...DEFAULT_PREFERENCES, computeBackend: 'cpu' as const, contextTokens: 4096 };
  let run = { ...DEFAULT_PREFERENCES, computeBackend: 'cuda' as const, contextTokens: 8192 };
  const source = {
    getPreferences: () => current,
    getRunPreferences: () => run,
  };
  current = {
    ...current,
    contextTokens: 16384,
    reasoningEnabled: true,
    inferenceTimeoutMs: 120000,
  };
  const simulation = nativeWorkerSettings(source, 'simulation');
  const playground = nativeWorkerSettings(source, 'playground');
  expect(simulation()).toMatchObject({ computeBackend: 'cuda', contextTokens: 8192 });
  expect(playground()).toMatchObject({
    computeBackend: 'cpu',
    contextTokens: 16384,
    reasoningEnabled: true,
    inferenceTimeoutMs: 120000,
  });
  current = { ...current, contextTokens: 2048, reasoningEnabled: false };
  run = { ...run, contextTokens: 4096 };
  expect(playground().contextTokens).toBe(16384);
  expect(playground().reasoningEnabled).toBe(true);
  expect(simulation().contextTokens).toBe(4096);
});
