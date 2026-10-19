// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { InferenceRunInspector } from './inference-run-inspector';
import type { TraceAttempt, TraceFilter, TraceList } from '../../shared/inference-trace-contract';

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

it('shows exact selected frame evidence, pending versus published chat, and cross-links Logs', async () => {
  const image = 'data:image/jpeg;base64,/9j/2Q==';
  const list: TraceList = {
    dropped: 0,
    bytes: 400,
    attempts: [
      {
        id: 'attempt-1',
        runId: 9,
        cycle: 1,
        attempt: 1,
        seed: 14,
        rosterSeed: 22,
        mode: 'native',
        modelId: 'model',
        startedAt: 1700000001000,
        durationMs: 50,
        stage: 'scheduled',
        error: null,
        errorStage: null,
        usage: null,
        sources: ['Mic', 'recorded:video'],
        chatters: ['viewer'],
        eventKinds: ['reaction'],
        boundary: { fromMs: 1700000000000, throughMs: 1700000001000 },
      },
      {
        id: 'attempt-2',
        runId: 9,
        cycle: 2,
        attempt: 1,
        seed: 15,
        rosterSeed: 23,
        mode: 'native',
        modelId: 'model',
        startedAt: 1700000002000,
        durationMs: 20,
        stage: 'failed',
        error: 'Bad schema',
        errorStage: 'validation',
        usage: null,
        sources: ['Discord'],
        chatters: [],
        eventKinds: [],
      },
    ],
  };
  const detail: TraceAttempt = {
    ...list.attempts[0],
    input: {
      boundary: {
        fromMs: 1700000000000,
        throughMs: 1700000001000,
        fromSequence: 0,
        throughSequence: 2,
      },
      captureSelection: { frames: ['recorded:video:1700000000500:0'] },
      frames: [
        { sourceId: 'recorded:video', observedAt: 1700000000500, mediaTimeMs: 500, dataUrl: image },
      ],
      recentTranscripts: [
        { source: 'Mic', sourceId: 'mic-1', text: 'watch out', observedAt: 1700000000600 },
      ],
      recentChat: [],
    },
    settings: {},
    promptPreset: null,
    adaptation: { frameLimit: 1 },
    request: null,
    rawResponse: null,
    normalized: null,
    parsed: null,
    accepted: null,
    scheduled: {
      enqueuedAt: 1700000001500,
      windowMs: 2000,
      events: [{ kind: 'reaction', summary: 'danger', observedAt: 1700000000600 }],
      messages: [
        { author: 'viewer', text: 'look!', offsetMs: 0 },
        { author: 'viewer', text: 'run!', offsetMs: 900 },
      ],
    },
    presented: [
      {
        scheduledIndex: 0,
        id: 'chat-10',
        author: 'viewer',
        text: 'look!',
        presentedAt: 1700000001510,
      },
    ],
    presentationClosed: false,
    transportError: null,
  };
  const failed: TraceAttempt = {
    ...list.attempts[1],
    input: { omitted: true },
    settings: null,
    promptPreset: null,
    adaptation: null,
    request: null,
    rawResponse: null,
    normalized: null,
    parsed: null,
    accepted: null,
    scheduled: null,
    transportError: null,
  };
  const get = vi.fn(async (id: string) => (id === detail.id ? detail : failed));
  const search = vi.fn(async (filter: TraceFilter) =>
    filter.text === 'watch out' ? ['attempt-1'] : list.attempts.map((item) => item.id),
  );
  const logs = vi.fn();
  window.lonelyChat = {
    listInferenceTraces: async () => list,
    onInferenceTraces: () => () => {},
    getInferenceTrace: get,
    searchInferenceTraces: search,
  } as unknown as typeof window.lonelyChat;
  render(<InferenceRunInspector onViewLogs={logs} />);
  expect(get).not.toHaveBeenCalled();
  // Search uses privileged main-process text matching without fetching media.
  fireEvent.change(screen.getByLabelText('Search inference attempts'), {
    target: { value: 'watch out' },
  });
  await waitFor(() =>
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ text: 'watch out' })),
  );
  await waitFor(() => expect(screen.getAllByRole('button', { name: /Run 9/ })).toHaveLength(1));
  expect(get).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: /Run 9 · cycle 1/ }));
  expect(
    await screen.findByRole('region', { name: 'Observation and presentation timeline' }),
  ).toBeTruthy();
  expect(screen.getByText('Displayed · viewer')).toBeTruthy();
  expect(screen.getByText('Pending · viewer')).toBeTruthy();
  expect(screen.getByText(/Transcript · Mic/)).toBeTruthy();
  expect(screen.getByText(/Selected frame 1 · recorded:video/)).toBeTruthy();
  expect(screen.getByText(/ID recorded:video:1700000000500:0/)).toBeTruthy();
  const img = screen.getByRole('img', { name: 'Selected frame 1' });
  expect(img.getAttribute('src')).toBe(image);
  expect(screen.getAllByText(/media 500 ms/)).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: /Find related errors in Logs/ }));
  expect(logs).toHaveBeenCalledWith('attempt-1');
  // A failed retry without media should still be inspectable.
  fireEvent.change(screen.getByLabelText('Search inference attempts'), { target: { value: '' } });
  fireEvent.click(await screen.findByRole('button', { name: /Run 9 · cycle 2/ }));
  expect(await screen.findByText('Timeline evidence unavailable for this attempt.')).toBeTruthy();
  expect(screen.queryByRole('img', { name: 'Selected frame 1' })).toBeNull();
});
