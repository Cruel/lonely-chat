import type { ChatEvent, ChatSnapshot } from '../shared/chat-contract';

export const INITIAL_CHAT: ChatSnapshot = { type: 'snapshot', sequence: 0, messages: [] };

/** Snapshots are authoritative, but must never roll state back behind a live update. */
export function applyChatEvent(current: ChatSnapshot, event: ChatEvent): ChatSnapshot {
  if (event.sequence < current.sequence) return current;
  if (event.type === 'snapshot') return { ...event, messages: [...event.messages] };
  if (event.sequence <= current.sequence) return current;
  if (event.sequence !== current.sequence + 1) {
    // A missing event requires a new snapshot; caller reconnects on any gap.
    throw new Error(`Chat sequence gap: expected ${current.sequence + 1}, got ${event.sequence}`);
  }
  return {
    type: 'snapshot',
    sequence: event.sequence,
    messages: [...current.messages, event.message].slice(-200),
  };
}
