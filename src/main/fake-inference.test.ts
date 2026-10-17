import { describe, expect, it } from 'vitest';
import { FakeInference, parseChatBatch, parseInferenceResult } from './fake-inference';

describe('deterministic inference boundary', () => {
  it('produces stable validated replies from a manual context and cycle', async () => {
    const provider = new FakeInference();
    const signal = new AbortController().signal;
    const first = await provider.generate({ context: 'new game', cycle: 1 }, signal);
    const same = await provider.generate({ context: 'new game', cycle: 1 }, signal);
    expect(first).toEqual(same);
    const result = parseInferenceResult(first, 1000);
    expect(result.events).toEqual([{ kind: 'context', summary: 'new game', observedAt: 1000 }]);
    expect(result.messages.map((message) => message.offsetMs)).toEqual([0, 900, 2100]);
    expect(result.messages[0].text).toContain('new game');
  });
  it('identifies the invalid event field and observation-window boundary', () => {
    const messages = [{ author: 'pixelpilot', text: 'hello', color: '#bba5ff', offsetMs: 0 }];
    expect(() =>
      parseInferenceResult(
        { events: [{ kind: 'reaction', summary: 'jump', ageMs: 5000 }], messages },
        10000,
        9000,
      ),
    ).toThrow(/events\[0\].*ageMs.*5000.*available evidence window.*1000/);
    expect(() =>
      parseInferenceResult(
        { events: [{ kind: 'context', summary: 'ok', ageMs: -1 }], messages },
        10000,
      ),
    ).toThrow(/events\[0\].*ageMs.*-1.*0.*60000/);
    expect(() =>
      parseInferenceResult(
        { events: [{ kind: 'context', summary: 'ok', timestamp: 0 }], messages },
        10000,
      ),
    ).toThrow(/events\[0\].*missing.*ageMs.*unexpected.*timestamp/);
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
