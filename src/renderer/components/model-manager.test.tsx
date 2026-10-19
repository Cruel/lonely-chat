// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ModelManager } from './model-manager';
import type { DesktopAPI } from '../../shared/chat-contract';
import type { ModelDiscoveryResult } from '../../shared/model-contract';
import type { ModelManagerSnapshot } from '../../shared/model-install-contract';

const emptyModels: ModelManagerSnapshot = {
  storageDirectory: '/models',
  installations: [],
  active: { 'vision-language': null, 'speech-to-text': null },
  progress: { phase: 'idle', file: null, receivedBytes: 0, totalBytes: null },
};
const modelAPI = {
  setModelProjector: async () => emptyModels,
  installModelProjector: async () => emptyModels,
  getModelsSnapshot: async () => emptyModels,
  onModelsChange: () => () => {},
  installModel: async () => emptyModels,
  cancelModelDownload: async () => {},
  activateModel: async () => emptyModels,
  removeModel: async () => emptyModels,
  chooseModelDirectory: async () => emptyModels,
};

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
  window.lonelyChat = { ...modelAPI, discoverModels } as unknown as DesktopAPI;
  render(<ModelManager />);
  const source = 'https://huggingface.co/acme/stream-model/resolve/main/model-Q4_K_M.gguf';
  fireEvent.change(screen.getByLabelText('Repository or file URL'), { target: { value: source } });
  fireEvent.click(screen.getByRole('button', { name: 'Discover files' }));
  await waitFor(() => expect(discoverModels).toHaveBeenCalledWith(source));
  const model = await screen.findByRole('combobox', { name: 'Choose model weights' });
  expect(model.textContent).toContain('model-Q4_K_M.gguf');
  expect(screen.queryByRole('radio')).toBeNull();
  expect(screen.getByText(/Several companions are available/)).toBeTruthy();
  const projector = screen.getByRole('combobox', { name: /^Vision projector candidate/ });
  expect(projector.textContent).toContain('Choose a projector');
  const user = userEvent.setup();
  await user.click(projector);
  expect(
    document.querySelector('[data-slot="select-content"]')?.getAttribute('data-align-trigger'),
  ).toBe('true');
  await user.click(await screen.findByRole('option', { name: /mmproj-F16.gguf/i }));
  expect(projector.textContent).toContain('mmproj-F16.gguf');
  expect(screen.getByText(/projector: mmproj-F16.gguf/)).toBeTruthy();
});

