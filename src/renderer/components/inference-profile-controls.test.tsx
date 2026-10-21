// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { DesktopAPI } from '../../shared/chat-contract';
import type { InferenceProfile } from '../../shared/inference-profile-contract';
import { InferenceProfileControls } from './inference-profile-controls';

it('resolves an unsaved Split profile against editable input through the main-process builder', async () => {
  const profile: InferenceProfile = {
    id: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
    name: 'Split',
    revision: 1,
    values: {
      topology: 'split',
      roles: {
        observer: { kind: 'local', modelId: 'vision' },
        chat: { kind: 'local', modelId: 'chat' },
      },
      stageDefaults: {},
    },
  };
  const previewStages = vi.fn(async () => ({
    vision: { instructions: 'resolved' },
    chat: { role: 'chat' },
  }));
  window.lonelyChat = {
    listInferenceProfiles: async () => [profile],
    listInferenceProfileRevisions: async () => [profile],
    getModelsSnapshot: async () => ({
      installations: [],
      active: { 'vision-language': null, 'speech-to-text': null },
    }),
    previewStages,
  } as unknown as DesktopAPI;
  const choose = vi.fn();
  const view = render(
    <InferenceProfileControls
      selectedId={profile.id}
      selectedRevision={1}
      onSelect={choose}
      remoteCatalog={{ connections: [], models: [] }}
      disabled={false}
    />,
  );
  fireEvent.click(screen.getByText(/Advanced: edit inference profiles/));
  await waitFor(() =>
    expect((screen.getByLabelText('Profile name') as HTMLInputElement).value).toBe('Split'),
  );
  await waitFor(() => expect(screen.getByLabelText('Profile stage defaults')).toBeTruthy());
  fireEvent.change(screen.getByLabelText('Profile stage defaults'), {
    target: {
      value: JSON.stringify({ observer: { systemPrompt: 'Unsaved {{context}}' }, chat: {} }),
    },
  });
  fireEvent.click(screen.getByText('Preview stage configuration'));
  fireEvent.change(screen.getByLabelText('Stage preview input'), {
    target: { value: JSON.stringify({ context: 'Live edit', cycle: 7, frames: [] }) },
  });
  fireEvent.click(screen.getByText('Resolve current request'));
  await waitFor(() =>
    expect(previewStages).toHaveBeenCalledWith(
      expect.objectContaining({ context: 'Live edit', cycle: 7 }),
      expect.objectContaining({ observer: { systemPrompt: 'Unsaved {{context}}' } }),
      [],
      [],
    ),
  );
  expect(screen.getByLabelText('Stage request preview').textContent).toContain('resolved');
  view.unmount();
});

afterEach(() => {
  cleanup();
  delete window.lonelyChat;
});

it('selects a pinned revision independently of prompt presets and edits role assignments without credentials', async () => {
  const first: InferenceProfile = {
    id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
    name: 'Stream',
    revision: 1,
    values: {
      topology: 'unified',
      roles: { unified: { kind: 'remote', modelId: 'model-a' } },
      stageDefaults: {},
    },
  };
  const second: InferenceProfile = {
    ...first,
    revision: 2,
    values: {
      ...first.values,
      stageDefaults: { unified: { settings: { cycleIntervalMs: 5000 } } },
    },
  };
  const choose = vi.fn();
  const save = vi.fn(async () => second);
  window.lonelyChat = {
    listInferenceProfiles: async () => [second],
    listInferenceProfileRevisions: async () => [first, second],
    getModelsSnapshot: async () => ({
      installations: [],
      active: { 'vision-language': null, 'speech-to-text': null },
    }),
    saveInferenceProfile: save,
  } as unknown as DesktopAPI;

  const { rerender } = render(
    <InferenceProfileControls
      selectedId=""
      selectedRevision={null}
      onSelect={choose}
      remoteCatalog={{
        connections: [],
        models: [
          {
            id: 'model-a',
            name: 'Cloud',
            connectionId: 'connection',
            model: 'model',
            images: true,
            outputFormat: 'prompt-json',
            allowRemoteImages: false,
          },
        ],
      }}
      disabled={false}
    />,
  );
  fireEvent.change(await screen.findByLabelText('Inference Profile'), {
    target: { value: first.id },
  });
  await waitFor(() => expect(choose).toHaveBeenCalledWith(second));
  rerender(
    <InferenceProfileControls
      selectedId={first.id}
      selectedRevision={2}
      onSelect={choose}
      remoteCatalog={{ connections: [], models: [] }}
      disabled={false}
    />,
  );
  fireEvent.change(await screen.findByLabelText('Revision'), { target: { value: '1' } });
  await waitFor(() => expect(choose).toHaveBeenCalledWith(first));
  fireEvent.click(screen.getByText(/Advanced: edit inference profiles/));
  expect(screen.getByLabelText('unified model')).toBeTruthy();
  fireEvent.click(screen.getByText('Save revision'));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: first.id,
        name: 'Stream',
        values: expect.objectContaining({ topology: 'unified' }),
      }),
    ),
  );
  expect(JSON.stringify(save.mock.calls)).not.toContain('apiKey');
});
