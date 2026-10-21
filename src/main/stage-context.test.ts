import { expect, it } from 'vitest';
import { resolveStageContext, resolveStageTemplate } from './stage-context';
import type { InferenceInput } from './fake-inference';

const input: InferenceInput = {
  context: 'A race',
  cycle: 4,
  boundary: { fromSequence: 0, throughSequence: 1, fromMs: 0, throughMs: 200000 },
  recentEvents: [
    { kind: 'context', summary: 'Old championship', observedAt: 1000 },
    { kind: 'reaction', summary: 'Recent finish', observedAt: 199900 },
  ],
  recentTranscripts: [{ source: 'mic', text: 'Go!', observedAt: 199999 }],
  recentChat: [{ author: 'viewer', text: 'Wow', presentedAt: 199999 }],
  observations: [{ source: 'vision', kind: 'visual', description: 'Race track', observedAt: 199990 }],
};

it('independently bounds sources and refuses old inferred history as fresh evidence', () => {
  const selected = resolveStageContext(input, {
    contextPolicy: { maxAgeMs: 10000, maxCount: 2, maxCharacters: 2000, sources: ['events', 'scene'] },
  });
  expect(selected.data.events).toEqual([input.recentEvents![1]]);
  expect(selected.data.chat).toEqual([]);
  expect(selected.data.scene).toHaveLength(1);
  expect(selected.data.transcripts).toEqual([]);
  expect(resolveStageTemplate('{{context}}/{{cycle}}/{{events}}', selected.data))
    .toContain('Recent finish');
  expect(() => resolveStageTemplate('{{unknown}}', selected.data)).toThrow('Unknown');
});

it('preserves recent evidence when evicting oldest history within a character budget', () => {
  const selected = resolveStageContext(input, {
    contextPolicy: {
      maxAgeMs: 3600000, maxCount: 50, maxCharacters: 512,
      sources: ['events', 'transcripts', 'chat', 'scene', 'observations', 'narrative'],
    },
  });
  expect(selected.characters).toBeLessThanOrEqual(512);
  expect(selected.data.context).toBe('A race');
});

it('supports empty sources and safely rejects malformed template variables', () => {
  const selected = resolveStageContext({ ...input, observations: [], recentEvents: [] }, {
    contextPolicy: { maxAgeMs: 1000, maxCount: 0, maxCharacters: 512, sources: [] },
  });
  expect(selected.data.scene).toEqual([]);
  expect(selected.data.events).toEqual([]);
  expect(resolveStageContext(input, { contextPolicy: { maxAgeMs: 1000, maxCount: 0, maxCharacters: 512, sources: ['events'] } }).data.events).toEqual([]);
  expect(() => resolveStageTemplate('{{user.password}}', selected.data)).toThrow('Unknown');
});
