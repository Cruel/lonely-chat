// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SavedCaseComparison } from './saved-case-comparison';
import type { SavedCaseDetail } from '../../shared/saved-case-contract';

const request = (seed: number, prompt: string, refs: string[]) => ({
  seed,
  temperature: 0.7,
  max_tokens: 512,
  response_format: { type: 'json_object', schema: { type: 'object' } },
  messages: [
    { role: 'system', content: 'Be helpful' },
    {
      role: 'user',
      content: [
        { type: 'text', text: JSON.stringify({ manualContext: prompt, cycle: 2 }) },
        ...refs.map((ref) => ({ type: 'image_url', image_url: { url: ref } })),
      ],
    },
  ],
});
const ref = 'saved-frame:' + 'a'.repeat(64);
const fixture: SavedCaseDetail = {
  summary: {
    id: 'case-x',
    savedAt: '2026-10-18',
    attemptId: 'a',
    runId: 1,
    cycle: 2,
    attempt: 1,
    modelId: 'model-a',
    seed: 42,
    frameCount: 1,
    childCount: 2,
  },
  request: request(42, 'base input', [ref]),
  input: { context: 'base input' },
  frames: [
    {
      index: 0,
      sourceId: 'screen',
      observedAt: 100,
      mediaTimeMs: 55,
      width: 4,
      height: 4,
      ref,
      dataUrl: 'data:image/jpeg;base64,/9j/2Q==',
    },
  ],
  sourceResult: {
    stage: 'scheduled',
    errorStage: null,
    error: null,
    durationMs: 100,
    usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
    rawNativeOutput: { choices: [{ message: { content: '{"events":[]}' } }] },
    normalizedResult: { events: [], messages: [{ text: 'hi' }] },
    parsedResult: { events: [], messages: [{ text: 'hi' }] },
    accepted: {
      events: [],
      messages: [{ author: 'viewer', text: 'Hello', color: '#abcdef', offsetMs: 50 }],
    },
    scheduled: null,
    presented: [],
    transportError: null,
  },
  children: [
    {
      id: 'success',
      parentCaseId: 'case-x',
      createdAt: '2026-10-18T02:00:00Z',
      modelId: 'model-b',
      seed: 5,
      errorStage: null,
      error: null,
      durationMs: 230,
      frameIndices: [],
      outcome: {
        submittedRequest: request(5, 'edited input', []),
        rawNativeOutput: {
          choices: [{ message: { content: '{"events":[{"kind":"reaction","summary":"win"}]}' } }],
        },
        normalizedResult: { events: [{ kind: 'reaction', summary: 'win' }] },
        parsedResult: { events: [{ kind: 'reaction', summary: 'win' }] },
        accepted: {
          events: [{ kind: 'reaction', summary: 'win' }],
          messages: [{ author: 'viewer', text: 'Victory', color: '#ffaabb', offsetMs: 40 }],
        },
        usage: { promptTokens: 20, completionTokens: 2, totalTokens: 22 },
      },
    },
    {
      id: 'failure',
      parentCaseId: 'case-x',
      createdAt: '2026-10-18T01:00:00Z',
      modelId: 'model-b',
      seed: 6,
      errorStage: 'validation',
      error: 'Invalid output',
      durationMs: 240,
      frameIndices: [],
      outcome: {
        submittedRequest: request(6, 'broken input', []),
        rawNativeOutput: { choices: [{ message: { content: 'not json' } }] },
        normalizedResult: null,
        accepted: null,
        usage: null,
      },
    },
  ],
};
afterEach(() => {
  cleanup();
  localStorage.clear();
});

