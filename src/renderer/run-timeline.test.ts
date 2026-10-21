import { expect, it } from 'vitest';
import { runTimeline } from './run-timeline';
import type { TraceAttempt } from '../shared/inference-trace-contract';

const baseline: TraceAttempt = {
  id: 'attempt-vision', runId: 7, cycle: 1, attempt: 1, seed: 1,
  rosterSeed: 2, mode: 'remote', modelId: 'vision-v1',
  startedAt: 1000, startedTimelineAt: 900, observedAt: 200,
  availableAt: 1300, availableTimelineAt: 1100, durationMs: 300,
  role: 'vision', profileRevision: 3, sourceFrameIds: ['camera:200:0'],
  observationRefs: ['transcript:mic:205:0'], dependsOn: [],
  stage: 'accepted', errorStage: null, error: null,
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  input: {}, settings: {}, promptPreset: null, adaptation: null,
  request: {}, rawResponse: {}, normalized: {}, parsed: {},
  accepted: { events: [{ kind: 'reaction', summary: 'A door opens', observedAt: 200 }] },
  scheduled: null, sceneState: 'An open door', transportError: null,
};

it('joins causal stage activity in pause-adjusted order while keeping physical time distinct', () => {
  const chat: TraceAttempt = {
    ...baseline, id: 'attempt-chat', role: 'chat', modelId: 'chat-v2',
    startedAt: 1350, startedTimelineAt: 1150,
    availableAt: 1400, availableTimelineAt: 1200,
    stage: 'scheduled', sceneState: null, dependsOn: [baseline.id],
    accepted: { events: [], messages: [{ author: 'pixelpilot', text: 'the door!', offsetMs: 0 }] },
    scheduled: {
      clockDomain: 'pause-adjusted', enqueuedAt: 1200, enqueuedPhysicalAt: 1400,
      windowMs: 1000, events: [], messages: [{ author: 'pixelpilot', text: 'the door!', offsetMs: 0 }],
    },
    presented: [{ id: 'chat-1', scheduledIndex: 0, author: 'pixelpilot',
      text: 'the door!', presentedAt: 1450, timelineAt: 1250 }],
  };
  const before = structuredClone([chat, baseline]);
  const timeline = runTimeline([chat, baseline]); // out-of-order availability in listings
  expect(timeline.map((item) => item.title)).toEqual([
    'Vision request', 'Scene state updated', 'Vision Event · reaction',
    'vision accepted', 'Chat request', 'chat accepted',
    'Chat batch accepted', 'Displayed · pixelpilot',
  ]);
  expect(timeline.find((item) => item.title === 'Chat request')).toMatchObject({
    physicalTimestamp: 1350, timestamp: 1150, clockDomain: 'pause-adjusted',
    attemptId: chat.id,
  });
  expect(timeline.find((item) => item.title === 'Chat request')?.description).toContain(baseline.id);
  expect(timeline.find((item) => item.title === 'Vision request')?.description).toContain('camera:200:0');
  expect(timeline.find((item) => item.title === 'Displayed · pixelpilot')).toMatchObject({
    physicalTimestamp: 1450, timestamp: 1250,
  });
  expect([chat, baseline]).toEqual(before);
});

it('retains failed and cancelled attempts even without accepted events or chat', () => {
  const failed: TraceAttempt = { ...baseline, id: 'attempt-failed',
    stage: 'failed', errorStage: 'validation', error: 'Bad schema',
    availableAt: 1400, availableTimelineAt: 1200,
    sceneState: null, accepted: null };
  expect(runTimeline([failed]).some((entry) => entry.description.includes('failed at validation'))).toBe(true);
  const cancelled: TraceAttempt = { ...baseline, id: 'attempt-cancelled',
    stage: 'cancelled', errorStage: 'transport', error: 'Run stopped',
    availableAt: null, availableTimelineAt: null, sceneState: null, accepted: null };
  const entries = runTimeline([cancelled]);
  expect(entries.some((entry) => entry.title === 'vision cancelled')).toBe(true);
  expect(entries.find((entry) => entry.title === 'vision cancelled')?.timestamp).toBe(900);
});
