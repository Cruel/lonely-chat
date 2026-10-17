import { describe, expect, it, vi } from 'vitest';
import { ManagedShutdown } from './shutdown-managed-services';
import { ChatService, publishSample } from './chat-service';

describe('explicit Quit shutdown', () => {
  it('stops scheduled publication first, closes floating presentation, and waits for all services exactly once', async () => {
    const calls: string[] = [];
    const chat = new ChatService();
    let running = true;
    const stop = vi.fn(() => {
      calls.push('stop playback');
      running = false;
    });
    const cancel = vi.fn(() => {
      calls.push('abort');
    });
    const close = vi.fn(() => {
      calls.push('floating close');
    });
    let complete!: () => void;
    const pending = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const shutdown = new ManagedShutdown(
      stop,
      cancel,
      close,
      [
        async () => {
          calls.push('native exit');
          await pending;
        },
        async () => {
          calls.push('overlay stop');
        },
      ],
      vi.fn(),
    );
    publishSample(chat);
    const first = shutdown.stop();
    const second = shutdown.stop();
    expect(first).toBe(second);
    expect(calls.slice(0, 3)).toEqual(['stop playback', 'abort', 'floating close']);
    if (running) publishSample(chat);
    expect(chat.snapshot().sequence).toBe(1);
    complete();
    await first;
    expect(calls).toContain('native exit');
    expect(calls).toContain('overlay stop');
    expect(stop).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('does not skip remaining services if one teardown rejects', async () => {
    const error = vi.fn();
    const finish = vi.fn(async () => {});
    const shutdown = new ManagedShutdown(
      () => {
        throw new Error('stop failed');
      },
      () => {},
      () => {},
      [
        async () => {
          throw new Error('native failed');
        },
        finish,
      ],
      error,
    );
    await shutdown.stop();
    expect(error).toHaveBeenCalledTimes(2);
    expect(finish).toHaveBeenCalledOnce();
  });
});
