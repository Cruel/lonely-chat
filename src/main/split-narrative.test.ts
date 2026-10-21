import { expect, it } from 'vitest';
import { SplitNarrative } from './split-narrative';

const finish = { kind: 'reaction' as const, summary: 'The racer finishes!', observedAt: 2000 };
const speak = { kind: 'reaction' as const, summary: 'Chat notices a new rival', observedAt: 2400 };

it('keeps scene separate from events, deduplicates repeated frames and reconciles Chat recognition', () => {
  const narrative = new SplitNarrative();
  narrative.observeVision('Racers at finish', [finish], 2000, 100, ['cam:2000']);
  narrative.observeVision('Racers at finish', [finish], 2000, 110, ['cam:2000']);
  expect(narrative.pending(120, 1000)).toHaveLength(1);
  expect(narrative.currentScene(120, 1000)).toMatchObject({
    sourceModel: 'vision',
    observedAt: 2000,
    availableAt: 100,
    frameIds: ['cam:2000'],
  });
  expect(narrative.merge([{ ...finish, summary: ' the RACER finishes! ' }], 'chat', 130)).toEqual([]);
  expect(narrative.merge([speak], 'chat', 130)).toHaveLength(1);
  expect(narrative.history(130, 1000).map((entry) => entry.sourceModel)).toEqual(['vision', 'chat']);
  const pending = narrative.pending(130, 1000);
  narrative.acknowledge(pending);
  expect(narrative.pending(140, 1000)).toHaveLength(0);
  expect(narrative.history(140, 1000)).toHaveLength(2);
  expect(narrative.sceneObservation(140, 1000)[0].description).toBe('Racers at finish');
  expect(narrative.sceneObservation(1201, 1000)).toEqual([]);
});

it('rejects late Vision results without rolling scene backward and resets Run history', () => {
  const narrative = new SplitNarrative();
  narrative.observeVision('New scene', [finish], 3000, 100, ['cam:3000']);
  narrative.observeVision('Old scene', [{ ...finish, summary: 'Late event' }], 2000, 200, ['cam:2000']);
  expect(narrative.currentScene(200, 1000)?.text).toBe('New scene');
  expect(narrative.history(200, 1000)).toHaveLength(1);
  narrative.reset();
  expect(narrative.history(200, 1000)).toEqual([]);
  expect(narrative.currentScene(200, 1000)).toBeNull();
});
