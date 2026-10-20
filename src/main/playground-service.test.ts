import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { PlaygroundService, type PlaygroundProvider } from './playground-service';
import { DEFAULT_FREEFORM_SAMPLING, validateFreeformRequest } from '../shared/playground-contract';
import { nativeFreeformRequest } from './native-inference';
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
  it('uses stored video defaults and replaces the warm worker when sampling overrides change', async () => {
    const token = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const defaults = {
      fps: 4,
      timestampIntervalMs: 5000,
      maxClipSizeMiB: 20,
      maxClipDurationSeconds: 15,
    };
    const workers: Array<{ stop: ReturnType<typeof vi.fn> }> = [];
    const factory = vi.fn((_model: string, _vision: boolean, _options?: typeof defaults) => {
      const worker = {
        completeFreeform: async () => ({
          startedAt: '',
          durationMs: 1,
          effectiveSeed: 1,
          content: 'ok',
          finishReason: 'stop',
          usage: null,
        }),
        stop: vi.fn(async () => {}),
      };
      workers.push(worker);
      return worker;
    });
    const service = new PlaygroundService(
      () => true,
      factory,
      undefined,
      undefined,
      undefined,
      undefined,
      () => defaults,
    );
    const native = { ...request, videoMode: 'native-video' as const, video: { token } };
    const first = await service.run(native);
    expect(first.request.videoOptions).toEqual(defaults);
    await service.run(native);
    expect(factory).toHaveBeenCalledTimes(1);
    const override = { ...defaults, fps: 8, timestampIntervalMs: 2000 };
    await service.run({ ...native, videoOptions: override });
    expect(factory).toHaveBeenCalledTimes(2);
    expect(factory).toHaveBeenLastCalledWith(request.modelId, true, override);
    expect(workers[0].stop).toHaveBeenCalledOnce();
    await service.run({ ...native, videoOptions: { ...override, maxClipSizeMiB: 100 } });
    expect(factory).toHaveBeenCalledTimes(3);
    expect(workers[1].stop).toHaveBeenCalledOnce();
    await service.stop();
  });

  it('reuses a warm worker across freeform requests and releases it on explicit stop', async () => {
    const stop = vi.fn(async () => {});
    const completeFreeform = vi.fn(async () => ({
      startedAt: '2026-10-18T12:00:00.000Z',
      durationMs: 5,
      effectiveSeed: 1234,
      content: 'Hello',
      finishReason: 'stop',
      usage: null,
    }));
    const factory = vi.fn(() => ({ completeFreeform, stop }));
    const service = new PlaygroundService(() => true, factory);
    await service.run(request);
    await service.run({ ...request, userPrompt: 'Again' });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(completeFreeform).toHaveBeenCalledTimes(2);
    expect(stop).not.toHaveBeenCalled();
    await service.stop();
    expect(stop).toHaveBeenCalledOnce();
  });
  it('restarts only when the model, vision capability, or worker settings change', async () => {
    let settings = 'cuda-4threads';
    const workers: Array<{ stop: ReturnType<typeof vi.fn> }> = [];
    const factory = vi.fn(() => {
      const worker = {
        completeFreeform: async () => ({
          startedAt: '',
          durationMs: 1,
          effectiveSeed: 1234,
          content: 'ok',
          finishReason: 'stop',
          usage: null,
        }),
        stop: vi.fn(async () => {}),
      };
      workers.push(worker);
      return worker;
    });
    const service = new PlaygroundService(
      () => true,
      factory,
      undefined,
      undefined,
      () => settings,
    );
    await service.run(request);
    await service.run({ ...request, modelId: 'different' });
    await service.run({ ...request, modelId: 'different' });
    expect(factory).toHaveBeenCalledTimes(2);
    expect(workers[0].stop).toHaveBeenCalledOnce();
    settings = 'cpu-2threads';
    await service.run({ ...request, modelId: 'different' });
    expect(factory).toHaveBeenCalledTimes(3);
    expect(workers[1].stop).toHaveBeenCalledOnce();
    await service.run({
      ...request,
      modelId: 'different',
      frames: [
        {
          sourceId: 'still',
          width: 4,
          height: 4,
          dataUrl:
            'data:image/jpeg;base64,' +
            readFileSync(
              new URL('../../tests/fixtures/playground-red.jpg', import.meta.url),
            ).toString('base64'),
        },
      ],
    });
    expect(factory).toHaveBeenCalledTimes(4);
    expect(workers[2].stop).toHaveBeenCalledOnce();
    await service.stop();
    expect(workers[3].stop).toHaveBeenCalledOnce();
  });

  it('unloads a warm idle worker after its timeout and reloads on the next request', async () => {
    vi.useFakeTimers();
    try {
      const stop = vi.fn(async () => {});
      const factory = vi.fn(() => ({
        completeFreeform: async () => ({
          startedAt: '',
          durationMs: 1,
          effectiveSeed: 1234,
          content: 'ok',
          finishReason: 'stop',
          usage: null,
        }),
        stop,
      }));
      const service = new PlaygroundService(
        () => true,
        factory,
        undefined,
        undefined,
        undefined,
        1000,
      );
      await service.run(request);
      await vi.advanceTimersByTimeAsync(999);
      expect(stop).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(stop).toHaveBeenCalledOnce();
      await service.run(request);
      expect(factory).toHaveBeenCalledTimes(2);
      await service.stop();
      expect(stop).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts a bounded optional response schema and forwards it to llama.cpp', () => {
    const input = {
      ...request,
      responseSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['answer'],
        properties: { answer: { type: 'string' } },
      },
    };
    const validated = validateFreeformRequest(input);
    expect(nativeFreeformRequest(validated)).toMatchObject({
      response_format: { type: 'json_object', schema: input.responseSchema },
      seed: 1234,
    });
    expect(() => validateFreeformRequest({ ...input, responseSchema: null })).toThrow(/schema/i);
    expect(() =>
      validateFreeformRequest({
        ...input,
        responseSchema: { text: 'x'.repeat(40_000) },
      }),
    ).toThrow(/32 KiB/);
  });

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
    expect(stop).not.toHaveBeenCalled();
    expect(service.snapshot()).toEqual({ busy: false });
    await service.stop();
    expect(stop).toHaveBeenCalledOnce();
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
    expect(provider.stop).toHaveBeenCalledOnce();
    await service.stop();
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
