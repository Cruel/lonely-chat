import { describe, expect, it } from 'vitest';
import { ChatService, publishSample } from './chat-service';

describe('application-owned chat', () => {
  it('publishes monotonic live events and a matching late snapshot', () => {
    const chat = new ChatService();
    const received: number[] = [];
    const unsubscribe = chat.subscribe((event) => received.push(event.sequence));
    publishSample(chat);
    publishSample(chat);
    unsubscribe();
    publishSample(chat);
    expect(received).toEqual([1, 2]);
    const snapshot = chat.snapshot();
    expect(snapshot.sequence).toBe(3);
    expect(snapshot.messages.map((message) => message.id)).toEqual(['chat-1', 'chat-2', 'chat-3']);
    expect(snapshot.messages[0].author).toBe('pixelpilot');
    expect(snapshot.messages[0].presentedAt).toEqual(expect.any(Number));
  });

  it('bounds only public presentation history without resetting sequence', () => {
    const chat = new ChatService();
    for (let index = 0; index < 220; index++) {
      chat.publish({ author: 'test', text: String(index), color: '#ffffff' }, index);
    }
    const snapshot = chat.snapshot();
    expect(snapshot.messages).toHaveLength(200);
    expect(snapshot.sequence).toBe(220);
    expect(snapshot.messages[0].id).toBe('chat-21');
    expect(snapshot.messages[199].id).toBe('chat-220');
    const original = chat.snapshot();
    expect(chat.snapshot()).not.toBe(original);
  });
});
