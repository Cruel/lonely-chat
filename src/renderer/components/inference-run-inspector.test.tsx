// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { InferenceRunInspector } from './inference-run-inspector';
import type { TraceAttempt, TraceList } from '../../shared/inference-trace-contract';

afterEach(() => {
  cleanup();
  delete window.lonelyChat;
});

it('fetches private attempt data only after selection and distinguishes each execution stage', async () => {
  const list: TraceList = {
    dropped: 1,
    bytes: 1024,
    attempts: [
      {
        id: 'attempt-7',
        runId: 2,
        cycle: 3,
        attempt: 1,
        seed: 77,
        rosterSeed: 90,
        mode: 'native',
        modelId: 'my-model',
        startedAt: 1700000000000,
        durationMs: 123,
        stage: 'failed',
        errorStage: 'validation',
        error: 'Invalid author',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      },
    ],
  };
  const detail: TraceAttempt = {
    ...list.attempts[0],
    input: {
      boundary: { fromSequence: 0, throughSequence: 1 },
      recentTranscripts: [{ source: 'mic', text: 'hello' }],
    },
    settings: { cycleIntervalMs: 3000 },
    promptPreset: { id: 'preset-1', revision: 2 },
    adaptation: { frameLimit: 4 },
    request: { stream: false, seed: 77 },
    rawResponse: { choices: [] },
    normalized: { messages: [] },
    parsed: null,
    accepted: null,
    scheduled: null,
    transportError: null,
  };
  const get = vi.fn(async () => detail);
  Object.defineProperty(window, 'lonelyChat', {
    configurable: true,
    value: {
      listInferenceTraces: async () => list,
      onInferenceTraces: () => () => {},
      getInferenceTrace: get,
    },
  });
  render(<InferenceRunInspector />);
  expect(get).not.toHaveBeenCalled();
  fireEvent.click(await screen.findByRole('button', { name: /Run 2 · cycle 3 · attempt 1/ }));
  expect(
    await screen.findByRole('region', { name: 'Exact submitted native request' }),
  ).toBeTruthy();
  expect(
    screen.getByRole('region', { name: 'Raw native transport response / fixture result' }),
  ).toBeTruthy();
  expect(
    screen.getByRole('region', { name: 'Normalized output (before validation)' }),
  ).toBeTruthy();
  expect(screen.getByRole('region', { name: 'Final scheduled chat batch' })).toBeTruthy();
  expect(screen.getByText(/Failed at validation/)).toBeTruthy();
  expect(get).toHaveBeenCalledWith('attempt-7');
});
