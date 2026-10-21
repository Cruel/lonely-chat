import { expect, it, vi } from 'vitest';
import { llamaCppAdapter, stageRequiresProjector } from './unified-inference-adapters';
import {
  buildUnifiedInferenceRequest,
  type UnifiedInferenceRequest,
} from './unified-inference-request';
import type { InferenceInput } from './fake-inference';

const frame = {
  sourceId: 'camera',
  observedAt: 2000,
  dataUrl: 'data:image/jpeg;base64,AA==',
  width: 1,
  height: 1,
};

it('selects local projector by submitted stage media, including Unified and Hybrid Chat', () => {
  const input: InferenceInput = { context: 'Scene', cycle: 1, frames: [frame] };
  expect(stageRequiresProjector('unified', input)).toBe(true);
  expect(stageRequiresProjector('observer', input)).toBe(true);
  expect(stageRequiresProjector('chat', input)).toBe(false);
  expect(stageRequiresProjector('chat', { ...input, chatFrames: [frame] })).toBe(true);
  expect(stageRequiresProjector('memory', { ...input, chatFrames: [frame] })).toBe(false);
  expect(stageRequiresProjector('unified', { ...input, frames: [] })).toBe(false);
});

it('sends independent Chat and Memory deadlines through the same local worker adapter', async () => {
  const transport = vi.fn(
    async (
      _input: InferenceInput,
      _wireRequest: unknown,
      _signal: AbortSignal,
      _videoToken?: string,
      _videoOptions?: unknown,
      timeoutMs?: number,
    ) => ({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: JSON.stringify(
              timeoutMs === 60000 ? { summary: 'Retained scene' } : { events: [], messages: [] },
            ),
          },
        },
      ],
    }),
  );
  const input: InferenceInput = { context: 'Race', cycle: 1, roster: [] };
  const adapter = llamaCppAdapter(
    { completeSimulationRequest: transport },
    input,
    undefined,
    (role) => (role === 'memory' ? 60000 : 20000),
  );
  const chat = buildUnifiedInferenceRequest(input);
  const memory = {
    ...chat,
    role: 'memory',
    response: { kind: 'json', schema: { properties: { summary: { maxLength: 100 } } } },
  } as unknown as UnifiedInferenceRequest;
  await adapter.complete(chat, new AbortController().signal);
  const outcome = await adapter.complete(memory, new AbortController().signal);
  expect(outcome.normalized).toEqual({ summary: 'Retained scene' });
  expect(transport.mock.calls.map((call) => call[5])).toEqual([20000, 60000]);
});
