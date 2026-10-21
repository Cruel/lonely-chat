import { describe, expect, it, vi } from 'vitest';
import { stat } from 'node:fs/promises';
import { LocalGpuQueue, LocalModelPool } from './local-model-pool';
import type { NativeInference } from './native-inference';

describe('local GPU admission', () => {
  it('never overlaps workers and gives waiting Chat priority at a tie', async () => {
    const queue = new LocalGpuQueue();
    const order: string[] = [];
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const signal = new AbortController().signal;
    const first = queue.submit('observer', signal, Infinity, async () => {
      order.push('first');
      await blocked;
    });
    const vision = queue.submit('observer', signal, Infinity, async () => {
      order.push('vision');
    });
    const chat = queue.submit('chat', signal, Infinity, async () => {
      order.push('chat');
    });
    finish();
    await Promise.all([first, vision, chat]);
    expect(order).toEqual(['first', 'chat', 'vision']);
  });

  it('prevents Vision starvation under a sustained Chat backlog', async () => {
    const queue = new LocalGpuQueue(16, () => 0);
    const order: string[] = [];
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const signal = new AbortController().signal;
    const first = queue.submit('chat', signal, Infinity, async () => {
      order.push('chat0');
      await blocked;
    });
    const c1 = queue.submit('chat', signal, 100, async () => {
      order.push('chat1');
    });
    const c2 = queue.submit('chat', signal, 100, async () => {
      order.push('chat2');
    });
    const c3 = queue.submit('chat', signal, 100, async () => {
      order.push('chat3');
    });
    const vision = queue.submit('observer', signal, 200, async () => {
      order.push('vision');
    });
    finish();
    await Promise.all([first, c1, c2, c3, vision]);
    expect(order).toEqual(['chat0', 'chat1', 'vision', 'chat2', 'chat3']);
  });

  it('bounds pending work, expires deadlines, and recovers after cancellation', async () => {
    let time = 0;
    const queue = new LocalGpuQueue(1, () => time);
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const active = queue.submit('chat', new AbortController().signal, 100, () => blocked);
    const expired = queue.submit('observer', new AbortController().signal, 5, async () => 'old');
    await expect(
      queue.submit('chat', new AbortController().signal, 20, async () => 'overflow'),
    ).rejects.toThrow('full');
    time = 10;
    finish();
    await active;
    await expect(expired).rejects.toThrow('deadline');
    expect(await queue.submit('chat', new AbortController().signal, 20, async () => 'new')).toBe(
      'new',
    );
  });

  it('removes aborted queued requests without poisoning subsequent admission', async () => {
    const queue = new LocalGpuQueue();
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const active = queue.submit('observer', new AbortController().signal, Infinity, () => blocked);
    const controller = new AbortController();
    const aborted = queue.submit('chat', controller.signal, Infinity, async () => 'wrong');
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
    finish();
    await active;
    expect(
      await queue.submit('observer', new AbortController().signal, Infinity, async () => 1),
    ).toBe(1);
  });
});

describe('resident local models', () => {
  it('shares exact configurations but retains distinct workers until explicitly unloaded', async () => {
    const stops: Array<ReturnType<typeof vi.fn>> = [];
    const create = vi.fn(() => {
      const stop = vi.fn(async () => {});
      stops.push(stop);
      return { stop } as unknown as NativeInference;
    });
    const pool = new LocalModelPool({
      files: async () => ({ modelPath: process.execPath, projectorPath: null }),
      create,
      ramBudgetMiB: () => 1000000,
      vramBudgetMiB: () => 1000000,
      timeoutMs: () => 100,
      warmIdleMs: () => 60000,
    });
    await pool.reserve(['a', 'a']);
    expect(create).toHaveBeenCalledTimes(1);
    await pool.release();
    expect(stops[0]).not.toHaveBeenCalled();
    await pool.reserve(['a']);
    expect(create).toHaveBeenCalledTimes(1);
    await pool.reserve(['a', 'b']);
    expect(stops[0]).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(3);
    await pool.unload();
    expect(stops[1]).toHaveBeenCalledTimes(1);
    expect(stops[2]).toHaveBeenCalledTimes(1);
  });

  it('generates rosters through the pinned Chat worker rather than a fixture', async () => {
    const generateRoster = vi.fn(async () => ['local_viewer']);
    const stop = vi.fn(async () => {});
    const create = vi.fn(() => ({ generateRoster, stop }) as unknown as NativeInference);
    const pool = new LocalModelPool({
      files: async () => ({ modelPath: process.execPath, projectorPath: null }),
      create,
      ramBudgetMiB: () => 1000000,
      vramBudgetMiB: () => 0,
      timeoutMs: () => 10000,
    });
    await pool.reserve(['chat', 'chat']);
    const provider = pool.rosterProvider('chat');
    expect(await provider.generateRoster!(1, [], new AbortController().signal, 42)).toEqual([
      'local_viewer',
    ]);
    expect(generateRoster).toHaveBeenCalledWith(1, [], expect.any(AbortSignal), 42);
    expect(create).toHaveBeenCalledTimes(1);
    await pool.unload();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('rejects combined resident weight budgets before starting any worker', async () => {
    const oneSize = (await stat(process.execPath)).size / 1048576;
    const create = vi.fn(() => {
      throw new Error('Must not create worker');
    });
    const pool = new LocalModelPool({
      files: async () => ({ modelPath: process.execPath, projectorPath: null }),
      create,
      ramBudgetMiB: () => Math.ceil(oneSize * 1.5),
      vramBudgetMiB: () => 0,
      timeoutMs: () => 100,
    });
    await expect(pool.reserve(['model1', 'model2'])).rejects.toThrow(/Select a smaller model/);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects a nonexistent model without reserving workers', async () => {
    const create = vi.fn();
    const pool = new LocalModelPool({
      files: async () => ({ modelPath: 'nonexistent-model.gguf', projectorPath: null }),
      create: create as unknown as (id: string) => NativeInference,
      ramBudgetMiB: () => 10000,
      vramBudgetMiB: () => 0,
      timeoutMs: () => 100,
    });
    await expect(pool.reserve(['missing'])).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });
});
