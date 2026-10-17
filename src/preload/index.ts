import { contextBridge, ipcRenderer } from 'electron';
import type {
  ChatEvent,
  DesktopAPI,
  DesktopArguments,
  DesktopInvocations,
} from '../shared/chat-contract';

function invoke<K extends keyof DesktopInvocations>(
  channel: K,
  ...args: DesktopArguments[K]
): Promise<DesktopInvocations[K]> {
  return ipcRenderer.invoke(channel, ...args) as Promise<DesktopInvocations[K]>;
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
  getSessionSnapshot: () => invoke('session:snapshot'),
  onSessionChange: (listener) => {
    const receive = (
      _event: Electron.IpcRendererEvent,
      status: import('../shared/session-contract').SessionSnapshot,
    ) => listener(status);
    ipcRenderer.on('session:change', receive);
    return () => ipcRenderer.removeListener('session:change', receive);
  },
  startSession: (manualContext, mode) => invoke('session:start', manualContext, mode),
  stopSession: () => invoke('session:stop'),
  retrySession: () => invoke('session:retry'),
  getNativeStatus: () => invoke('native:status'),
  onNativeChange: (listener) => {
    const receive = (
      _event: Electron.IpcRendererEvent,
      status: import('../shared/native-service-contract').NativeServiceStatus,
    ) => listener(status);
    ipcRenderer.on('native:change', receive);
    return () => ipcRenderer.removeListener('native:change', receive);
  },
  getPreferences: () => invoke('preferences:get'),
  setPreferences: (preferences) => invoke('preferences:set', preferences),
  getAudience: () => invoke('audience:get'),
  regenerateAudience: (mode) => invoke('audience:regenerate', mode),
  onAudienceChange: (listener) => {
    const receive = (
      _event: Electron.IpcRendererEvent,
      status: import('../shared/audience-contract').AudienceSnapshot,
    ) => listener(status);
    ipcRenderer.on('audience:change', receive);
    return () => ipcRenderer.removeListener('audience:change', receive);
  },
  discoverModels: (source) => invoke('models:discover', source),
  getModelsSnapshot: () => invoke('models:snapshot'),
  onModelsChange: (listener) => {
    const receive = (
      _event: Electron.IpcRendererEvent,
      snapshot: import('../shared/model-install-contract').ModelManagerSnapshot,
    ) => listener(snapshot);
    ipcRenderer.on('models:change', receive);
    return () => ipcRenderer.removeListener('models:change', receive);
  },
  installModel: (selection) => invoke('models:install', selection),
  cancelModelDownload: () => invoke('models:cancel'),
  activateModel: (role, id) => invoke('models:activate', role, id),
  removeModel: (id) => invoke('models:remove', id),
  chooseModelDirectory: () => invoke('models:choose-directory'),
  listDisplaySources: () => invoke('video:list-displays'),
  selectVideoSource: (sourceId) => invoke('video:select', sourceId),
  submitVideoFrame: (frame) => invoke('video:frame', frame),
  getAudioConfiguration: () => invoke('audio:configuration:get'),
  setAudioConfiguration: (inputs) => invoke('audio:configuration:set', inputs),
  getAudioStatus: () => invoke('audio:status'),
  getAudioCapabilities: () => invoke('audio:capabilities'),
  setAudioLabel: (id, label) => invoke('audio:label', id, label),
  audioDisconnected: (captureId) => invoke('audio:disconnected', captureId),
  removeAudioInput: (id) => invoke('audio:remove', id),
  startAudio: (id, sourceId, label, captureId) =>
    invoke('audio:start', id, sourceId, label, captureId),
  retryAudio: (id) => invoke('audio:retry', id),
  stopAudio: (captureId) => invoke('audio:stop', captureId),
  submitAudioSegment: (segment, captureId) => invoke('audio:segment', segment, captureId),
  onAudioChange: (listener) => {
    const receive = (
      _event: Electron.IpcRendererEvent,
      snapshot: import('../shared/audio-contract').AudioStatus,
    ) => listener(snapshot);
    ipcRenderer.on('audio:change', receive);
    return () => ipcRenderer.removeListener('audio:change', receive);
  },
};
contextBridge.exposeInMainWorld('lonelyChat', api);
