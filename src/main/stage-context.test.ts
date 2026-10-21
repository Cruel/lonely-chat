import { expect, it } from 'vitest';
import { resolveStageContext, resolveStageTemplate, resolveUnifiedStageRequest } from './stage-context';
import { buildUnifiedInferenceRequest } from './unified-inference-request';
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

it('keeps significant historical summaries beyond the recent window', () => {
  const result = resolveStageContext({
    ...input,
    significantEvents: [{ summary: 'The rivals reunited a year ago', observedAt: -1000000 }],
    priorInterpretations: [{ text: 'Possibly a rivalry', sourceModel: 'vision', observedAt: 199999 }],
  }, { contextPolicy: {
    maxAgeMs: 1000, maxCount: 10, maxCharacters: 4096,
    sources: ['significantEvents', 'interpretations', 'observations'],
  } });
  expect(JSON.stringify(result.data.significantEvents)).toContain('rivals reunited');
  expect(JSON.stringify(result.data.interpretations)).toContain('model-interpretation');
  expect(result.data.events).toEqual([]);
});

it('evicts uncertain history ahead of newest captured observations with visible omissions', () => {
  const observed = { source: 'mic', kind: 'audio' as const, description: 'new gunshot'.repeat(10), observedAt: 200000 };
  const result = resolveStageContext({
    ...input, observations: [observed],
    recentChat: Array.from({ length: 15 }, (_, i) => ({
      author: 'viewer', text: 'older chatter'.repeat(5), presentedAt: 199000 + i,
    })),
  }, { contextPolicy: {
    maxAgeMs: 10000, maxCount: 20, maxCharacters: 512,
    sources: ['chat', 'observations'],
  } });
  expect(JSON.stringify(result.data.observations)).toContain('new gunshot');
  expect(result.omittedBySource.chat).toBeGreaterThan(0);
  expect(result.characters).toBeLessThanOrEqual(512);
});

it('removes excluded transcript, chat, and event material from the actual Unified transport', () => {
  const original = buildUnifiedInferenceRequest(input);
  const stage = { contextPolicy: {
    maxAgeMs: 1000, maxCount: 0, maxCharacters: 1024, sources: [] as [],
  }, userPrompt: 'Only inspect selected evidence {{events}}' };
  const restricted = resolveUnifiedStageRequest(original, input, stage);
  const text = restricted.content.filter((part) => part.type === 'text')
    .map((part) => part.text).join(' ');
  expect(text).not.toContain('Go!');
  expect(text).not.toContain('Wow');
  expect(text).not.toContain('Old championship');
  expect(text).not.toContain('Recent finish');
  expect(text).not.toContain('Race track');
  expect(text).toContain('Only inspect selected evidence');
  expect(JSON.stringify(original.content)).toContain('Go!');
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
