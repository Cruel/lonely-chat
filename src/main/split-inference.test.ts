import { expect, it, vi } from 'vitest';
import { SequentialSplitInference } from './split-inference';
import type { InferenceInput } from './fake-inference';
import type { UnifiedInferenceAdapter } from './inference-coordinator';

const input: InferenceInput = {
  context: 'A reunion at the station',
  cycle: 1,
  chatActivity: 'normal',
  roster: [{ author: 'viewer', color: '#123456' }],
  boundary: { fromSequence: 1, throughSequence: 2, fromMs: 1000, throughMs: 3000 },
  frames: [
    {
      sourceId: 'camera',
      observedAt: 2000,
      dataUrl: 'data:image/jpeg;base64,AAAA',
      width: 320,
      height: 180,
    },
  ],
};
const visionOutput = {
  sceneState: 'They are at a station',
  events: [
    { kind: 'reaction', summary: 'A person arrives', ageMs: 1000 },
    { kind: 'context', summary: 'They are at a station', ageMs: 500 },
  ],
  messages: [],
};
const chatOutput = {
  events: [],
  messages: [{ author: 'viewer', color: '#123456', text: 'They made it!', offsetMs: 400 }],
};
const adapter = (output: unknown, images: boolean): UnifiedInferenceAdapter => ({
  capabilities: { images },
  complete: vi.fn(async () => ({ raw: output, normalized: output })),
});
it('runs timestamped Vision first and passes only accepted textual findings to Chat', async () => {
  const vision = adapter(visionOutput, true);
  const chat = adapter(chatOutput, false);
  const result = await new SequentialSplitInference().execute(
    input,
    { vision, chat },
    new AbortController().signal,
  );
  const visionRequest = vi.mocked(vision.complete).mock.calls[0][0];
  const chatRequest = vi.mocked(chat.complete).mock.calls[0][0];
  expect(visionRequest.content.filter((part) => part.type === 'image')).toHaveLength(1);
  expect(chatRequest.content.filter((part) => part.type === 'image')).toHaveLength(0);
  expect(JSON.stringify(chatRequest.content)).toContain('A person arrives');
  expect(JSON.stringify(chatRequest.content)).toContain('They are at a station');
  expect(result.observations).toEqual([
    expect.objectContaining({
      source: 'vision',
      description: 'They are at a station',
      observedAt: 2000,
    }),
  ]);
  expect(result.accepted.events).toHaveLength(2);
  expect(result.accepted.messages[0].text).toBe('They made it!');
});
it('accepts scene-only interpretations and no discrete Events', async () => {
  const visual = adapter({ sceneState: 'The room is quiet', events: [], messages: [] }, true);
  const chat = adapter(chatOutput, false);
  const result = await new SequentialSplitInference().execute(
    input,
    { vision: visual, chat },
    new AbortController().signal,
  );
  expect(result.visionEvents).toEqual([]);
  expect(result.observations).toEqual([
    expect.objectContaining({ description: 'The room is quiet' }),
  ]);
  expect(JSON.stringify(vi.mocked(chat.complete).mock.calls[0][0].content)).toContain(
    'The room is quiet',
  );
});

it('rejects invalid scene state and impossible Vision chat output before Chat starts', async () => {
  for (const output of [
    { ...visionOutput, sceneState: { private: 'object' } },
    { ...visionOutput, messages: chatOutput.messages },
    { ...visionOutput, unexpected: 'field' },
  ]) {
    const chat = adapter(chatOutput, false);
    await expect(
      new SequentialSplitInference().execute(
        input,
        { vision: adapter(output, true), chat },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(chat.complete).not.toHaveBeenCalled();
  }
});

it('pins ordered frame evidence and role-specific prompts in immutable stage requests', async () => {
  const frames = [
    { ...input.frames![0], sourceId: 'late', observedAt: 2200 },
    { ...input.frames![0], sourceId: 'early', observedAt: 1200 },
  ];
  const source = { ...input, frames };
  const vision = adapter(visionOutput, true);
  const chat = adapter(chatOutput, false);
  await new SequentialSplitInference().execute(
    source,
    { vision, chat },
    new AbortController().signal,
    undefined,
    {
      observer: { systemPrompt: 'Describe what is visible.', userPrompt: 'Track the arrival.' },
      chat: { systemPrompt: 'Respond as a friendly audience.', userPrompt: 'Stay concise.' },
    },
  );
  const visualRequest = vi.mocked(vision.complete).mock.calls[0][0];
  const chatRequest = vi.mocked(chat.complete).mock.calls[0][0];
  expect(visualRequest.role).toBe('vision');
  expect(chatRequest.role).toBe('chat');
  expect(visualRequest.instructions).toBe('Describe what is visible.');
  expect(chatRequest.instructions).toBe('Respond as a friendly audience.');
  expect(JSON.stringify(visualRequest.content)).toContain('Track the arrival.');
  expect(JSON.stringify(chatRequest.content)).toContain('Stay concise.');
  expect(
    visualRequest.content
      .filter((part) => part.type === 'image')
      .map((part) => part.type === 'image' && part.observedAt),
  ).toEqual([1200, 2200]);
  expect(Object.isFrozen(visualRequest)).toBe(true);
  expect(Object.isFrozen(chatRequest)).toBe(true);
  expect(source.frames).toEqual(frames);
});

it('rejects invalid Vision output without calling Chat', async () => {
  const chat = adapter(chatOutput, false);
  await expect(
    new SequentialSplitInference().execute(
      input,
      {
        vision: adapter(
          { ...visionOutput, events: [{ kind: 'reaction', summary: '', ageMs: 1 }] },
          true,
        ),
        chat,
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow(/invalid event/);
  expect(chat.complete).not.toHaveBeenCalled();
});
it('rejects invalid Chat output without publishing partial Vision events', async () => {
  const completed = vi.fn();
  await expect(
    new SequentialSplitInference()
      .execute(
        input,
        {
          vision: adapter(visionOutput, true),
          chat: adapter(
            { events: [], messages: [{ author: 'intruder', text: 'hi', offsetMs: 0 }] },
            false,
          ),
        },
        new AbortController().signal,
      )
      .then(completed),
  ).rejects.toThrow();
  expect(completed).not.toHaveBeenCalled();
});
it('rejects late completions after cancellation between stages', async () => {
  let finish!: (value: { raw: unknown; normalized: unknown }) => void;
  const vision: UnifiedInferenceAdapter = {
    capabilities: { images: true },
    complete: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  };
  const chat = adapter(chatOutput, false);
  const controller = new AbortController();
  const task = new SequentialSplitInference().execute(input, { vision, chat }, controller.signal);
  await Promise.resolve();
  controller.abort();
  finish({ raw: visionOutput, normalized: visionOutput });
  await expect(task).rejects.toMatchObject({ name: 'AbortError' });
  expect(chat.complete).not.toHaveBeenCalled();
});
