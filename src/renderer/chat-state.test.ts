import { describe, expect, it } from 'vitest';
import { applyChatEvent, INITIAL_CHAT } from './chat-state';

const message = { id: 'chat-1', author: 'viewer', text: 'hi', color: '#fff', presentedAt: 123 };

describe('presentation sequence reducer', () => {
  it('applies live updates exactly once and refuses stale snapshots', () => {
    const first = applyChatEvent(INITIAL_CHAT, { type: 'append', sequence: 1, message });
    expect(first.messages).toEqual([message]);
    expect(applyChatEvent(first, { type: 'append', sequence: 1, message })).toBe(first);
    expect(applyChatEvent(first, INITIAL_CHAT)).toBe(first);
    expect(applyChatEvent(first, { type: 'snapshot', sequence: 1, messages: [message] })).toEqual(
      first,
    );
  });

  it('reports gaps instead of silently presenting out-of-order data', () => {
    expect(() => applyChatEvent(INITIAL_CHAT, { type: 'append', sequence: 2, message })).toThrow(
      /sequence gap/,
    );
  });
});
