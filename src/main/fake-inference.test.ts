import { describe, expect, it } from 'vitest';
import { FakeInference, parseChatBatch } from './fake-inference';

describe('deterministic inference boundary', () => {
  it('produces stable validated replies from a manual context and cycle', async () => {
    const provider = new FakeInference();
    const signal = new AbortController().signal;
    const first = await provider.generate({ context: 'new game', cycle: 1 }, signal);
    const same = await provider.generate({ context: 'new game', cycle: 1 }, signal);
    expect(first).toEqual(same);
    const messages = parseChatBatch(first);
    expect(messages.map((message) => message.offsetMs)).toEqual([0, 900, 2100]);
    expect(messages[0].text).toContain('new game');
  });
  it('rejects malformed data atomically before it becomes chat', () => {
    for (const invalid of [
      null,
      { messages: 'text' },
      { messages: [{ author: 'x', text: 'ok', color: '#ffffff', offsetMs: Infinity }] },
      { messages: [{ author: 'x', text: 'ok', color: '#ffffff', offsetMs: NaN }] },
      { messages: [{ author: 'x', text: 'ok', color: '#ffffff', offsetMs: 60001 }] },
      { messages: [{ author: 'x', text: 'ok', color: '#ffffff', offsetMs: -1 }] },
      { messages: [{ author: 'x', text: '', color: '#ffffff', offsetMs: 0 }] },
      { messages: [{ author: 'x', text: 'ok', color: 'red', offsetMs: 0 }] },
      { messages: Array(65).fill({ author: 'x', text: 'ok', color: '#ffffff', offsetMs: 0 }) },
    ]) {
      expect(() => parseChatBatch(invalid)).toThrow();
    }
  });
});
