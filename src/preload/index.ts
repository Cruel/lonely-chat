import { contextBridge, ipcRenderer, webUtils } from 'electron';
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
  getVideoTools: () => invoke('video-tools:status'),
  chooseVideoToolsDirectory: () => invoke('video-tools:choose-directory'),
  resetVideoToolsDirectory: () => invoke('video-tools:reset'),
  configureNativeVideoPreferences: (preferences) => invoke('video-tools:preferences', preferences),
  choosePlaygroundVideo: (preferences) => invoke('playground:video:choose', preferences),
  listPromptPresets: () => invoke('presets:list'),
  listPromptPresetRevisions: (id) => invoke('presets:revisions', id),
  savePromptPreset: (input) => invoke('presets:save', input),
  deletePromptPreset: (id) => invoke('presets:delete', id),
  runFreeform: (request) => invoke('playground:run', request),
  previewSimulation: (request) => invoke('playground:simulation:preview', request),
  runSimulationExperiment: (request) => invoke('playground:simulation:run', request),
  getSpeechTestStatus: () => invoke('speech-test:status'),
  startSpeechTest: (config) => invoke('speech-test:start', config),
  submitSpeechTestPcm: (samples, backpressure) => invoke('speech-test:pcm', samples, backpressure),
  finishSpeechTest: () => invoke('speech-test:finish'),
  stopSpeechTest: () => invoke('speech-test:stop'),
  rerunCapturedSpeech: (id) => invoke('speech-test:rerun-captured', id),
  getSpeechCapture: () => invoke('speech-capture:get'),
  configureSpeechCapture: (enabled) => invoke('speech-capture:configure', enabled),
  deleteCapturedSpeech: (id) => invoke('speech-capture:delete', id),
  clearCapturedSpeech: () => invoke('speech-capture:clear'),
  exportCapturedSpeech: (id) => invoke('speech-capture:export', id),
  onSpeechCaptureChange: (listener) => {
    const receive = (
      _event: Electron.IpcRendererEvent,
      status: import('../shared/speech-capture-contract').SpeechCaptureStatus,
    ) => listener(status);
    ipcRenderer.on('speech-capture:change', receive);
    return () => ipcRenderer.removeListener('speech-capture:change', receive);
  },
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
  getPrivateWorkerLines: () => invoke('diagnostics:worker-lines'),
  getCompactRecording: () => invoke('compact:get'),
  configureCompactRecording: (enabled, mode) => invoke('compact:configure', enabled, mode),
  setCompactRecordingLimits: (limits) => invoke('compact:limits', limits),
  saveRecordedExactCase: (id, recordingId) => invoke('compact:save-case', id, recordingId),
  listCompactAttempts: () => invoke('compact:list'),
  reconstructCompactAttempt: (id, recordingId) => invoke('compact:reconstruct', id, recordingId),
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
  listInferenceTraces: () => invoke('trace:list'),
  getInferenceTrace: (id) => invoke('trace:get', id),
  searchInferenceTraces: (filter) => invoke('trace:search', filter),
  listRecordedScenarios: () => invoke('scenario:list'),
  saveRecordedScenario: (name, config, id) => invoke('scenario:save', name, config, id),
  deleteRecordedScenario: (id) => invoke('scenario:delete', id),
  listRecordedRuns: () => invoke('scenario:runs'),
  exportRecordedScenario: (id, includeMedia) => invoke('scenario:export', id, includeMedia),
  importRecordedScenario: () => invoke('scenario:import'),
  exportRecordedRun: (id) => invoke('run:export', id),
  importRecordedRun: () => invoke('run:import'),
  pathForRecordedFile: (file) => webUtils.getPathForFile(file) || null,
  openRecordedMedia: (path) => invoke('recorded:media:open', path),
  chooseRecordedMedia: (kind) => invoke('recorded:media:choose', kind),
  fingerprintRecordedMedia: (path) => invoke('recorded:media:fingerprint', path),
  listSavedCases: () => invoke('case:list'),
  getSavedCase: (id) => invoke('case:get', id),
  saveInferenceCase: (id) => invoke('case:save', id),
  runSavedCase: (fork) => invoke('case:run', fork),
  exportSavedCase: (id) => invoke('case:export', id),
  importSavedCase: () => invoke('case:import'),
  onInferenceTraces: (listener) => {
    const receive = (
      _event: Electron.IpcRendererEvent,
      snapshot: import('../shared/inference-trace-contract').TraceList,
    ) => listener(snapshot);
    ipcRenderer.on('trace:change', receive);
    return () => ipcRenderer.removeListener('trace:change', receive);
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
  pauseSession: () => invoke('session:pause'),
  prepareRecordedResume: () => invoke('session:resume:prepare'),
  cancelRecordedResume: () => invoke('session:resume:cancel'),
  resumeSession: () => invoke('session:resume'),
  finishRecordedSession: () => invoke('session:recorded:eof'),
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
  setModelProjector: (id, source) => invoke('models:projector:set', id, source),
  installModelProjector: (id, source, candidateId) =>
    invoke('models:projector:install', id, source, candidateId),
  cancelModelDownload: () => invoke('models:cancel'),
  activateModel: (role, id) => invoke('models:activate', role, id),
  removeModel: (id) => invoke('models:remove', id),
  chooseModelDirectory: () => invoke('models:choose-directory'),
  getVideoClock: () => invoke('video:clock'),
  reportRecordedVideoError: (message) => invoke('session:media-error', message),
  reportRecordedMediaIssue: (issue) => invoke('session:media-issue', issue),
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
  checkRecordedAudioCache: (query) => invoke('audio:cache:check', query),
  startRecordedAudio: (source) => invoke('audio:recorded:start', source),
  armRecordedAudio: (captureId, originMs, mediaStartMs) =>
    invoke('audio:recorded:arm', captureId, originMs, mediaStartMs),
  resyncRecordedAudio: (captureId, originMs, mediaStartMs) =>
    invoke('audio:recorded:resync', captureId, originMs, mediaStartMs),
  submitRecordedAudioPcm: (samples, captureId) => invoke('audio:recorded:pcm', samples, captureId),
  finishRecordedAudio: (captureId) => invoke('audio:recorded:finish', captureId),
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
