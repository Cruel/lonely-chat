import path from 'node:path';
import { createInterface } from 'node:readline';
import { ChatService, publishSample } from './chat-service';
import { OverlayServer } from './overlay-server';

const chat = new ChatService();
publishSample(chat);
const overlay = new OverlayServer(chat, path.join(import.meta.dirname, '../renderer'));
const url = await overlay.start(0);
console.log(JSON.stringify({ type: 'ready', url }));
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  if (line === 'publish') {
    publishSample(chat);
    console.log(JSON.stringify({ type: 'published', sequence: chat.snapshot().sequence }));
  }
  if (line === 'quit') break;
}
await overlay.stop();
