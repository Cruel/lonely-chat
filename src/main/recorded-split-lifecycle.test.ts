import { describe, expect, it, vi } from 'vitest';
import type { InferenceProfile } from '../shared/inference-profile-contract';
import { ChatService } from './chat-service';
import { SessionController } from './session-controller';
import type { UnifiedInferenceAdapter } from './inference-coordinator';
import { FakeClock, flushMicrotasks } from './test-support/fake-clock';

const recorded = { inputMode: 'recorded' as const, publishToOverlay: false };
const scene = {
  sceneState: 'Final frame shows the winner',
  events: [{ kind: 'reaction', summary: 'Winner revealed', ageMs: 0 }],
  messages: [],
};
const emptyScene = { sceneState: '', events: [], messages: [] };
const chatResult = {
  events: [],
  messages: [{ author: 'pixelpilot', color: '#bba5ff', text: 'Great finish', offsetMs: 0 }],
};

function profile(
  execution: 'asynchronous' | 'sequential' = 'asynchronous',
  deadline = 90000,
): InferenceProfile {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
    revision: 1,
    name: 'Recorded split',
    values: {
      topology: 'split',
      roles: {
        observer: { kind: 'remote', modelId: 'vision' },
        chat: { kind: 'remote', modelId: 'chat' },
      },
      stageDefaults: {},
      architecture: {
        execution,
        hybridMaxImages: 0,
        visionIntervalMs: 100,
        chatIntervalMs: 200,
        maximumWaitMs: 0,
        maximumAgeMs: 5000,
        strictWait: false,
        recordedDrainTimeoutMs: deadline,
      },
    },
  };
}

function adapter(output: () => Promise<unknown>, images = false): UnifiedInferenceAdapter {
  return {
    capabilities: { images },
    complete: vi.fn(async () => {
      const normalized = await output();
      return { raw: normalized, normalized };
    }),
  };
}

function sessionWith(
  clock: FakeClock,
  vision: UnifiedInferenceAdapter,
  chatter: UnifiedInferenceAdapter,
  execution: 'asynchronous' | 'sequential' = 'asynchronous',
  deadline = 90000,
) {
  const chat = new ChatService();
  const session = new SessionController(chat, undefined, clock, { cycleIntervalMs: 1500 });
  session.configureSplit(() => ({ vision, chat: chatter }), false);
  session.selectVideoSource('recorded:video');
  session.start(
    'Last scene',
    'remote',
    'chat',
    recorded,
    undefined,
    undefined,
    profile(execution, deadline),
  );
  return { session, chat };
}

function lastFrame(session: SessionController, clock: FakeClock) {
  session.recordVideoFrame({
    sourceId: 'recorded:video',
    observedAt: clock.wallNow(),
    dataUrl: 'data:image/jpeg;base64,AAAA',
    width: 1,
    height: 1,
  });
}

