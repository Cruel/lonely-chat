import { expect, it, vi } from 'vitest';
import { ScheduledSplitInference, type SplitScheduling } from './split-inference';
import type { InferenceInput } from './fake-inference';
import type { UnifiedInferenceAdapter } from './inference-coordinator';

const input: InferenceInput = {
  context: 'A race',
  cycle: 1,
  chatActivity: 'normal',
  roster: [{ author: 'viewer', color: '#123456' }],
  boundary: { fromSequence: 0, throughSequence: 1, fromMs: 1000, throughMs: 2000 },
  frames: [
    {
      sourceId: 'cam',
      observedAt: 2000,
      dataUrl: 'data:image/jpeg;base64,AAAA',
      width: 1,
      height: 1,
    },
  ],
};
const policy: SplitScheduling = {
  execution: 'asynchronous',
  visionIntervalMs: 1000,
  chatIntervalMs: 100,
  maximumWaitMs: 0,
  maximumAgeMs: 500,
  strictWait: false,
};
const scene = {
  sceneState: 'A racer crosses the line',
  events: [{ kind: 'reaction', summary: 'Finished!', ageMs: 0 }],
  messages: [],
};
const chat = {
  events: [],
  messages: [{ author: 'viewer', color: '#123456', text: 'GG', offsetMs: 0 }],
};
function adapter(run: UnifiedInferenceAdapter['complete']): UnifiedInferenceAdapter {
  return { capabilities: { images: true }, complete: vi.fn(run) };
}
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

it('allows fast Chat to proceed while slow Vision finishes, then adopts eligible text once', async () => {
  let finishVision!: (result: typeof scene) => void;
  const pending = new Promise<typeof scene>((resolve) => {
    finishVision = resolve;
  });
  const vision = adapter(async () => {
    const result = await pending;
    return { raw: result, normalized: result };
  });
  const chatter = adapter(async () => ({ raw: chat, normalized: chat }));
  const scheduled = new ScheduledSplitInference();
  const signal = new AbortController().signal;
  let time = 0;
  const execute = (cycle: number) =>
    scheduled.execute(
      { ...input, cycle },
      { vision, chat: chatter },
      signal,
      undefined,
      {},
      policy,
      () => time,
    );
  const first = await execute(1);
  expect(first?.observations).toEqual([]);
  expect(vision.complete).toHaveBeenCalledTimes(1);
  time = 100;
  const second = await execute(2);
  expect(second?.visionEvents).toEqual([]);
  finishVision(scene);
  await settle();
  time = 200;
  const third = await execute(3);
  expect(third?.observations[0].description).toBe('A racer crosses the line');
  expect(third?.visionEvents).toHaveLength(1);
  expect(JSON.stringify(vi.mocked(chatter.complete).mock.lastCall?.[0].content)).not.toContain(
    'data:image',
  );
  time = 300;
  const fourth = await execute(4);
  expect(fourth?.visionEvents).toHaveLength(0);
  time = 701;
  const expired = await execute(5);
  expect(expired?.observations).toEqual([]);
});

it('uses a bounded sequential wait before Chat proceeds without stale observations', async () => {
  vi.useFakeTimers();
  try {
    let resolveVision!: (value: typeof scene) => void;
    const waiting = new Promise<typeof scene>((resolve) => {
      resolveVision = resolve;
    });
    const vision = adapter(async () => {
      const result = await waiting;
      return { raw: result, normalized: result };
    });
    const chatter = adapter(async () => ({ raw: chat, normalized: chat }));
    const scheduler = new ScheduledSplitInference();
    let time = 0;
    const bounded = {
      ...policy,
      execution: 'sequential' as const,
      maximumWaitMs: 50,
    };
    const first = scheduler.execute(
      input,
      { vision, chat: chatter },
      new AbortController().signal,
      undefined,
      {},
      bounded,
      () => time,
    );
    await settle();
    expect(chatter.complete).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    time = 50;
    expect((await first)?.observations).toEqual([]);
    expect(chatter.complete).toHaveBeenCalledTimes(1);
    resolveVision(scene);
    await settle();
    time = 100;
    const next = await scheduler.execute(
      { ...input, cycle: 2 },
      { vision, chat: chatter },
      new AbortController().signal,
      undefined,
      {},
      bounded,
      () => time,
    );
    expect(next?.observations[0].description).toBe(scene.sceneState);
  } finally {
    vi.useRealTimers();
  }
});

it('requires an eligible observation when strict wait is configured', async () => {
  let resolveVision!: (value: typeof scene) => void;
  const waiting = new Promise<typeof scene>((resolve) => {
    resolveVision = resolve;
  });
  const vision = adapter(async () => {
    const result = await waiting;
    return { raw: result, normalized: result };
  });
  const chatter = adapter(async () => ({ raw: chat, normalized: chat }));
  const scheduler = new ScheduledSplitInference();
  const running = scheduler.execute(
    input,
    { vision, chat: chatter },
    new AbortController().signal,
    undefined,
    {},
    { ...policy, execution: 'sequential', maximumWaitMs: 0, strictWait: true },
    () => 0,
  );
  await settle();
  expect(chatter.complete).not.toHaveBeenCalled();
  resolveVision(scene);
  expect((await running)?.observations[0].description).toBe(scene.sceneState);
  expect(chatter.complete).toHaveBeenCalledTimes(1);
});

it('discards completion after Run cancellation and does not accept it in the next Run', async () => {
  let finishVision!: (result: typeof scene) => void;
  const pending = new Promise<typeof scene>((resolve) => {
    finishVision = resolve;
  });
  const vision = adapter(async () => {
    const result = await pending;
    return { raw: result, normalized: result };
  });
  const chatter = adapter(async () => ({ raw: chat, normalized: chat }));
  const scheduled = new ScheduledSplitInference();
  const abort = new AbortController();
  await scheduled.execute(
    input,
    { vision, chat: chatter },
    abort.signal,
    undefined,
    {},
    policy,
    () => 0,
  );
  abort.abort();
  scheduled.reset();
  finishVision(scene);
  await settle();
  const output = await scheduled.execute(
    input,
    {
      vision: adapter(async () => ({ raw: scene, normalized: scene })),
      chat: chatter,
    },
    new AbortController().signal,
    undefined,
    {},
    policy,
    () => 1,
  );
  expect(output?.observations).toEqual([]);
});
