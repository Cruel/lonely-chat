// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SavedCasePlayground } from './saved-case-playground';
import type { DesktopAPI } from '../../shared/chat-contract';
import type { SavedCaseDetail } from '../../shared/saved-case-contract';

afterEach(() => {
  cleanup();
  delete window.lonelyChat;
});
const original: SavedCaseDetail = {
  summary: {
    id: 'case-1',
    attemptId: 'attempt-4',
    runId: 2,
    cycle: 3,
    attempt: 2,
    savedAt: '2026-10-18T01:00:00Z',
    modelId: 'installed-model',
    seed: 77,
    frameCount: 1,
    childCount: 0,
  },
  frames: [
    {
      index: 0,
      sourceId: 'screen',
      observedAt: 123,
      width: 4,
      height: 4,
      ref: 'saved-frame:' + 'a'.repeat(64),
      dataUrl: 'data:image/jpeg;base64,/9j/2Q==',
    },
  ],
  input: { context: 'private stream context', captureSelection: { frames: ['frame-1'] } },
  request: {
    seed: 77,
    stream: false,
    temperature: 0.7,
    messages: [
      { role: 'system', content: 'Respond to footage' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'image_url', image_url: { url: 'saved-frame:' + 'a'.repeat(64) } },
        ],
      },
    ],
    response_format: { type: 'json_object', schema: { type: 'object' } },
  },
  children: [],
  sourceResult: {
    stage: 'accepted',
    errorStage: null,
    error: null,
    durationMs: 25,
    usage: null,
    rawNativeOutput: null,
    normalizedResult: null,
    parsedResult: null,
    accepted: { events: [], messages: [] },
    scheduled: null,
    presented: null,
    transportError: null,
  },
};

it('opens saved case in Simulation Playground and forks editable content without altering source', async () => {
  const get = vi.fn(async () => structuredClone(original));
  const run = vi.fn(async () => ({
    child: {
      id: 'child-1',
      parentCaseId: 'case-1',
      modelId: 'installed-model',
      seed: 88,
      createdAt: '2026-10-18T01:01:00Z',
      errorStage: null,
      error: null,
      durationMs: 18,
      frameIndices: [],
      outcome: {
        submittedRequest: { seed: 88 },
        rawNativeOutput: {},
        normalizedResult: null,
        parsedResult: null,
        accepted: { events: [], messages: [] },
        usage: null,
      },
    },
    result: {
      submittedRequest: { seed: 88 },
      rawNativeOutput: {},
      accepted: { events: [], messages: [] },
    },
  }));
  window.lonelyChat = {
    listSavedCases: async () => [original.summary],
    getSavedCase: get,
    getModelsSnapshot: async () => ({
      installations: [
        {
          id: 'installed-model',
          role: 'vision-language',
          repo: 'fixture/repo',
          candidateId: 'f16',
        },
      ],
      active: { 'vision-language': 'installed-model' },
    }),
    runSavedCase: run,
  } as unknown as DesktopAPI;
  render(<SavedCasePlayground focusId="case-1" simulationActive={false} busy={false} />);
  expect(await screen.findByLabelText('Saved case request JSON')).toBeTruthy();
  expect(get).toHaveBeenCalledWith('case-1');
  const originalJson = JSON.stringify(original.request);
  fireEvent.change(screen.getByLabelText('Saved case request JSON'), {
    target: { value: originalJson.replace('"seed":77', '"seed":88') },
  });
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Run independent child experiment' }));
  await waitFor(() =>
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        caseId: 'case-1',
        frameIndices: [],
        rawRequestJson: expect.stringContaining('"seed":88'),
      }),
    ),
  );
  expect((await screen.findAllByText(/Child child-1/)).length).toBeGreaterThan(0);
  expect(get).toHaveBeenCalledTimes(1);
  expect(original.request).toMatchObject({ seed: 77 });
  expect(screen.getByText(/1 child experiments/)).toBeTruthy();
});

