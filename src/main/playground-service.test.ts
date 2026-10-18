import { describe, expect, it, vi } from 'vitest';
import { PlaygroundService, type PlaygroundProvider } from './playground-service';
import { DEFAULT_FREEFORM_SAMPLING } from '../shared/playground-contract';
import { ChatService } from './chat-service';
import { SessionController } from './session-controller';
import { AudienceService } from './audience-service';

const request = {
  modelId: 'installed-vision',
  systemPrompt: 'Explain briefly.',
  userPrompt: 'Hi',
  ...DEFAULT_FREEFORM_SAMPLING,
  seed: 1234,
};

describe('Playground worker ownership and isolation', () => {
  it('serializes resources with Simulation in both directions; edits and snapshots stay available', async () => {
    let simulationRunning = false;
    let unlock!: () => void;
    const gate = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const completeFreeform = vi.fn(async () => {
      await gate;
      return {
        startedAt: '2026-10-18T12:00:00.000Z',
        durationMs: 44,
        effectiveSeed: 1234,
        content: 'Hello',
        finishReason: 'stop',
        usage: null,
      };
    });
    const stop = vi.fn(async () => {});
    const factory = vi.fn(() => ({ completeFreeform, stop }));
    const service = new PlaygroundService(() => !simulationRunning, factory);
    simulationRunning = true;
    expect(() => service.run(request)).toThrow(/Stop Simulation/);
    expect(factory).not.toHaveBeenCalled();
    simulationRunning = false;
    const pending = service.run(request);
    expect(service.snapshot().busy).toBe(true);
    expect(() => service.run(request)).toThrow(/Another Playground/);
    // The desktop session:start handler must check this same synchronous lock.
    expect(service.busy).toBe(true);
    unlock();
    expect((await pending).content).toBe('Hello');
    expect(factory).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(service.snapshot()).toEqual({ busy: false });
  });

  it('does not touch Session, Chat, or Audience and releases lock after failure', async () => {
    const chat = new ChatService();
    const audience = new AudienceService(null, 2);
    await audience.open();
    const session = new SessionController(
      chat,
      undefined,
      undefined,
      undefined,
      undefined,
      audience,
    );
    const snapshots = () => ({
      session: session.snapshot(),
      chat: chat.snapshot(),
      roster: audience.snapshot(),
    });
    const original = snapshots();
    const provider: PlaygroundProvider = {
      completeFreeform: vi.fn().mockRejectedValueOnce(new Error('HTTP 503')).mockResolvedValueOnce({
        startedAt: '2026-10-18T12:00:00.000Z',
        durationMs: 100,
        effectiveSeed: 1234,
        content: 'Recovery worked',
        finishReason: 'stop',
        usage: null,
      }),
      stop: vi.fn(async () => {}),
    };
    const service = new PlaygroundService(
      () => true,
      () => provider,
    );
    await expect(service.run(request)).rejects.toThrow(/HTTP 503/);
    expect(service.busy).toBe(false);
    expect((await service.run(request)).content).toBe('Recovery worked');
    expect(snapshots()).toEqual(original);
    expect(provider.stop).toHaveBeenCalledTimes(2);
  });

  it('does not acquire resources for malformed IPC payloads and cancels in-flight work on shutdown', async () => {
    const factory = vi.fn(() => ({
      completeFreeform: vi.fn(
        (_request, signal: AbortSignal) =>
          new Promise<never>((_res, reject) => {
            signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
          }),
      ),
      stop: vi.fn(async () => {}),
    }));
    const service = new PlaygroundService(() => true, factory);
    expect(() => service.run({ ...request, seed: -1 })).toThrow(/seed/);
    expect(() => service.run({ ...request, extra: 'secret' })).toThrow(/fields/);
    expect(factory).not.toHaveBeenCalled();
    const task = service.run(request);
    const cancelled = expect(task).rejects.toThrow(/cancelled/);
    await service.stop();
    await cancelled;
    expect(service.busy).toBe(false);
  });

  it('reserves lock before pending shutdown settlement and rechecks Simulation gate', async () => {
    let active = false;
    let release!: () => void;
    const shutdown = new Promise<void>((resolve) => {
      release = resolve;
    });
    const factory = vi.fn(() => ({
      completeFreeform: vi.fn(),
      stop: vi.fn(async () => {}),
    }));
    const service = new PlaygroundService(
      () => !active,
      factory,
      () => shutdown,
    );
    const task = service.run(request);
    expect(service.busy).toBe(true);
    active = true;
    release();
    await expect(task).rejects.toThrow(/Simulation became active/);
    expect(factory).not.toHaveBeenCalled();
    expect(service.busy).toBe(false);
  });
});
