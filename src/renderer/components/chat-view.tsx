import { useEffect, useRef } from 'react';
import type { ChatMessage } from '../../shared/chat-contract';
import { cn } from '@/lib/utils';

export function ChatView({
  messages,
  compact = false,
}: {
  messages: readonly ChatMessage[];
  compact?: boolean;
}) {
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [messages.length]);

  return (
    <div
      className={cn(
        'chat-scroll min-h-0 overflow-y-auto',
        compact ? 'h-full px-3 py-3' : 'h-full p-5',
      )}
      role="log"
      aria-live="polite"
      aria-label="Simulated viewer chat"
    >
      {messages.length === 0 && <p className="text-sm text-zinc-400">No chat messages yet.</p>}
      <div className="flex flex-col gap-3">
        {messages.map((message) => (
          <div key={message.id} className="chat-enter text-[15px] leading-relaxed break-words">
            <span className="font-bold" style={{ color: message.color }}>
              {message.author}
            </span>
            <span className="text-zinc-400">: </span>
            <span className="text-zinc-100">{message.text}</span>
          </div>
        ))}
      </div>
      <div ref={bottom} aria-hidden="true" />
    </div>
  );
}