it('does not display an in-flight result under a newly selected saved case', async () => {
  const second: SavedCaseDetail = {
    ...structuredClone(original),
    summary: { ...original.summary, id: 'case-2', attemptId: 'attempt-5' },
  };
  let complete!: (value: unknown) => void;
  const run = vi.fn(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  window.lonelyChat = {
    listSavedCases: async () => [original.summary, second.summary],
    getSavedCase: async (id: string) => structuredClone(id === 'case-1' ? original : second),
    getModelsSnapshot: async () => ({
      installations: [
        {
          id: 'installed-model',
          role: 'vision-language',
          repo: 'fixture/repo',
          candidateId: 'f16',
        },
      ],
      active: { 'vision-language': 'installed-model' },
    }),
    runSavedCase: run,
  } as unknown as DesktopAPI;
  render(<SavedCasePlayground focusId="case-1" simulationActive={false} busy={false} />);
  expect(await screen.findByLabelText('Saved case request JSON')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Run independent child experiment' }));
  await waitFor(() =>
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ caseId: 'case-1' })),
  );
  fireEvent.change(screen.getByLabelText('Choose saved case'), { target: { value: 'case-2' } });
  await waitFor(() => expect(screen.getByText(/source attempt-5/)).toBeTruthy());
  complete({
    child: {
      id: 'child-of-A',
      parentCaseId: 'case-1',
      modelId: 'installed-model',
      seed: 88,
      createdAt: '2026-10-18T01:01:00Z',
      errorStage: null,
      error: null,
      durationMs: 18,
      frameIndices: [],
      outcome: {
        submittedRequest: {},
        rawNativeOutput: {},
        normalizedResult: null,
        parsedResult: null,
        accepted: { events: [], messages: [] },
        usage: null,
      },
    },
    result: { submittedRequest: {}, rawNativeOutput: {}, accepted: { events: [], messages: [] } },
  });
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Run independent child experiment' })).toHaveProperty(
      'disabled',
      false,
    ),
  );
  expect(screen.getByText(/source attempt-5/).textContent).toContain('0 child experiments');
  expect(screen.queryByText(/Child child-of-A/)).toBeNull();
});

it('reopens persisted child outcomes without requiring a running model', async () => {
  const saved: SavedCaseDetail = {
    ...original,
    children: [
      {
        id: 'child-reopened',
        parentCaseId: original.summary.id,
        modelId: original.summary.modelId,
        seed: 41,
        createdAt: '2026-10-18T01:02:00Z',
        durationMs: 12,
        errorStage: null,
        error: null,
        frameIndices: [],
        outcome: {
          submittedRequest: { seed: 41 },
          rawNativeOutput: { response: 'saved reply' },
          normalizedResult: {},
          parsedResult: null,
          accepted: { events: [], messages: [] },
          usage: null,
        },
      },
    ],
  };
  window.lonelyChat = {
    listSavedCases: async () => [saved.summary],
    getSavedCase: async () => saved,
  } as unknown as DesktopAPI;
  render(<SavedCasePlayground focusId={saved.summary.id} simulationActive={false} busy={false} />);
  fireEvent.click(await screen.findByText(/seed 41 · accepted/));
  expect(
    await screen.findByRole('region', { name: /Saved child child-reopened native output/ }),
  ).toBeTruthy();
});

it('allows opening/listing while simulation is active but blocks case execution', async () => {
  const run = vi.fn();
  window.lonelyChat = {
    listSavedCases: async () => [original.summary],
    getSavedCase: async () => original,
    runSavedCase: run,
  } as unknown as DesktopAPI;
  render(<SavedCasePlayground focusId="case-1" simulationActive busy={false} />);
  expect(await screen.findByLabelText('Saved case request JSON')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Run independent child experiment' })).toHaveProperty(
    'disabled',
    true,
  );
  expect(screen.getByText(/Stop Simulation to run Playground/)).toBeTruthy();
  expect(run).not.toHaveBeenCalled();
});
