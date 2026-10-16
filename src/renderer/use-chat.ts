import { useEffect, useRef, useState } from 'react';
import type { ChatEvent, ChatSnapshot } from '../shared/chat-contract';
import { applyChatEvent, INITIAL_CHAT } from './chat-state';

export function useChat(): { snapshot: ChatSnapshot; connected: boolean } {
  const [snapshot, setSnapshot] = useState<ChatSnapshot>(INITIAL_CHAT);
  const [connected, setConnected] = useState(false);
  const currentSnapshot = useRef<ChatSnapshot>(INITIAL_CHAT);

  useEffect(() => {
    let active = true;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let socket: WebSocket | null = null;
    let retries = 0;
    const desktop = window.lonelyChat;

    const accept = (event: ChatEvent, reset = false) => {
      if (!active) return;
      const next = applyChatEvent(reset ? INITIAL_CHAT : currentSnapshot.current, event);
      currentSnapshot.current = next;
      setSnapshot(next);
    };

    if (desktop) {
      const unsubscribe = desktop.onChatEvent(accept);
      void desktop
        .getChatSnapshot()
        .then((event) => {
          accept(event);
          if (active) setConnected(true);
        })
        .catch(() => {
          if (active) setConnected(false);
        });
      return () => {
        active = false;
        unsubscribe();
      };
    }

    // A browser-source reconnect always replaces its state from a fresh snapshot.
    const connect = () => {
      if (!active) return;
      const wsUrl = new URL('/overlay/live', window.location.href);
      wsUrl.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      let waitingForSnapshot = true;
      socket = new WebSocket(wsUrl);
      socket.onopen = () => {};
      socket.onmessage = (message) => {
        try {
          const event: ChatEvent = JSON.parse(String(message.data));
          if (waitingForSnapshot && event.type !== 'snapshot') throw new Error('Missing snapshot');
          const reset = waitingForSnapshot;
          waitingForSnapshot = false;
          accept(event, reset);
          retries = 0;
          if (active) setConnected(true);
        } catch {
          socket?.close();
        }
      };
      socket.onerror = () => socket?.close();
      socket.onclose = () => {
        if (!active) return;
        setConnected(false);
        // A disconnected browser should not show a stale stream as current.
        retries += 1;
        retry = setTimeout(connect, Math.min(500 * 2 ** (retries - 1), 8000));
      };
    };
    connect();
    return () => {
      active = false;
      if (retry) clearTimeout(retry);
      socket?.close();
    };
  }, []);

  return { snapshot, connected };
}
