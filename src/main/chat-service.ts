import type { ChatAppend, ChatMessage, ChatSnapshot } from '../shared/chat-contract';

const HISTORY_LIMIT = 200;

/** The app process alone decides when a message becomes visible. */
export class ChatService {
  private sequence = 0;
  private messages: ChatMessage[] = [];
  private subscribers = new Set<(event: ChatAppend) => void>();
  private publicSequence = 0;
  private publicMessages: ChatMessage[] = [];
  private publicSubscribers = new Set<(event: ChatAppend) => void>();

  snapshot(): ChatSnapshot {
    return { type: 'snapshot', sequence: this.sequence, messages: [...this.messages] };
  }

  /** The overlay uses a separate, gap-free sequence. Private recorded messages never enter it. */
  publicSnapshot(): ChatSnapshot {
    return { type: 'snapshot', sequence: this.publicSequence, messages: [...this.publicMessages] };
  }

  publish(
    message: Omit<ChatMessage, 'id' | 'presentedAt'>,
    time = Date.now(),
    externally = true,
  ): ChatMessage {
    const sequence = ++this.sequence;
    const visible: ChatMessage = { ...message, id: `chat-${sequence}`, presentedAt: time };
    this.messages.push(visible);
    if (this.messages.length > HISTORY_LIMIT) this.messages.shift();
    const event: ChatAppend = { type: 'append', sequence, message: visible };
    for (const subscriber of this.subscribers) subscriber(event);
    if (externally) {
      const publicEvent: ChatAppend = {
        type: 'append',
        sequence: ++this.publicSequence,
        message: visible,
      };
      this.publicMessages.push(visible);
      if (this.publicMessages.length > HISTORY_LIMIT) this.publicMessages.shift();
      for (const subscriber of this.publicSubscribers) subscriber(publicEvent);
    }
    return visible;
  }

  subscribe(listener: (event: ChatAppend) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  subscribePublic(listener: (event: ChatAppend) => void): () => void {
    this.publicSubscribers.add(listener);
    return () => this.publicSubscribers.delete(listener);
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
