import { contextBridge, ipcRenderer } from 'electron';
import type { ChatEvent, DesktopAPI, DesktopInvocations } from '../shared/chat-contract';

function invoke<K extends keyof DesktopInvocations>(channel: K): Promise<DesktopInvocations[K]> {
  return ipcRenderer.invoke(channel) as Promise<DesktopInvocations[K]>;
}

const api: DesktopAPI = {
  getChatSnapshot: () => invoke('chat:snapshot'),
  onChatEvent: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, data: ChatEvent) => listener(data);
    ipcRenderer.on('chat:event', receive);
    return () => ipcRenderer.removeListener('chat:event', receive);
  },
  publishSample: () => invoke('chat:sample'),
  getOverlayUrl: () => invoke('overlay:url'),
};
contextBridge.exposeInMainWorld('lonelyChat', api);
