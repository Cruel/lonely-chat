import type { ChatAppend, ChatMessage, ChatSnapshot } from '../shared/chat-contract';

const HISTORY_LIMIT = 200;

/** The app process alone decides when a message becomes visible. */
export class ChatService {
  private sequence = 0;
  private messages: ChatMessage[] = [];
  private subscribers = new Set<(event: ChatAppend) => void>();

  snapshot(): ChatSnapshot {
    return { type: 'snapshot', sequence: this.sequence, messages: [...this.messages] };
  }

  publish(message: Omit<ChatMessage, 'id' | 'presentedAt'>, time = Date.now()): ChatMessage {
    const sequence = ++this.sequence;
    const visible: ChatMessage = { ...message, id: `chat-${sequence}`, presentedAt: time };
    this.messages.push(visible);
    if (this.messages.length > HISTORY_LIMIT) this.messages.shift();
    const event: ChatAppend = { type: 'append', sequence, message: visible };
    for (const subscriber of this.subscribers) subscriber(event);
    return visible;
  }

  subscribe(listener: (event: ChatAppend) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }
}

const SAMPLES: Array<Omit<ChatMessage, 'id' | 'presentedAt'>> = [
  { author: 'pixelpilot', text: 'This is looking good already!', color: '#bba5ff' },
  { author: 'lunar_fox', text: 'Hello from Lonely Chat 👋', color: '#62d9b4' },
  { author: 'nightowl', text: 'The chat overlay is live.', color: '#ffbb78' },
];

/** Fixture publisher; future session controller will call publish() with scheduled chat. */
export function publishSample(service: ChatService): void {
  const next = service.snapshot().sequence;
  service.publish(SAMPLES[next % SAMPLES.length]);
}
