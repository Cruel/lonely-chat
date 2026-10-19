import { describe, expect, it, vi } from 'vitest';
import { AUDIENCE } from './fake-inference';
import { canStartPausedSpeech } from './paused-speech-gate';
import {
  acceptSimulationExecution,
  executeNativeSimulation,
  SimulationExecutionError,
} from './simulation-execution';
import type { AudioStatus } from '../shared/audio-contract';

const input = {
  context: 'campfire',
  cycle: 1,
  chatActivity: 'normal' as const,
  roster: AUDIENCE,
  boundary: { fromSequence: 0, throughSequence: 0, fromMs: 1000, throughMs: 5000 },
};
const normalized = {
  events: [],
  messages: [{ author: 'pixelpilot', text: 'Nice campfire!', color: '#bba5ff', offsetMs: 5100 }],
};
const audio: AudioStatus = {
  revision: 0,
  transcripts: [],
  sources: [
    {
      id: 'mic',
      sourceId: 'recorded:mic',
      label: 'Mic',
      phase: 'ready',
      error: null,
      pendingSegments: 0,
    },
  ],
};

describe('shared native simulation execution seam', () => {
  it('preserves the exact selected request and captures ordered transport stages', async () => {
    const raw = { choices: [{ message: { content: JSON.stringify(normalized) } }] };
    const transport = vi.fn(async () => raw);
    const observer = vi.fn();
    const request = { messages: [{ role: 'user', content: 'Frozen request' }], seed: 234 };
    const result = await executeNativeSimulation(
      input,
      request,
      new AbortController().signal,
      transport,
      () => normalized,
      observer,
    );
    expect(transport).toHaveBeenCalledWith(request, expect.any(AbortSignal));
    expect(observer.mock.calls).toEqual([
      ['request', request],
      ['response', raw],
      ['normalized', normalized],
    ]);
    expect(result).toEqual({ rawNativeOutput: raw, normalizedResult: normalized });
    const { parsed, accepted } = acceptSimulationExecution(input, result.normalizedResult, {
      playbackWindowMs: 3000,
    });
    expect(parsed.messages[0].offsetMs).toBe(5100);
    expect(accepted.messages).toMatchObject([{ author: 'pixelpilot', offsetMs: 3000 }]);
  });

  it('reports a transport failure with no invented response or normalized evidence', async () => {
    const cause = new Error('Connection refused');
    const observer = vi.fn();
    await expect(
      executeNativeSimulation(
        input,
        { seed: 45 },
        new AbortController().signal,
        async () => {
          throw cause;
        },
        (raw) => raw,
        observer,
      ),
    ).rejects.toMatchObject({
      stage: 'transport',
      cause,
      evidence: { rawNativeOutput: null, normalizedResult: null, accepted: null },
    });
    expect(observer.mock.calls.map(([stage]) => stage)).toEqual(['request']);
  });

  it('retains raw response if normalization fails and does not claim acceptance', async () => {
    const raw = { choices: [{ finish_reason: 'length' }] };
    const observer = vi.fn();
    let failure: unknown;
    try {
      await executeNativeSimulation(
        input,
        { seed: 77 },
        new AbortController().signal,
        async () => raw,
        () => {
          throw new Error('Output was truncated');
        },
        observer,
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(SimulationExecutionError);
    expect(failure).toMatchObject({
      stage: 'normalization',
      evidence: {
        rawNativeOutput: raw,
        normalizedResult: null,
        parsedResult: null,
        accepted: null,
      },
    });
    expect(observer.mock.calls.map(([stage]) => stage)).toEqual(['request', 'response']);
  });

  it('validates through the same author and activity policy in both callers', () => {
    const onParsed = vi.fn();
    let failure: unknown;
    try {
      acceptSimulationExecution(
        input,
        {
          events: [],
          messages: [{ author: 'unknown', text: 'nope', color: '#bba5ff', offsetMs: 0 }],
        },
        { onParsed },
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(SimulationExecutionError);
    expect(failure).toMatchObject({
      stage: 'validation',
      evidence: {
        normalizedResult: expect.any(Object),
        accepted: null,
        parsedResult: expect.any(Object),
      },
    });
    expect(String(failure)).toMatch(/author|roster/i);
    expect(onParsed).toHaveBeenCalledOnce();
    expect(() =>
      acceptSimulationExecution(input, normalized, { playbackWindowMs: -1 }),
    ).not.toThrow(); // Caller owns validated time-window configuration.
  });
});

describe('paused Recorded Speech Playground admission', () => {
  it('allows a paused and idle Run while excluding active or draining Whisper work', () => {
    expect(canStartPausedSpeech(true, audio)).toBe(true);
    expect(canStartPausedSpeech(false, audio)).toBe(false);
    expect(
      canStartPausedSpeech(true, {
        ...audio,
        sources: [{ ...audio.sources[0], phase: 'starting' }],
      }),
    ).toBe(false);
    expect(
      canStartPausedSpeech(true, {
        ...audio,
        sources: [{ ...audio.sources[0], pendingSegments: 2 }],
      }),
    ).toBe(false);
  });
});