it('compares request prompts, structured inputs, effective seeds, model and image selection with results side by side', () => {
  render(<SavedCaseComparison source={fixture} />);
  expect(screen.getByLabelText('Compare left trial')).toHaveProperty('value', 'source');
  expect(screen.getByLabelText('Compare right trial')).toHaveProperty('value', 'success');
  expect(screen.getAllByText(/base input/).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/edited input/).length).toBeGreaterThan(0);
  expect(screen.getAllByText('Different').length).toBeGreaterThan(0);
  expect(screen.getByText(/: Victory/)).toBeTruthy();
  expect(screen.getByText(/: Hello/)).toBeTruthy();
  expect(screen.getByAltText('Left selected frame 1')).toBeTruthy();
  expect(screen.queryByAltText('Right selected frame 1')).toBeNull();
  expect(screen.getByText(/20 prompt/)).toBeTruthy();
});

it('distinguishes identical JPEG bytes selected at different original frame indices', () => {
  const first = {
    ...fixture.children[0],
    frameIndices: [0],
    outcome: {
      ...fixture.children[0].outcome!,
      submittedRequest: request(5, 'same prompt', [ref]),
    },
  };
  const second = {
    ...fixture.children[1],
    frameIndices: [1],
    outcome: {
      ...fixture.children[1].outcome!,
      submittedRequest: request(6, 'same prompt', [ref]),
    },
  };
  const doubled: SavedCaseDetail = {
    ...fixture,
    frames: [
      ...fixture.frames,
      { ...fixture.frames[0], index: 1, sourceId: 'camera', observedAt: 200 },
    ],
    children: [first, second],
  };
  render(<SavedCaseComparison source={doubled} />);
  fireEvent.change(screen.getByLabelText('Compare left trial'), { target: { value: 'success' } });
  fireEvent.change(screen.getByLabelText('Compare right trial'), { target: { value: 'failure' } });
  const left = within(screen.getByRole('region', { name: 'Left trial details' }));
  const right = within(screen.getByRole('region', { name: 'Right trial details' }));
  expect(left.getByText(/screen · 100 ms/)).toBeTruthy();
  expect(right.getByText(/camera · 200 ms/)).toBeTruthy();
  expect(screen.getAllByText('Different').length).toBeGreaterThan(0);
});

it('restores a child-versus-child comparison after remount and flags invalid output without inventing events or chat', () => {
  const { unmount } = render(<SavedCaseComparison source={fixture} />);
  fireEvent.change(screen.getByLabelText('Compare left trial'), { target: { value: 'success' } });
  fireEvent.change(screen.getByLabelText('Compare right trial'), { target: { value: 'failure' } });
  unmount();
  render(<SavedCaseComparison source={fixture} />);
  expect(screen.getByLabelText('Compare left trial')).toHaveProperty('value', 'success');
  expect(screen.getByLabelText('Compare right trial')).toHaveProperty('value', 'failure');
  const right = within(screen.getByRole('region', { name: 'Right trial details' }));
  expect(right.getByText(/Invalid output/)).toBeTruthy();
  expect(right.getByText(/Accepted output unavailable/)).toBeTruthy();
  expect(right.queryByText('Victory')).toBeNull();
});

it('automatically compares the first child created while a case is open', async () => {
  const empty: SavedCaseDetail = { ...fixture, children: [] };
  const view = render(<SavedCaseComparison source={empty} />);
  expect(screen.getByLabelText('Compare right trial')).toHaveProperty('value', 'source');
  view.rerender(<SavedCaseComparison source={fixture} />);
  await waitFor(() =>
    expect(screen.getByLabelText('Compare right trial')).toHaveProperty('value', 'success'),
  );
});

it('identifies unavailable original outcomes from old saved cases, and explicitly omitted child output', () => {
  const oldCase: SavedCaseDetail = {
    ...fixture,
    sourceResult: undefined,
    children: [
      {
        ...fixture.children[0],
        outcome: {
          ...fixture.children[0].outcome!,
          omitted: 'Child output exceeded the 2 MiB persistence limit.',
          rawNativeOutput: null,
          normalizedResult: null,
          parsedResult: null,
          accepted: null,
        },
      },
    ],
  };
  render(<SavedCaseComparison source={oldCase} />);
  expect(screen.getByText(/Original outcome was not recorded/)).toBeTruthy();
  expect(screen.getByText(/2 MiB persistence limit/)).toBeTruthy();
});
