// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DesktopAPI } from '../../shared/chat-contract';
import type { FreeformRequest } from '../../shared/playground-contract';
import { FreeformPlayground } from './freeform-playground';

const installed = {
  id: 'local-model',
  repo: 'gguf/test',
  revision: '1',
  candidateId: 'tiny-Q4.gguf',
  projectorId: null,
  role: 'vision-language' as const,
  files: [],
  installedAt: 0,
};

afterEach(() => {
  cleanup();
  delete window.lonelyChat;
});

it('sends selected model, prompts, sampling and locked seed and retains response while Simulation runs', async () => {
  const send = vi.fn(async (request: FreeformRequest) => ({
    modelId: request.modelId,
    request,
    effectiveSeed: request.seed,
    startedAt: '2026-10-18T12:00:00.000Z',
    durationMs: 87,
    finishReason: 'stop',
    content: 'A real model answer',
    usage: { promptTokens: 12, completionTokens: 5, totalTokens: 17 },
  }));
  window.lonelyChat = {
    getModelsSnapshot: async () => ({
      storageDirectory: '/models',
      installations: [installed],
      active: { 'vision-language': 'local-model', 'speech-to-text': null },
      progress: { phase: 'idle', file: null, receivedBytes: 0, totalBytes: null },
    }),
    onModelsChange: () => () => {},
    getPlaygroundStatus: async () => ({ busy: false }),
    onPlaygroundStatus: () => () => {},
    runFreeform: send,
  } as unknown as DesktopAPI;
  const ui = render(<FreeformPlayground simulationActive={false} />);
  expect(await screen.findByText(/gguf\/test/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('System prompt'), { target: { value: 'You are a poet' } });
  fireEvent.change(screen.getByLabelText('User prompt'), { target: { value: 'Write haiku' } });
  fireEvent.change(screen.getByLabelText('Temperature'), { target: { value: '0.3' } });
  fireEvent.change(screen.getByLabelText('Top P'), { target: { value: '0.8' } });
  fireEvent.change(screen.getByLabelText('Top K'), { target: { value: '22' } });
  fireEvent.change(screen.getByLabelText('Maximum tokens'), { target: { value: '96' } });
  fireEvent.change(screen.getByLabelText('Seed'), { target: { value: '31234' } });
  expect(screen.getByRole('button', { name: 'Locked' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Run freeform' }));
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  expect(send).toHaveBeenCalledWith({
    modelId: 'local-model',
    systemPrompt: 'You are a poet',
    userPrompt: 'Write haiku',
    temperature: 0.3,
    topP: 0.8,
    topK: 22,
    maxTokens: 96,
    seed: 31234,
  });
  expect(await screen.findByText('A real model answer')).toBeTruthy();
  expect(screen.getByText(/Tokens: 12 prompt/)).toBeTruthy();
  ui.rerender(<FreeformPlayground simulationActive={true} />);
  expect(screen.getByText('A real model answer')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Run freeform' }).hasAttribute('disabled')).toBe(true);
  fireEvent.change(screen.getByLabelText('User prompt'), { target: { value: 'Still editable' } });
  expect(screen.getByLabelText('User prompt')).toHaveProperty('value', 'Still editable');
  expect(send).toHaveBeenCalledTimes(1);
});

it('generates and regenerates seeds and surfaces native errors without inserting fake responses', async () => {
  const fail = vi.fn(async () => {
    throw new Error('llama.cpp inference failed (HTTP 500)');
  });
  window.lonelyChat = {
    getModelsSnapshot: async () => ({
      storageDirectory: '/models',
      installations: [installed],
      active: { 'vision-language': 'local-model', 'speech-to-text': null },
      progress: { phase: 'idle', file: null, receivedBytes: 0, totalBytes: null },
    }),
    onModelsChange: () => () => {},
    getPlaygroundStatus: async () => ({ busy: false }),
    onPlaygroundStatus: () => () => {},
    runFreeform: fail,
  } as unknown as DesktopAPI;
  render(<FreeformPlayground simulationActive={false} />);
  await waitFor(() =>
    expect(screen.getByRole('combobox', { name: 'Installed model' }).textContent).toContain(
      'gguf/test',
    ),
  );
  fireEvent.change(screen.getByLabelText('User prompt'), {
    target: { value: 'Try real llama.cpp' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Generate seed' }));
  expect(screen.getByRole('button', { name: 'Locked' })).toBeTruthy();
  const first = (screen.getByLabelText('Seed') as HTMLInputElement).value;
  fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
  const next = (screen.getByLabelText('Seed') as HTMLInputElement).value;
  expect(Number(next)).toBeGreaterThanOrEqual(0);
  expect(Number(next)).toBeLessThanOrEqual(2147483647);
  expect(first).not.toBe('');
  fireEvent.click(screen.getByRole('button', { name: 'Run freeform' }));
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    'llama.cpp inference failed (HTTP 500)',
  );
  expect(screen.getByText('No completions yet.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Locked' }));
  expect(screen.getByRole('button', { name: 'Unlocked' })).toBeTruthy();
});