describe('split Recorded lifecycle', () => {
  it('does not admit stages while paused and keeps a completed cloud Vision result for resume', async () => {
    const clock = new FakeClock();
    let completeVision!: (output: typeof scene) => void;
    const pending = new Promise<typeof scene>((resolve) => {
      completeVision = resolve;
    });
    const vision = adapter(() => pending, true);
    const chatter = adapter(async () => chatResult);
    const { session, chat } = sessionWith(clock, vision, chatter);
    await flushMicrotasks();
    clock.advance(50);
    session.pauseRecorded();
    completeVision(scene);
    await flushMicrotasks();
    clock.advance(5000);
    await flushMicrotasks();
    expect(vision.complete).toHaveBeenCalledTimes(1);
    expect(chatter.complete).toHaveBeenCalledTimes(1);
    expect(session.snapshot().events).toHaveLength(0);
    const messagesBeforeResume = chat.snapshot().messages.length;
    session.resumeRecorded();
    await flushMicrotasks();
    expect(chat.snapshot().messages).toHaveLength(messagesBeforeResume);
    clock.advance(150);
    await flushMicrotasks();
    expect(chatter.complete).toHaveBeenCalledTimes(2);
    expect(session.snapshot().events).toEqual(
      expect.arrayContaining([expect.objectContaining({ summary: 'Winner revealed' })]),
    );
    session.stop();
  });

  for (const execution of ['asynchronous', 'sequential'] as const) {
    it(`analyzes the final captured frame at EOF in ${execution} mode and passes it to Chat`, async () => {
      const clock = new FakeClock();
      let count = 0;
      const vision = adapter(async () => (++count === 1 ? emptyScene : scene), true);
      const chatter = adapter(async () => chatResult);
      const { session } = sessionWith(clock, vision, chatter, execution);
      await flushMicrotasks();
      await flushMicrotasks();
      clock.advance(40);
      lastFrame(session, clock);
      session.finishRecorded();
      expect(session.snapshot().recordedPlayback).toBe('draining');
      clock.advance(60);
      await flushMicrotasks();
      await flushMicrotasks();
      expect(vision.complete).toHaveBeenCalledTimes(2);
      clock.advance(100);
      await flushMicrotasks();
      await flushMicrotasks();
      expect(chatter.complete).toHaveBeenCalledTimes(2);
      expect(session.snapshot().events).toEqual(
        expect.arrayContaining([expect.objectContaining({ summary: 'Winner revealed' })]),
      );
      expect(session.snapshot()).toMatchObject({
        phase: 'stopped',
        recordedPlayback: 'completed',
        recordedCompletionReason: 'drained',
      });
    });
  }

  it('freezes the EOF deadline over a long pause and records timed-out stages explicitly', async () => {
    const clock = new FakeClock();
    const vision = adapter(async () => new Promise<never>(() => {}), true);
    const chatter = adapter(async () => chatResult);
    const { session } = sessionWith(clock, vision, chatter, 'asynchronous', 500);
    await flushMicrotasks();
    session.finishRecorded();
    session.pauseRecorded();
    clock.advance(5000);
    expect(session.snapshot().recordedPlayback).toBe('paused');
    session.resumeRecorded();
    clock.advance(499);
    expect(session.snapshot().phase).toBe('running');
    clock.advance(1);
    expect(session.snapshot()).toMatchObject({
      phase: 'stopped',
      recordedPlayback: 'completed',
      recordedCompletionReason: 'deadline-exceeded',
    });
    expect(session.snapshot().warning).toMatch(/Vision/);
  });

  it('drains transcript evidence delivered during pause through final Chat without replaying Vision', async () => {
    const clock = new FakeClock();
    const vision = adapter(async () => emptyScene, true);
    const requests: unknown[] = [];
    const chatter: UnifiedInferenceAdapter = {
      capabilities: { images: false },
      complete: vi.fn(async (request) => {
        requests.push(request);
        return { raw: chatResult, normalized: chatResult };
      }),
    };
    const { session } = sessionWith(clock, vision, chatter);
    await flushMicrotasks();
    session.pauseRecorded();
    session.recordTranscript({
      source: 'mic',
      text: 'The winner is Alice',
      observedAt: clock.wallNow(),
    });
    session.finishRecorded();
    await flushMicrotasks();
    expect(chatter.complete).toHaveBeenCalledTimes(1);
    session.resumeRecorded();
    await flushMicrotasks();
    await flushMicrotasks();
    clock.advance(200);
    await flushMicrotasks();
    expect(chatter.complete).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(requests.at(-1))).toContain('The winner is Alice');
    expect(vision.complete).toHaveBeenCalledTimes(1);
    expect(session.snapshot().recordedCompletionReason).toBe('drained');
  });

  it('keeps a completed memory response pending during pause and waits for it at EOF', async () => {
    const clock = new FakeClock();
    const vision = adapter(async () => scene, true);
    const chatter = adapter(async () => ({
      ...chatResult,
      events: [{ kind: 'reaction', summary: 'Alice wins', ageMs: 0 }],
    }));
    let finishMemory!: (output: unknown) => void;
    const memoryPending = new Promise<unknown>((resolve) => {
      finishMemory = resolve;
    });
    const memory = adapter(() => memoryPending);
    const session = new SessionController(new ChatService(), undefined, clock, {
      cycleIntervalMs: 1500,
    });
    session.configureSplit(() => ({ vision, chat: chatter, memory }), false);
    const configured = profile();
    session.start('A finale', 'remote', 'chat', recorded, undefined, undefined, {
      ...configured,
      values: {
        ...configured.values,
        memory: { enabled: true, intervalMs: 0, maxCharacters: 2000, expireAfterMs: 0 },
      },
    });
    await flushMicrotasks();
    await flushMicrotasks();
    expect(memory.complete).toHaveBeenCalledTimes(1);
    session.pauseRecorded();
    finishMemory({ summary: 'Alice won the race' });
    await flushMicrotasks();
    expect(session.trace.list().attempts.find((entry) => entry.role === 'memory')?.stage).not.toBe(
      'accepted',
    );
    session.finishRecorded();
    session.resumeRecorded();
    await flushMicrotasks();
    await flushMicrotasks();
    expect(session.trace.list().attempts.find((entry) => entry.role === 'memory')?.stage).toBe(
      'accepted',
    );
    clock.advance(200);
    await flushMicrotasks();
    expect(session.snapshot().recordedCompletionReason).toBe('drained');
  });

  it('reports a memory-specific timeout rather than silently finalizing the Recorded Run', async () => {
    const clock = new FakeClock();
    const vision = adapter(async () => emptyScene, true);
    const chatter = adapter(async () => ({
      ...chatResult,
      events: [{ kind: 'reaction', summary: 'A new event', ageMs: 0 }],
    }));
    const memory = adapter(async () => new Promise<never>(() => {}));
    const session = new SessionController(new ChatService(), undefined, clock, {
      cycleIntervalMs: 1500,
    });
    session.configureSplit(() => ({ vision, chat: chatter, memory }), false);
    const configured = profile('asynchronous', 500);
    session.start('A finale', 'remote', 'chat', recorded, undefined, undefined, {
      ...configured,
      values: {
        ...configured.values,
        memory: { enabled: true, intervalMs: 0, maxCharacters: 2000, expireAfterMs: 0 },
      },
    });
    await flushMicrotasks();
    expect(memory.complete).toHaveBeenCalledTimes(1);
    session.finishRecorded();
    clock.advance(500);
    expect(session.snapshot()).toMatchObject({
      recordedCompletionReason: 'deadline-exceeded',
      phase: 'stopped',
    });
    expect(session.snapshot().warning).toMatch(/memory/);
  });

  it('prevents old-stage output from publishing after Stop and does not reuse it on restart', async () => {
    const clock = new FakeClock();
    let deliverOld!: (output: typeof scene) => void;
    const pending = new Promise<typeof scene>((resolve) => {
      deliverOld = resolve;
    });
    let calls = 0;
    const vision = adapter(() => (++calls === 1 ? pending : Promise.resolve(emptyScene)), true);
    const chatter = adapter(async () => chatResult);
    const { session } = sessionWith(clock, vision, chatter);
    await flushMicrotasks();
    lastFrame(session, clock);
    session.stop();
    session.start('New scene', 'remote', 'chat', recorded, undefined, undefined, profile());
    await flushMicrotasks();
    deliverOld(scene);
    await flushMicrotasks();
    expect(session.snapshot().events).toHaveLength(0);
    expect(JSON.stringify(vi.mocked(vision.complete).mock.calls[1]?.[0])).not.toContain(
      'data:image/jpeg',
    );
    expect(session.snapshot().cycle).toBe(1);
    session.finishRecorded();
    await flushMicrotasks();
    expect(session.snapshot().recordedCompletionReason).toBe('drained');
  });
});
