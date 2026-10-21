import { expect, it, vi } from 'vitest';
import { ScheduledSplitInference, splitRequests, type SplitScheduling } from './split-inference';
import { strictProviderSchema } from './remote-inference-adapter';
import { normalizeStageMemory } from './stage-output';
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

it('encodes optional Vision fields as nullable required strict-provider properties and restores omission', () => {
  const stage = {
    observer: { visionOptionalFields: ['confidence', 'notes'] as ('confidence' | 'notes')[] },
  };
  const request = splitRequests(input, stage).vision;
  const strict = strictProviderSchema(request.response.schema);
  expect(strict).toMatchObject({
    required: ['events', 'messages', 'sceneState', 'confidence', 'notes'],
    properties: { confidence: { type: ['number', 'null'] }, notes: { type: ['string', 'null'] } },
  });
  expect(normalizeStageMemory({ ...scene, confidence: null, notes: null }, request)).toEqual(scene);
});

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

it('retries unacknowledged Vision events after Chat fails without creating duplicate triggers', async () => {
  let visionCalls = 0;
  const changedScene = {
    ...scene,
    sceneState: 'The race moves to another track',
    events: [{ kind: 'reaction', summary: 'A new racer appears', ageMs: 0 }],
  };
  const vision = adapter(async () => {
    const output = ++visionCalls === 1 ? scene : changedScene;
    return { raw: output, normalized: output };
  });
  let attempts = 0;
  const chatter = adapter(async () => {
    attempts++;
    if (attempts === 1) throw new Error('Chat connection failed');
    return {
      raw: { ...chat, events: [scene.events[0]] },
      normalized: { ...chat, events: [scene.events[0]] },
    };
  });
  const scheduled = new ScheduledSplitInference();
  let time = 0;
  const execute = (cycle: number) =>
    scheduled.execute(
      {
        ...input,
        cycle,
        frames: input.frames?.map((frame) => ({ ...frame, observedAt: cycle === 1 ? 2000 : 3000 })),
      },
      { vision, chat: chatter },
      new AbortController().signal,
      undefined,
      {},
      { ...policy, execution: 'sequential', strictWait: true, maximumWaitMs: 500 },
      () => time,
    );
  await expect(execute(1)).rejects.toThrow('Chat connection failed');
  const initialRequest = vi.mocked(chatter.complete).mock.calls[0][0];
  time = 1000;
  const retry = await execute(2);
  expect(retry?.visionEvents).toHaveLength(1);
  expect(retry?.accepted.events).toHaveLength(1);
  expect(retry?.observations[0].description).toBe(scene.sceneState);
  const retryRequest = vi.mocked(chatter.complete).mock.calls[1][0];
  expect(retryRequest).toEqual(initialRequest);
  expect(Object.isFrozen(retryRequest)).toBe(true);
  time = 1100;
  const next = await execute(3);
  expect(next?.visionEvents).toHaveLength(1);
  expect(next?.observations[0].description).toBe(changedScene.sceneState);
});