it('changes a preselected model through a Select without retaining an incompatible projector', async () => {
  const second = {
    ...discovered.candidates[0],
    id: 'model-Q8_0.gguf',
    quantization: 'Q8_0',
    sizeBytes: 8192,
    files: [{ path: 'model-Q8_0.gguf', sizeBytes: 8192 }],
    compatibleProjectorIds: [],
  };
  const discoverModels = vi.fn(async () => ({
    ...discovered,
    candidates: [...discovered.candidates, second],
  }));
  window.lonelyChat = { ...modelAPI, discoverModels } as unknown as DesktopAPI;
  render(<ModelManager />);
  fireEvent.change(screen.getByLabelText('Repository or file URL'), {
    target: { value: 'acme/stream-model' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Discover files' }));
  const model = await screen.findByRole('combobox', { name: 'Choose model weights' });
  expect(model.textContent).toContain('model-Q4_K_M.gguf');
  const user = userEvent.setup();
  await user.click(model);
  await user.click(await screen.findByRole('option', { name: /model-Q8_0.gguf/i }));
  expect(model.textContent).toContain('model-Q8_0.gguf');
  expect(screen.getByRole('button', { name: /Add Projector Model/ })).toBeTruthy();
  expect(
    screen.getByRole('combobox', { name: /^Vision projector candidate/ }).textContent,
  ).toContain('Choose a projector');
  expect(screen.getByText(/Selected 1 model file/).textContent).not.toContain('projector:');
  expect(screen.queryByText(/Select a projector explicitly for model-Q4_K_M.gguf/)).toBeNull();
});

it('installs selected weights/projector, activates them, and removes managed packages', async () => {
  const entry = {
    id: '0123456789abcdef0123456789abcdef',
    repo: discovered.repo,
    revision: 'main',
    candidateId: discovered.candidates[0].id,
    projectorId: 'mmproj-F16.gguf',
    role: 'vision-language' as const,
    installedAt: 123,
    files: [
      {
        path: 'model-Q4_K_M.gguf',
        relativePath: 'files/model-Q4_K_M.gguf',
        sha256: 'a'.repeat(64),
        sizeBytes: 4096,
      },
    ],
  };
  let state = emptyModels;
  const installModel = vi.fn(async () => {
    state = { ...state, installations: [entry] };
    return state;
  });
  const activateModel = vi.fn(async () => {
    state = { ...state, active: { ...state.active, 'vision-language': entry.id } };
    return state;
  });
  const removeModel = vi.fn(async () => {
    state = { ...emptyModels };
    return state;
  });
  const chooseModelDirectory = vi.fn(async () => state);
  window.lonelyChat = {
    ...modelAPI,
    discoverModels: async () => discovered,
    installModel,
    activateModel,
    removeModel,
    chooseModelDirectory,
  } as unknown as DesktopAPI;
  render(<ModelManager />);
  fireEvent.change(screen.getByLabelText('Repository or file URL'), {
    target: { value: 'acme/stream-model' },
  });
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Discover files' }));
  const install = await screen.findByRole('button', { name: 'Install selected model' });
  expect(install.hasAttribute('disabled')).toBe(true);
  await user.click(screen.getByRole('combobox', { name: /^Vision projector candidate/ }));
  await user.click(await screen.findByRole('option', { name: /mmproj-F16.gguf/i }));
  await user.click(install);
  await waitFor(() =>
    expect(installModel).toHaveBeenCalledWith({
      source: 'acme/stream-model',
      candidateId: 'model-Q4_K_M.gguf',
      projectorId: 'mmproj-F16.gguf',
    }),
  );
  await user.click(await screen.findByRole('button', { name: /^Activate$/ }));
  await waitFor(() => expect(activateModel).toHaveBeenCalledWith('vision-language', entry.id));
  await user.click(await screen.findByRole('button', { name: /^Remove$/ }));
  await waitFor(() => expect(removeModel).toHaveBeenCalledWith(entry.id));
  await user.click(await screen.findByRole('button', { name: 'Choose folder' }));
  expect(chooseModelDirectory).toHaveBeenCalledOnce();
});

it('lets the user override automatic recognition with any other GGUF in the repository', async () => {
  const extra = {
    ...discovered.candidates[0],
    id: 'unrecognized-Q8_0.gguf',
    quantization: 'Q8_0',
    files: [{ path: 'unrecognized-Q8_0.gguf', sizeBytes: 1024 }],
    compatibleProjectorIds: [],
    suggestedProjectorId: null,
  };
  const installModel = vi.fn(async () => emptyModels);
  window.lonelyChat = {
    ...modelAPI,
    discoverModels: async () => ({
      ...discovered,
      projectors: [],
      candidates: [
        { ...discovered.candidates[0], compatibleProjectorIds: [], suggestedProjectorId: null },
        extra,
      ],
    }),
    installModel,
  } as unknown as DesktopAPI;
  render(<ModelManager />);
  fireEvent.change(screen.getByLabelText('Repository or file URL'), {
    target: { value: 'acme/stream-model' },
  });
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Discover files' }));
  await screen.findByRole('combobox', { name: 'Choose model weights' });
  await user.click(screen.getByRole('button', { name: /Add Projector Model/ }));
  await user.click(screen.getByRole('combobox', { name: /^Vision projector candidate/ }));
  await user.click(
    await screen.findByRole('option', { name: /Same repository: unrecognized-Q8_0.gguf/ }),
  );
  await user.click(screen.getByRole('button', { name: 'Install selected model' }));
  await waitFor(() =>
    expect(installModel).toHaveBeenCalledWith({
      source: 'acme/stream-model',
      candidateId: 'model-Q4_K_M.gguf',
      projectorId: 'unrecognized-Q8_0.gguf',
    }),
  );
});

it('can assign another installed GGUF as projector without downloading files again', async () => {
  const base = {
    id: '0123456789abcdef0123456789abcdef',
    repo: 'acme/stream-model',
    revision: 'main',
    candidateId: 'base-Q4_K_M.gguf',
    projectorId: null,
    role: 'vision-language' as const,
    installedAt: 1,
    files: [
      {
        path: 'base-Q4_K_M.gguf',
        relativePath: 'files/base-Q4_K_M.gguf',
        sizeBytes: 3,
        sha256: 'a'.repeat(64),
      },
    ],
  };
  const provider = {
    ...base,
    id: '123456789abcdef0123456789abcdef0',
    candidateId: 'other-Q8_0.gguf',
  };
  const state = { ...emptyModels, installations: [base, provider] };
  const setModelProjector = vi.fn(async () => ({
    ...state,
    projectorAssignments: { [base.id]: provider.id },
  }));
  window.lonelyChat = {
    ...modelAPI,
    getModelsSnapshot: async () => state,
    discoverModels: async () => discovered,
    setModelProjector,
  } as unknown as DesktopAPI;
  render(<ModelManager />);
  const user = userEvent.setup();
  await user.click((await screen.findAllByRole('button', { name: /Manage Projector/ }))[0]);
  await user.click(screen.getByRole('button', { name: /Add Projector Model/ }));
  await user.click(screen.getByRole('combobox', { name: /^Vision projector candidate/ }));
  await user.click(
    await screen.findByRole('option', { name: /Installed: acme\/stream-model \/ other-Q8_0.gguf/ }),
  );
  await user.click(screen.getByRole('button', { name: 'Save projector' }));
  await waitFor(() => expect(setModelProjector).toHaveBeenCalledWith(base.id, provider.id));
});

it('allows choosing a GGUF in another Hugging Face repository after installation', async () => {
  const base = {
    id: '0123456789abcdef0123456789abcdef',
    repo: 'acme/stream-model',
    revision: 'main',
    candidateId: 'base-Q4_K_M.gguf',
    projectorId: null,
    role: 'vision-language' as const,
    installedAt: 1,
    files: [
      {
        path: 'base-Q4_K_M.gguf',
        relativePath: 'files/base-Q4_K_M.gguf',
        sizeBytes: 3,
        sha256: 'a'.repeat(64),
      },
    ],
  };
  const state = { ...emptyModels, installations: [base] };
  const installModelProjector = vi.fn(async () => state);
  window.lonelyChat = {
    ...modelAPI,
    getModelsSnapshot: async () => state,
    discoverModels: async (source: string) =>
      source === 'other/projector'
        ? {
            ...discovered,
            repo: 'other/projector',
            candidates: [],
            projectors: [discovered.projectors[0]],
          }
        : discovered,
    installModelProjector,
  } as unknown as DesktopAPI;
  render(<ModelManager />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: /Manage Projector/ }));
  await user.click(screen.getByRole('button', { name: /Add Projector Model/ }));
  fireEvent.change(screen.getByLabelText('Other Hugging Face repository or file URL'), {
    target: { value: 'other/projector' },
  });
  await user.click(screen.getByRole('button', { name: 'Find GGUFs' }));
  await screen.findByText(/Found 1 GGUF artifacts/);
  await user.click(screen.getByRole('combobox', { name: /^Vision projector candidate/ }));
  await user.click(await screen.findByRole('option', { name: /Hugging Face: mmproj-F16.gguf/ }));
  await user.click(screen.getByRole('button', { name: 'Save projector' }));
  await waitFor(() =>
    expect(installModelProjector).toHaveBeenCalledWith(
      base.id,
      'other/projector',
      'mmproj-F16.gguf',
    ),
  );
});

it('allows live VLM switching but not deactivation during an active native session', async () => {
  const installed = (id: string) => ({
    id,
    repo: 'acme/stream',
    revision: 'main',
    candidateId: `${id}.gguf`,
    projectorId: null,
    role: 'vision-language' as const,
    installedAt: 1,
    files: [
      {
        path: `${id}.gguf`,
        relativePath: `files/${id}.gguf`,
        sizeBytes: 128,
        sha256: 'a'.repeat(64),
      },
    ],
  });
  const active = 'model-old';
  const replacement = 'model-new';
  const manager = {
    ...emptyModels,
    installations: [installed(active), installed(replacement)],
    active: { ...emptyModels.active, 'vision-language': active },
  };
  const activateModel = vi.fn(async () => ({
    ...manager,
    active: { ...manager.active, 'vision-language': replacement },
  }));
  window.lonelyChat = {
    ...modelAPI,
    getModelsSnapshot: async () => manager,
    activateModel,
  } as unknown as DesktopAPI;
  render(<ModelManager sessionMode="native" sessionPhase="running" />);
  expect((await screen.findByRole('button', { name: 'Deactivate' })).hasAttribute('disabled')).toBe(
    true,
  );
  expect(
    screen.getAllByRole('button', { name: /Manage Projector/ })[0].hasAttribute('disabled'),
  ).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Switch to this model' }));
  await waitFor(() => expect(activateModel).toHaveBeenCalledWith('vision-language', replacement));
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
  window.lonelyChat = { ...modelAPI, discoverModels } as unknown as DesktopAPI;
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
