import { describe, expect, it, vi } from 'vitest';
import { NarrativeMemory } from './narrative-memory';
import type { UnifiedInferenceAdapter } from './inference-coordinator';

const policy = { enabled: true, intervalMs: 1000, maxCharacters: 512, expireAfterMs: 10000 };
const signal = new AbortController().signal;
const adapter = (complete: UnifiedInferenceAdapter['complete']): UnifiedInferenceAdapter => ({
  capabilities: { images: false },
  complete,
});

describe('Run-scoped narrative memory', () => {
  it('retains an earlier event after it disappears from the incoming evidence window', async () => {
    const memory = new NarrativeMemory();
    const complete = vi.fn(async (request: Parameters<UnifiedInferenceAdapter['complete']>[0]) => {
      const input = JSON.parse(request.content[0].type === 'text' ? request.content[0].text : '{}');
      return {
        raw: null,
        normalized: {
          summary: [
            input.previousSummary,
            ...input.newEvidence.map((line: string) => JSON.parse(line).description),
          ]
            .filter(Boolean)
            .join('; '),
        },
      };
    });
    memory.observe('Red car wins the race', 1000);
    expect(await memory.update(2000, policy, adapter(complete), signal)).toBe(true);
    memory.observe('Camera shows awards ceremony', 90000);
    expect(
      await memory.update(90000, { ...policy, expireAfterMs: 0 }, adapter(complete), signal),
    ).toBe(true);
    expect(memory.snapshot(91000, { ...policy, expireAfterMs: 0 })).toEqual({
      version: 2,
      updatedAt: 90000,
      text: 'Red car wins the race; Camera shows awards ceremony',
    });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('enforces cadence, preserves the last valid revision on errors and unsupported output', async () => {
    const memory = new NarrativeMemory();
    memory.observe('An explosion', 1);
    expect(
      await memory.update(
        1000,
        policy,
        adapter(async () => ({ raw: null, normalized: { summary: 'Explosion happened' } })),
        signal,
      ),
    ).toBe(true);
    memory.observe('A rescue', 2000);
    const failing = vi.fn(async () => {
      throw new Error('provider busy');
    });
    expect(await memory.update(1500, policy, adapter(failing), signal)).toBe(false);
    expect(failing).not.toHaveBeenCalled();
    expect(await memory.update(2000, policy, adapter(failing), signal)).toBe(false);
    expect(
      await memory.update(
        3000,
        policy,
        adapter(async () => ({ raw: null, normalized: { summary: 'x'.repeat(513) } })),
        signal,
      ),
    ).toBe(false);
    expect(memory.snapshot(3500, policy)?.text).toBe('Explosion happened');
    expect(
      await memory.update(
        4000,
        policy,
        adapter(async () => ({ raw: null, normalized: { summary: 'Explosion happened; rescue' } })),
        signal,
      ),
    ).toBe(true);
    expect(memory.snapshot(4000, policy)?.version).toBe(2);
    expect(memory.snapshot(15000, policy)).toBeNull();
  });

  it('suspends memory publication during recorded playback pause without losing evidence', async () => {
    const memory = new NarrativeMemory();
    let resolve!: (result: { raw: null; normalized: { summary: string } }) => void;
    memory.observe('Important event', 100);
    const pending = memory.update(
      1000,
      policy,
      adapter(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      ),
      signal,
    );
    memory.suspend();
    resolve({ raw: null, normalized: { summary: 'Important event' } });
    expect(await pending).toBe(false);
    expect(
      await memory.update(
        3000,
        policy,
        adapter(async () => ({ raw: null, normalized: { summary: 'Important event' } })),
        signal,
      ),
    ).toBe(false);
    memory.resume();
    expect(
      await memory.update(
        3000,
        policy,
        adapter(async () => ({ raw: null, normalized: { summary: 'Important event' } })),
        signal,
      ),
    ).toBe(true);
    expect(memory.snapshot(3000, policy)?.text).toBe('Important event');
  });

  it('discards old completions after reset and does not overlap pending updates', async () => {
    const memory = new NarrativeMemory();
    let resolve!: (value: { raw: null; normalized: { summary: string } }) => void;
    const complete = vi.fn(
      () =>
        new Promise<{ raw: null; normalized: { summary: string } }>((done) => {
          resolve = done;
        }),
    );
    memory.observe('Old run', 1);
    const old = memory.update(1000, policy, adapter(complete), signal);
    expect(await memory.update(3000, policy, adapter(complete), signal)).toBe(false);
    memory.reset();
    resolve({ raw: null, normalized: { summary: 'Old run' } });
    expect(await old).toBe(false);
    expect(memory.snapshot(3000, policy)).toBeNull();
    memory.observe('New run', 3000);
    expect(
      await memory.update(
        3000,
        policy,
        adapter(async () => ({ raw: null, normalized: { summary: 'New run' } })),
        signal,
      ),
    ).toBe(true);
    expect(memory.snapshot(3000, policy)?.text).toBe('New run');
  });
});
