// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { DesktopAPI } from '../../shared/chat-contract';
import type { SimulationExperimentRequest } from '../../shared/playground-contract';
import { SimulationPlayground } from './simulation-playground';
import { JsonInspector } from './json-inspector';

afterEach(() => {
  cleanup();
  delete window.lonelyChat;
});

function setup() {
  const model = {
    id: 'native-model',
    repo: 'gguf/test',
    revision: '1',
    candidateId: 'test.gguf',
    projectorId: null,
    role: 'vision-language' as const,
    files: [],
    installedAt: 0,
  };
  const constructed = {
    stream: false,
    temperature: 0.7,
    max_tokens: 2048,
    messages: [
      { role: 'system', content: 'Actual system' },
      { role: 'user', content: 'actual context' },
    ],
    response_format: { type: 'json_object', schema: { type: 'object', required: ['messages'] } },
  };
  const previewSimulation = vi.fn(async (_request: SimulationExperimentRequest) => ({
    constructedRequest: constructed,
    submittedRequest: constructed,
  }));
  const runSimulationExperiment = vi.fn(async (request: SimulationExperimentRequest) => ({
    modelId: request.modelId,
    startedAt: '2026-10-18T12:00:00.000Z',
    durationMs: 25,
    constructedRequest: constructed,
    submittedRequest: request.rawRequestJson ? JSON.parse(request.rawRequestJson) : constructed,
    rawNativeOutput: { choices: [{ message: { content: '{"messages":[]}' } }] },
    normalizedResult: { events: [], messages: [] },
    accepted: { events: [], messages: [] },
    error: null,
    errorStage: null,
    usage: { promptTokens: 42, completionTokens: 12, totalTokens: 54 },
  }));
  window.lonelyChat = {
    getModelsSnapshot: async () => ({
      storageDirectory: '/models',
      installations: [model],
      active: { 'vision-language': 'native-model', 'speech-to-text': null },
      progress: { phase: 'idle', file: null, receivedBytes: 0, totalBytes: null },
    }),
    getAudience: async () => ({
      revision: 0,
      phase: 'ready',
      members: [{ author: 'viewer', color: '#123456' }],
      targetCount: 1,
      error: null,
    }),
    onModelsChange: () => () => {},
    onPlaygroundStatus: () => () => {},
    getPlaygroundStatus: async () => ({ busy: false }),
    previewSimulation,
    runSimulationExperiment,
  } as unknown as DesktopAPI;
  return { previewSimulation, runSimulationExperiment };
}

it('builds from production via IPC, validates the advanced editor, submits raw JSON and preserves read-only results', async () => {
  const { previewSimulation, runSimulationExperiment } = setup();
  const view = render(<SimulationPlayground simulationActive={false} />);
  await screen.findByText(/gguf\/test/);
  fireEvent.change(screen.getByLabelText('Stream context'), { target: { value: 'Playing chess' } });
  fireEvent.change(screen.getByLabelText('Source-labeled transcripts'), {
    target: { value: '[{"source":"mic","text":"checkmate","ageMs":250}]' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Construct request' }));
  await waitFor(() => expect(previewSimulation).toHaveBeenCalledOnce());
  expect(previewSimulation.mock.calls[0][0]).toMatchObject({
    values: {
      context: 'Playing chess',
      transcripts: [{ source: 'mic', text: 'checkmate', ageMs: 250 }],
      roster: [{ author: 'viewer', color: '#123456' }],
    },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Edit advanced raw JSON' }));
  const editor = screen.getByLabelText(/Advanced raw transport request/);
  const changed = JSON.parse((editor as HTMLTextAreaElement).value);
  changed.temperature = 0.2;
  fireEvent.change(editor, { target: { value: JSON.stringify(changed) } });
  fireEvent.click(screen.getByRole('button', { name: 'Run simulation one-shot' }));
  await waitFor(() => expect(runSimulationExperiment).toHaveBeenCalledOnce());
  expect(runSimulationExperiment.mock.calls[0][0]).toMatchObject({
    rawRequestJson: JSON.stringify(changed),
    values: { context: 'Playing chess' },
  });
  expect(await screen.findByText(/Tokens: 42 prompt/)).toBeTruthy();
  view.rerender(<SimulationPlayground simulationActive={true} />);
  expect(
    screen.getByRole('button', { name: 'Run simulation one-shot' }).hasAttribute('disabled'),
  ).toBe(true);
  expect(
    within(screen.getByLabelText('Simulation Playground results')).getByText(
      'Accepted events and chat',
    ),
  ).toBeTruthy();
});

it('shows syntax-highlighted raw JSON, nested tree, and copyable JSON paths/values', () => {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  render(<JsonInspector title="Metadata" value={{ events: [{ kind: 'reaction', ageMs: 12 }] }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Copy path $' }));
  expect(writeText).toHaveBeenCalledWith('$');
  fireEvent.click(screen.getByText('events'));
  fireEvent.click(screen.getByRole('button', { name: 'Copy path $["events"][0]' }));
  expect(writeText).toHaveBeenCalledWith('$["events"][0]');
  fireEvent.click(screen.getByRole('button', { name: 'Raw JSON' }));
  expect(screen.getByText('"reaction"')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Tree' }));
  expect(screen.getByText('events')).toBeTruthy();
});
