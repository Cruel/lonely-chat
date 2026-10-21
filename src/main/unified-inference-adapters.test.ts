import { expect, it } from 'vitest';
import { stageRequiresProjector } from './unified-inference-adapters';
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
