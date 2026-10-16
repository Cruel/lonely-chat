// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ModelManager } from './model-manager';
import type { DesktopAPI } from '../../shared/chat-contract';
import type { ModelDiscoveryResult } from '../../shared/model-contract';

afterEach(() => {
  cleanup();
  delete window.lonelyChat;
});

const discovered: ModelDiscoveryResult = {
  repo: 'acme/stream-model',
  revision: 'main',
  role: 'vision-language',
  candidates: [
    {
      id: 'model-Q4_K_M.gguf',
      role: 'vision-language',
      format: 'gguf',
      quantization: 'Q4_K_M',
      sizeBytes: 4096,
      files: [{ path: 'model-Q4_K_M.gguf', sizeBytes: 4096 }],
      compatibleProjectorIds: ['mmproj-F16.gguf', 'mmproj-BF16.gguf'],
      suggestedProjectorId: null,
    },
  ],
  projectors: [
    {
      id: 'mmproj-F16.gguf',
      quantization: 'F16',
      sizeBytes: 1024,
      files: [{ path: 'mmproj-F16.gguf', sizeBytes: 1024 }],
    },
    {
      id: 'mmproj-BF16.gguf',
      quantization: 'BF16',
      sizeBytes: 2048,
      files: [{ path: 'mmproj-BF16.gguf', sizeBytes: 2048 }],
    },
  ],
  preselectedCandidateId: 'model-Q4_K_M.gguf',
  preselectedProjectorId: null,
  warnings: ['Select a projector explicitly; companions are ambiguous.'],
};

it('browses a direct file URL, preselects weights and requires a choice for ambiguous projectors', async () => {
  const discoverModels = vi.fn(async () => discovered);
  window.lonelyChat = { discoverModels } as unknown as DesktopAPI;
  render(<ModelManager />);
  const source = 'https://huggingface.co/acme/stream-model/resolve/main/model-Q4_K_M.gguf';
  fireEvent.change(screen.getByLabelText('Repository or file URL'), { target: { value: source } });
  fireEvent.click(screen.getByRole('button', { name: 'Discover files' }));
  await waitFor(() => expect(discoverModels).toHaveBeenCalledWith(source));
  const radio = await screen.findByRole('radio', { name: /model-Q4_K_M.gguf/i });
  expect((radio as HTMLInputElement).checked).toBe(true);
  expect(screen.getByText(/Several companions are available/)).toBeTruthy();
  expect((screen.getByLabelText('Vision projector companion') as HTMLSelectElement).value).toBe('');
  fireEvent.change(screen.getByLabelText('Vision projector companion'), {
    target: { value: 'mmproj-F16.gguf' },
  });
  expect((screen.getByLabelText('Vision projector companion') as HTMLSelectElement).value).toBe(
    'mmproj-F16.gguf',
  );
  expect(screen.getByText(/projector: mmproj-F16.gguf/)).toBeTruthy();
});

it('shows actionable API failures and does not keep stale results from superseded searches', async () => {
  let resolveFirst!: (result: ModelDiscoveryResult) => void;
  const discoverModels = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    )
    .mockRejectedValueOnce(new Error('Repository not found.'));
  window.lonelyChat = { discoverModels } as unknown as DesktopAPI;
  render(<ModelManager />);
  const input = screen.getByLabelText('Repository or file URL');
  fireEvent.change(input, { target: { value: 'acme/old-repo' } });
  fireEvent.click(screen.getByRole('button', { name: 'Discover files' }));
  fireEvent.change(input, { target: { value: 'acme/new-repo' } });
  // Submitting a second search invalidates the first result.
  fireEvent.submit(input.closest('form')!);
  expect((await screen.findByRole('alert')).textContent).toMatch(/not found/i);
  resolveFirst(discovered);
  await waitFor(() => expect(screen.queryByText('acme/stream-model')).toBeNull());
});
