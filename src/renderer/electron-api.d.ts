import type { DesktopAPI } from '../shared/chat-contract';
declare global {
  interface Window {
    lonelyChat?: DesktopAPI;
  }
}
export {};
