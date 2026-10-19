import { describe, expect, it } from 'vitest';
import { ChatService } from './chat-service';
import { SessionController } from './session-controller';
import { AudienceService } from './audience-service';
import { deriveInferenceSeed } from './inference-seeds';
import {
  allowsRecordedSessionMedia,
  isRecordedVideoFailure,
  DEFAULT_PREFERENCES,
} from '../shared/session-contract';
import { FakeClock, flushMicrotasks as flush } from './test-support/fake-clock';
import type { InferenceProvider } from './fake-inference';

describe('session lifecycle with deterministic clock', () => {
  it('captures a preset revision and runtime settings until Stop, including subsequent cycles', async () => {
    const clock = new FakeClock();
    const session = new SessionController(new ChatService(), undefined, clock, {
      cycleIntervalMs: 1500,
    });
    const started = session.start(
      'saved context',
      'fake',
      null,
      { inputMode: 'recorded', publishToOverlay: false },
      { id: 'preset-1', name: 'Saved', revision: 3, chatActivity: 'busy' },
    );
    expect(started.promptPreset).toEqual({ id: 'preset-1', name: 'Saved', revision: 3 });
    expect(session.getRunPreferences().chatActivity).toBe('busy');
    session.setPreferences({
      ...session.getPreferences(),
      cycleIntervalMs: 5000,
      chatActivity: 'quiet',
    });
    expect(session.getPreferences().cycleIntervalMs).toBe(5000);
    expect(session.getRunPreferences().cycleIntervalMs).toBe(1500);
    expect(session.getRunPreferences().chatActivity).toBe('busy');
    await flush();
    clock.advance(1500);
    await flush();
    expect(session.snapshot().cycle).toBe(2);
    expect(session.snapshot().promptPreset?.revision).toBe(3);
    session.stop();
    expect(session.start('new context').promptPreset).toBeNull();
    expect(session.getRunPreferences().cycleIntervalMs).toBe(5000);
    session.stop();
  });
  it('freezes a saved Scenario settings snapshot independently of current global settings', () => {
    const clock = new FakeClock();
    const session = new SessionController(new ChatService(), undefined, clock, {
      cycleIntervalMs: 1500,
      chatActivity: 'quiet',
    });
    const frozen = { ...DEFAULT_PREFERENCES, cycleIntervalMs: 5000, chatActivity: 'busy' as const };
    const a = session.start(
      'context',
      'fake',
      null,
      { inputMode: 'recorded', publishToOverlay: false, seed: 9 },
      undefined,
      frozen,
    );
    expect(a.runId).toBe(1);
    expect(a.playbackWindowMs).toBe(5000);
    expect(session.getRunPreferences()).toEqual(frozen);
    session.setPreferences({ ...DEFAULT_PREFERENCES, cycleIntervalMs: 3000 });
    expect(session.getRunPreferences()).toEqual(frozen);
    session.stop();
    const b = session.start('context', 'fake', null, {
      inputMode: 'recorded',
      publishToOverlay: true,
      seed: 9,
    });
    expect(b.runId).toBe(2);
    expect(b.playbackWindowMs).toBe(3000);
    session.stop();
  });

  it('preserves recorded history and capture cadence while inference is retriable', async () => {
    const clock = new FakeClock();
    const counts: number[] = [];
    const native: InferenceProvider = {
      generate: async (input) => {
        counts.push(input.recentTranscripts?.length ?? 0);
        if (counts.length <= 3) throw new Error('Retryable inference error');
        return { messages: [] };
      },
    };
    const session = new SessionController(new ChatService(), undefined, clock, undefined, native);
    session.start('context', 'native', 'model', { inputMode: 'recorded', publishToOverlay: false });
    for (let i = 0; i < 12; i++)
      session.recordTranscript({
        sourceId: 'mic',
        source: 'Mic',
        text: `word-${i}`,
        observedAt: clock.wallNow(),
      });
    await flush();
    clock.advance(500);
    await flush();
    clock.advance(1000);
    await flush();
    expect(session.snapshot().phase).toBe('error');
    session.setPreferences({
      ...session.getPreferences(),
      historyMaxCount: 10,
      videoCaptureIntervalMs: 1000,
    });
    expect(session.getRunPreferences().historyMaxCount).toBe(32);
    expect(session.snapshot().effectiveVideoCaptureIntervalMs).toBe(500);
    expect(() => session.setPreferences({ ...session.getPreferences(), audienceCount: 5 })).toThrow(
      /Stop the simulation/,
    );
    session.retry();
    await flush();
    expect(counts[3]).toBe(12);
    session.stop();
  });
  it('classifies fatal recorded decoder failures independently of user-facing text', async () => {
    const session = new SessionController(new ChatService());
    session.start('recording', 'fake', null, { inputMode: 'recorded', publishToOverlay: false });
    const failed = session.failRecordedVideo('unsupported codec');
    expect(failed.failureKind).toBe('recorded-video');
    expect(isRecordedVideoFailure({ ...failed, error: 'changed UI wording' })).toBe(true);
    expect(allowsRecordedSessionMedia({ ...failed, error: 'changed UI wording' })).toBe(false);
    expect(() => session.retry()).toThrow(/recorded decoder failed/);
    const next = session.start('next', 'fake');
    expect(next.failureKind).toBeNull();
    session.stop();
  });

  it('uses a distinct roster sampling seed for each outer startup retry', async () => {
    const clock = new FakeClock();
    const audience = new AudienceService(null, 2);
    await audience.open();
    const rosterSeeds: number[] = [];
    const native: InferenceProvider = {
      generate: async () => ({ messages: [] }),
      generateRoster: async (_count, _seen, _signal, seed) => {
        rosterSeeds.push(seed!);
        throw new Error('Invalid deterministic roster output');
      },
    };
    const session = new SessionController(
      new ChatService(),
      undefined,
      clock,
      undefined,
      native,
      audience,
    );
    session.start('stream', 'native', 'test', {
      inputMode: 'live',
      publishToOverlay: true,
      seed: 42,
    });
    await flush();
    clock.advance(500);
    await flush();
    clock.advance(1000);
    await flush();
    expect(session.snapshot().phase).toBe('error');
    expect(rosterSeeds).toHaveLength(3);
    expect(new Set(rosterSeeds).size).toBe(3);
    expect(rosterSeeds).toEqual(
      [1, 2, 3].map((attempt) =>
        deriveInferenceSeed(deriveInferenceSeed(42, 'roster', 1, attempt), 'roster', 0, 1),
      ),
    );
    expect(audience.snapshot().members).toEqual([]);
    const firstRetrySeeds = [...rosterSeeds];
    expect(session.retry().cycle).toBe(2);
    await flush();
    clock.advance(500);
    await flush();
    clock.advance(1000);
    await flush();
    expect(session.snapshot().phase).toBe('error');
    expect(rosterSeeds).toHaveLength(6);
    expect(new Set(rosterSeeds).size).toBe(6);
    expect(rosterSeeds.slice(3)).not.toEqual(firstRetrySeeds);
    session.stop();
  });
  it('schedules offset messages once, merges overlapping batches in deadline order, and retains chat after stop', async () => {
    const clock = new FakeClock();
    const chat = new ChatService();
    const controller = new SessionController(chat, undefined, clock, { cycleIntervalMs: 1500 });
    const delivered: string[] = [];
    chat.subscribe((event) => delivered.push(`${clock.now()}:${event.message.id}`));
    expect(controller.start('running through a cave').phase).toBe('running');
    expect(controller.snapshot().cycle).toBe(1);
    await flush();
    expect(chat.snapshot().messages.map((m) => m.id)).toEqual(['chat-1']);
    clock.advance(900);
    expect(chat.snapshot().messages.map((m) => m.id)).toEqual(['chat-1', 'chat-2']);
    clock.advance(600); // second cycle begins while first cycle's final message is queued
    await flush();
    expect(chat.snapshot().messages.map((m) => m.id)).toEqual(['chat-1', 'chat-2', 'chat-3']);
    expect(controller.snapshot().cycle).toBe(2);
    clock.advance(600); // final message from first cycle
    expect(chat.snapshot().messages.map((m) => m.id)).toEqual([
      'chat-1',
      'chat-2',
      'chat-3',
      'chat-4',
    ]);
    clock.advance(300); // second message from second cycle
    expect(chat.snapshot().messages.map((m) => m.id)).toEqual([
      'chat-1',
      'chat-2',
      'chat-3',
      'chat-4',
      'chat-5',
    ]);
    expect(delivered).toEqual([
      '10000:chat-1',
      '10900:chat-2',
      '11500:chat-3',
      '12100:chat-4',
      '12400:chat-5',
    ]);
    const status = controller.stop();
    expect(status.phase).toBe('stopped');
    expect(status.pendingMessages).toBe(0);
    clock.advance(90000);
    await flush();
    expect(chat.snapshot().sequence).toBe(5);
    expect(controller.snapshot().phase).toBe('stopped');
    expect(chat.snapshot().messages[0].text).toContain('running through a cave');
    expect(chat.snapshot().messages[0].presentedAt).toBe(1700000010000);
    controller.start('now playing chess');
    await flush();
    expect(chat.snapshot().sequence).toBe(6);
    expect(chat.snapshot().messages.at(-1)?.text).toContain('now playing chess');
    controller.stop();
  });

  it('invalid input does not start; malformed output reports error without publishing anything', async () => {
    const clock = new FakeClock();
    const chat = new ChatService();
    const provider: InferenceProvider = {
      generate: async () => ({
        messages: [{ author: 'a', text: 'bad', color: '#aaaaaa', offsetMs: -1 }],
      }),
    };
    const controller = new SessionController(chat, provider, clock);
    expect(() => controller.start('   ')).toThrow(/Enter some context/);
    expect(controller.snapshot().phase).toBe('stopped');
    expect(() => controller.start('x'.repeat(2001))).toThrow(/2000/);
    const snapshots: string[] = [];
    controller.subscribe((status) => snapshots.push(status.phase));
    controller.start('playing a game');
    await flush();
    expect(controller.snapshot().warning).toMatch(/Retrying/);
    clock.advance(500);
    await flush();
    clock.advance(1000);
    await flush();
    expect(controller.snapshot()).toMatchObject({ phase: 'error', pendingMessages: 0 });
    expect(controller.snapshot().error).toMatch(/invalid chat message/);
    clock.advance(9000);
    await flush();
    expect(chat.snapshot().messages).toEqual([]);
    expect(snapshots).toContain('running');
    expect(snapshots).toContain('error');
    controller.stop();
    expect(controller.snapshot().error).toBeNull();
  });

  it('aborts an unresolved inference on stop and discards stale completion across restart', async () => {
    const clock = new FakeClock();
    const chat = new ChatService();
    const resolutions: Array<(reply: unknown) => void> = [];
    const signals: AbortSignal[] = [];
    const provider: InferenceProvider = {
      generate: (_input, signal) => {
        signals.push(signal);
        return new Promise((resolve) => resolutions.push(resolve));
      },
    };
    const controller = new SessionController(chat, provider, clock);
    controller.start('old context');
    await flush();
    controller.stop();
    expect(signals[0].aborted).toBe(true);
    controller.start('new context');
    await flush();
    resolutions[0]({ messages: [{ author: 'x', text: 'stale', color: '#ffffff', offsetMs: 0 }] });
    await flush();
    expect(chat.snapshot().sequence).toBe(0);
    resolutions[1]({ messages: [{ author: 'x', text: 'fresh', color: '#ffffff', offsetMs: 0 }] });
    await flush();
    expect(chat.snapshot().messages.map((item) => item.text)).toEqual(['fresh']);
    controller.stop();
  });

  it('does not launch inference if stopped before the queued request begins', async () => {
    const clock = new FakeClock();
    const chat = new ChatService();
    let calls = 0;
    const provider: InferenceProvider = {
      generate: async () => {
        calls++;
        return { messages: [] };
      },
    };
    const session = new SessionController(chat, provider, clock);
    session.start('quick test');
    session.stop();
    await flush();
    clock.advance(60000);
    await flush();
    expect(calls).toBe(0);
    expect(chat.snapshot().sequence).toBe(0);
  });

  it('never runs inference cycles concurrently and preserves playback if the main window is absent', async () => {
    const clock = new FakeClock();
    const chat = new ChatService();
    let resolve: ((value: unknown) => void) | null = null;
    const provider: InferenceProvider = {
      generate: () =>
        new Promise((done) => {
          resolve = done;
        }),
    };
    const controller = new SessionController(chat, provider, clock, { cycleIntervalMs: 1500 });
    controller.start('context without a renderer');
    await flush();
    clock.advance(9000);
    expect(controller.snapshot().cycle).toBe(1);
    const complete: (value: unknown) => void = resolve!;
    complete({ messages: [{ author: 'x', text: 'late', color: '#ffffff', offsetMs: 400 }] });
    await flush();
    clock.advance(400);
    expect(chat.snapshot().messages.map((m) => m.text)).toEqual(['late']);
    controller.stop();
  });
});