it('keeps newer Vision pending when the frozen Chat retry only consumed an earlier revision', async () => {
  const sceneB = {
    sceneState: 'A second racer takes the lead',
    events: [{ kind: 'reaction', summary: 'Second racer leads', ageMs: 0 }],
    messages: [],
  };
  const vision = adapter(
    vi.fn(async () => {
      const result = vi.mocked(vision.complete).mock.calls.length === 1 ? scene : sceneB;
      return { raw: result, normalized: result };
    }),
  );
  let chatAttempts = 0;
  const chatter = adapter(async () => {
    if (++chatAttempts === 1) throw new Error('Chat temporarily unavailable');
    return { raw: chat, normalized: chat };
  });
  const scheduler = new ScheduledSplitInference();
  const signal = new AbortController().signal;
  let time = 0;
  const execute = (cycle: number, work: 'vision' | 'chat') =>
    scheduler.execute(
      {
        ...input,
        cycle,
        boundary: {
          ...input.boundary!,
          throughMs: 2000 + cycle * 1000,
        },
        frames: input.frames?.map((frame) => ({
          ...frame,
          observedAt: cycle < 3 ? 2000 : 3000,
        })),
      },
      { vision, chat: chatter },
      signal,
      undefined,
      {},
      { ...policy, maximumAgeMs: 10000 },
      () => time,
      work,
    );

  // Vision A is available when the initial Chat request is frozen.
  await execute(1, 'vision');
  await settle();
  expect(scheduler.hasUnconsumedVision()).toBe(true);
  time = 100;
  await expect(execute(2, 'chat')).rejects.toThrow('Chat temporarily unavailable');
  const frozenRequest = vi.mocked(chatter.complete).mock.calls[0][0];
  expect(JSON.stringify(frozenRequest.content)).toContain(scene.sceneState);
  expect(JSON.stringify(frozenRequest.content)).not.toContain(sceneB.sceneState);

  // Independent Vision produces B while the Chat retry still owns A.
  time = 1000;
  await execute(3, 'vision');
  await settle();
  expect(vision.complete).toHaveBeenCalledTimes(2);

  time = 1100;
  const retry = await execute(4, 'chat');
  expect(retry?.observations[0].description).toBe(scene.sceneState);
  expect(vi.mocked(chatter.complete).mock.calls[1][0]).toBe(frozenRequest);
  expect(scheduler.hasUnconsumedVision()).toBe(true);

  // EOF's Chat-only handoff consumes B without triggering another Vision.
  time = 1200;
  const final = await execute(5, 'chat');
  expect(final?.observations[0].description).toBe(sceneB.sceneState);
  expect(final?.visionEvents.map((event) => event.summary)).toContain(sceneB.events[0].summary);
  expect(scheduler.hasUnconsumedVision()).toBe(false);
  expect(vision.complete).toHaveBeenCalledTimes(2);
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

it('bounds strict sequential waiting without publishing Chat or cancelling unfinished Vision', async () => {
  vi.useFakeTimers();
  try {
    let finishVision!: (value: typeof scene) => void;
    const pendingVision = new Promise<typeof scene>((resolve) => {
      finishVision = resolve;
    });
    const vision = adapter(async () => {
      const result = await pendingVision;
      return { raw: result, normalized: result };
    });
    const chatter = adapter(async () => ({ raw: chat, normalized: chat }));
    const scheduled = new ScheduledSplitInference();
    let time = 0;
    const bounded: SplitScheduling = {
      ...policy,
      execution: 'sequential',
      maximumWaitMs: 40,
      strictWait: true,
      chatIntervalMs: 100,
    };
    const waiting = scheduled.execute(
      input,
      { vision, chat: chatter },
      new AbortController().signal,
      undefined,
      {},
      bounded,
      () => time,
    );
    await settle();
    await vi.advanceTimersByTimeAsync(39);
    expect(chatter.complete).not.toHaveBeenCalled();
    time = 40;
    await vi.advanceTimersByTimeAsync(1);
    expect(await waiting).toBeNull();
    expect(chatter.complete).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    // A slow but successful Vision result can still feed a later eligible Chat.
    finishVision(scene);
    await settle();
    time = 100;
    const next = await scheduled.execute(
      { ...input, cycle: 2 },
      { vision, chat: chatter },
      new AbortController().signal,
      undefined,
      {},
      bounded,
      () => time,
    );
    expect(next?.observations[0].description).toBe(scene.sceneState);
    expect(chatter.complete).toHaveBeenCalledTimes(1);
    expect(vision.complete).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it('releases the sequential wait deadline on Stop without publishing cancelled work', async () => {
  vi.useFakeTimers();
  try {
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
    const waiting = scheduled.execute(
      input,
      { vision, chat: chatter },
      abort.signal,
      undefined,
      {},
      {
        ...policy,
        execution: 'sequential',
        strictWait: true,
        maximumWaitMs: 10_000,
      },
      () => 0,
    );
    await settle();
    expect(vi.getTimerCount()).toBe(1);
    abort.abort();
    scheduled.cancelActive();
    expect(await waiting).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    finishVision(scene);
    await settle();
    expect(chatter.complete).not.toHaveBeenCalled();
    expect(scheduled.hasUnconsumedVision()).toBe(false);
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
    { ...policy, execution: 'sequential', maximumWaitMs: 500, strictWait: true },
    () => 0,
  );
  await settle();
  expect(chatter.complete).not.toHaveBeenCalled();
  resolveVision(scene);
  expect((await running)?.observations[0].description).toBe(scene.sceneState);
  expect(chatter.complete).toHaveBeenCalledTimes(1);
});

it('replaces a completed old-source scene when the new source has an earlier observation clock', async () => {
  const otherScene = {
    sceneState: 'Different camera angle',
    events: [{ kind: 'reaction', summary: 'Now on camera B', ageMs: 0 }],
    messages: [],
  };
  let count = 0;
  const vision = adapter(async () => {
    const result = ++count === 1 ? scene : otherScene;
    return { raw: result, normalized: result };
  });
  const chatter = adapter(async () => ({ raw: chat, normalized: chat }));
  const scheduled = new ScheduledSplitInference();
  const signal = new AbortController().signal;
  const scheduling = { ...policy, visionIntervalMs: 100, chatIntervalMs: 100 };
  let time = 0;
  const source = (sourceId: string, observedAt: number, cycle: number) => ({
    ...input,
    cycle,
    frames: input.frames!.map((frame) => ({ ...frame, sourceId, observedAt })),
  });
  await scheduled.execute(
    source('A', 2000, 1),
    { vision, chat: chatter },
    signal,
    undefined,
    {},
    scheduling,
    () => time,
    'vision',
  );
  await settle();
  time = 100;
  await scheduled.execute(
    source('B', 1000, 2),
    { vision, chat: chatter },
    signal,
    undefined,
    {},
    scheduling,
    () => time,
    'vision',
  );
  await settle();
  time = 200;
  const output = await scheduled.execute(
    source('B', 1000, 3),
    { vision, chat: chatter },
    signal,
    undefined,
    {},
    scheduling,
    () => time,
    'chat',
  );
  expect(output?.observations.map((item) => item.description)).toEqual([otherScene.sceneState]);
});

it('rejects old-source Vision completing after an input-source change', async () => {
  let finishOld!: (result: typeof scene) => void;
  const waiting = new Promise<typeof scene>((resolve) => {
    finishOld = resolve;
  });
  const newScene = {
    sceneState: 'A new scene from camera B',
    events: [{ kind: 'reaction', summary: 'Camera B wins', ageMs: 0 }],
    messages: [],
  };
  let count = 0;
  const vision = adapter(async () => {
    const result = ++count === 1 ? await waiting : newScene;
    return { raw: result, normalized: result };
  });
  const chatter = adapter(async () => ({ raw: chat, normalized: chat }));
  const scheduled = new ScheduledSplitInference();
  const signal = new AbortController().signal;
  const stagePolicy = { ...policy, visionIntervalMs: 100, chatIntervalMs: 100 };
  const byCamera = (sourceId: string, cycle: number) => ({
    ...input,
    cycle,
    frames: input.frames!.map((frame) => ({ ...frame, sourceId })),
  });
  let time = 0;
  await scheduled.execute(
    byCamera('A', 1),
    { vision, chat: chatter },
    signal,
    undefined,
    {},
    stagePolicy,
    () => time,
    'vision',
  );
  time = 100;
  await scheduled.execute(
    byCamera('B', 2),
    { vision, chat: chatter },
    signal,
    undefined,
    {},
    stagePolicy,
    () => time,
    'vision',
  );
  expect(vision.complete).toHaveBeenCalledTimes(1); // old Vision is still running
  finishOld(scene);
  await settle();
  time = 200;
  await scheduled.execute(
    byCamera('B', 3),
    { vision, chat: chatter },
    signal,
    undefined,
    {},
    stagePolicy,
    () => time,
    'vision',
  );
  await settle();
  time = 300;
  const output = await scheduled.execute(
    byCamera('B', 4),
    { vision, chat: chatter },
    signal,
    undefined,
    {},
    stagePolicy,
    () => time,
    'chat',
  );
  expect(output?.observations.map((item) => item.description)).toEqual([newScene.sceneState]);
  expect(output?.visionEvents.map((item) => item.summary)).toEqual(['Camera B wins']);
  expect(JSON.stringify(vi.mocked(chatter.complete).mock.lastCall?.[0])).not.toContain(
    scene.sceneState,
  );
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
