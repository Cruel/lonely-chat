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
  getPlaygroundStatus: () => invoke('playground:status'),
  runFreeform: (request) => invoke('playground:run', request),
  getSpeechTestStatus: () => invoke('speech-test:status'),
  startSpeechTest: (config) => invoke('speech-test:start', config),
  submitSpeechTestPcm: (samples, backpressure) => invoke('speech-test:pcm', samples, backpressure),
  finishSpeechTest: () => invoke('speech-test:finish'),
  stopSpeechTest: () => invoke('speech-test:stop'),
  onSpeechTestChange: (listener) => {
    const receive = (
      _event: Electron.IpcRendererEvent,
      state: import('../shared/speech-playground-contract').SpeechTestSnapshot,
    ) => listener(state);
    ipcRenderer.on('speech-test:change', receive);
    return () => ipcRenderer.removeListener('speech-test:change', receive);
  },
  onPlaygroundStatus: (listener) => {
    const receive = (
      _event: Electron.IpcRendererEvent,
      status: import('../shared/playground-contract').PlaygroundStatus,
    ) => listener(status);
    ipcRenderer.on('playground:status-change', receive);
    return () => ipcRenderer.removeListener('playground:status-change', receive);
  },
  getDiagnosticCapture: () => invoke('diagnostics:get'),
  configureDiagnosticCapture: (enabled) => invoke('diagnostics:configure', enabled),
  exportDiagnosticCapture: () => invoke('diagnostics:export'),
  getOperationalLogs: () => invoke('logs:get'),
  configureOperationalLogs: (retention) => invoke('logs:configure', retention),
  exportOperationalLogs: (ids) => invoke('logs:export', ids),
  reportRendererFailure: (failure) => invoke('renderer:report-failure', failure),
  onOperationalLog: (listener) => {
    const receive = (
      _event: Electron.IpcRendererEvent,
      entry: import('../shared/log-contract').LogEntry,
    ) => listener(entry);
    ipcRenderer.on('logs:entry', receive);
    return () => ipcRenderer.removeListener('logs:entry', receive);
  },
  getChatSnapshot: () => invoke('chat:snapshot'),
  onChatEvent: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, data: ChatEvent) => listener(data);
    ipcRenderer.on('chat:event', receive);
    return () => ipcRenderer.removeListener('chat:event', receive);
  },
  publishSample: () => invoke('chat:sample'),
  getOverlayUrl: () => invoke('overlay:url'),
  getOverlayStatus: () => invoke('overlay:status'),
  configureOverlayPort: (port) => invoke('overlay:configure', port),
  onOverlayChange: (listener) => {
    const receive = (
      _event: Electron.IpcRendererEvent,
      status: import('../shared/overlay-contract').OverlayStatus,
    ) => listener(status);
    ipcRenderer.on('overlay:change', receive);
    return () => ipcRenderer.removeListener('overlay:change', receive);
  },
  getFloatingChat: () => invoke('floating:get'),
  openFloatingChat: () => invoke('floating:open'),
  closeFloatingChat: () => invoke('floating:close'),
  configureFloatingChat: (settings) => invoke('floating:configure', settings),
  getWindowStatus: () => invoke('window:get'),
  setCloseToTray: (enabled) => invoke('window:set-close-to-tray', enabled),
  onFloatingChatChange: (listener) => {
    const receive = (
      _event: Electron.IpcRendererEvent,
      status: import('../shared/floating-chat-contract').FloatingChatSnapshot,
    ) => listener(status);
    ipcRenderer.on('floating:change', receive);
    return () => ipcRenderer.removeListener('floating:change', receive);
  },
  getSessionSnapshot: () => invoke('session:snapshot'),
  onSessionChange: (listener) => {
    const receive = (
      _event: Electron.IpcRendererEvent,
      status: import('../shared/session-contract').SessionSnapshot,
    ) => listener(status);
    ipcRenderer.on('session:change', receive);
    return () => ipcRenderer.removeListener('session:change', receive);
  },
  startSession: (manualContext, mode, options) =>
    invoke('session:start', manualContext, mode, options),
  stopSession: () => invoke('session:stop'),
  onMediaStop: (listener) => {
    const receive = () => listener();
    ipcRenderer.on('media:stop', receive);
    return () => ipcRenderer.removeListener('media:stop', receive);
  },
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
  getVideoClock: () => invoke('video:clock'),
  reportRecordedVideoError: (message) => invoke('session:media-error', message),
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
