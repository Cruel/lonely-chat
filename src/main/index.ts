import path from 'node:path';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { SavedInferenceCases } from './saved-inference-cases';
import { splitRequests } from './split-inference';
import { makeArchive, openArchive } from './portable-archive';
import { packageScenario, importScenario, portableRun, restoreRun } from './portable-scenarios';
import {
  RecordedScenarioStore,
  validateScenarioConfig,
  verifyRecordedSources,
} from './recorded-scenarios';
import { RecordedMediaAccess, MEDIA_SCHEME } from './recorded-media-access';
import { reportRecordedMediaIssue } from './recorded-media-health';
import type { RecordedRun } from '../shared/recorded-scenario-contract';
import { DiagnosticCapture } from './diagnostic-capture';
import { CompactInferenceRecorder } from './compact-inference-recorder';
import { OperationalLogger } from './operational-logger';
import { serializeOperationalLogs } from './operational-log-export';
import { validateRendererFailure } from '../shared/renderer-log-contract';
import { PlaygroundService } from './playground-service';
import { PlaygroundVideoTools } from './playground-video-tools';
import { canStartPausedSpeech } from './paused-speech-gate';
import { RecordedResumeReservation } from './recorded-resume-reservation';
import { PromptPresetStore } from './prompt-preset-store';
import { InferenceProfileStore } from './inference-profile-store';
import { resolveUnifiedProfilePolicy } from '../shared/inference-profile-contract';
import { SpeechPlaygroundService } from './speech-playground-service';
import { SpeechSegmentCapture } from './speech-segment-capture';
import { installElectronSmoke } from './electron-smoke';
import { installPackagedE2E } from './packaged-e2e';
import {
  certificationPlaygroundProvider,
  certificationSessionInferenceProvider,
  CertificationSpeechWorker,
} from './certification-workers';
import { observationNow } from '../shared/observation-clock';
import { trustedDesktopURL } from './desktop-renderer-origin';
import {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  dialog,
  desktopCapturer,
  Tray,
  Menu,
  nativeImage,
  safeStorage,
  clipboard,
  protocol,
} from 'electron';
import { ChatService, publishSample } from './chat-service';
import { SessionController } from './session-controller';
import { SessionMedia } from './session-media';
import { PreferencesStore } from './preferences-store';
import { RemoteInferenceStore } from './remote-inference-store';
import { ChatGPTAuth } from './chatgpt-auth';
import { CredentialPolicy } from './credential-persistence';
import { chatGPTUnifiedAdapter, probeChatGPTModel } from './chatgpt-inference';
import {
  remoteUnifiedAdapter,
  probeRemoteModel,
  listRemoteModels,
  inspectRemoteModel,
} from './remote-inference-adapter';
import { remoteConnectionKey } from '../shared/remote-inference-contract';
import { RemoteInferencePlayground } from './remote-inference-playground';
import {
  DEFAULT_PREFERENCES,
  validatePreferences,
  allowsRecordedSessionMedia,
} from '../shared/session-contract';
import { AudienceService } from './audience-service';
import { FakeInference } from './fake-inference';
import { OverlayServer } from './overlay-server';
import { OverlayController } from './overlay-controller';
import { OverlayPortStore } from './overlay-port-store';
import { FloatingChatWindowController } from './floating-chat-window';
import { DesktopLifecycle } from './desktop-lifecycle';
import { ManagedShutdown } from './shutdown-managed-services';
import { WindowPreferencesStore } from './window-preferences-store';
import {
  DEFAULT_WINDOW_PREFERENCES,
  type WindowPreferences,
} from '../shared/window-preferences-contract';
import { ModelDiscovery } from './model-discovery';
import { ModelInstallManager } from './model-install-manager';
import { NativeInference } from './native-inference';
import { nativeWorkerSettings } from './native-worker-settings';
import {
  bundledAcceleratedLlamaServer,
  bundledLlamaServer,
  bundledWhisperWorker,
} from './native-runtime-path';
import { NativeSpeech } from './native-speech';
import { AudioService } from './audio-service';
import { RecordedTranscriptCache } from './recorded-transcript-cache';
import { validateTranscriptCacheQuery } from '../shared/recorded-transcript-cache';
import { AudioConfigStore } from './audio-config-store';
import type { ChatEvent, DesktopInvocations, DesktopArguments } from '../shared/chat-contract';

// Register before Electron ready. Only the private desktop renderer receives opaque media URLs.
protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      stream: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);
const rendererDirectory = path.join(__dirname, '../renderer');
const preloadPath = path.join(__dirname, '../preload/preload.cjs');
const devOrigin = process.env.LONELY_CHAT_RENDERER_URL;
const packageE2E = process.env.LONELY_CHAT_CERTIFY_E2E === '1';
if (packageE2E) {
  const profile = process.env.LONELY_CHAT_CERT_PROFILE;
  if (
    !app.isPackaged ||
    !profile ||
    !path.isAbsolute(profile) ||
    !process.env.LONELY_CHAT_CERT_MEDIA_DIR
  )
    throw new Error(
      'Package certification requires an isolated profile, media fixtures and a packaged executable.',
    );
  app.setPath('userData', profile);
}
// Initialized before services and before app.whenReady(), to retain early boot errors.
const logger = new OperationalLogger(app.getPath('userData'));
logger.info('application', 'Lonely Chat process starting');
const logReady = logger.open();
process.on('uncaughtExceptionMonitor', (error) =>
  logger.error('process', 'Uncaught exception', error),
);
process.on('unhandledRejection', (reason) =>
  logger.error('process', 'Unhandled promise rejection', reason),
);
const chat = new ChatService();
const diagnostics = new DiagnosticCapture();
const compactRecorder = new CompactInferenceRecorder(app.getPath('userData'), (error) =>
  logger.error('recording', 'Unable to write compact inference evidence', error),
);
const reportError = (
  source: string,
  text: string,
  error?: unknown,
  context?: Record<string, unknown>,
) => logger.error(source, text, error, context);
const overlay = new OverlayController(
  () => new OverlayServer(chat, rendererDirectory, devOrigin),
  new OverlayPortStore(app.getPath('userData')),
  reportError,
);
const floating = new FloatingChatWindowController(
  (options) => {
    const window = new BrowserWindow({
      ...options,
      minWidth: 240,
      minHeight: 240,
      title: 'Lonely Chat — Floating Chat',
      backgroundColor: options.transparent ? '#00000000' : '#101015',
      autoHideMenuBar: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    // Unlike the desktop window, this window has no preload or privileged IPC.
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => {
      const target = new URL(url);
      const current = overlay.snapshot().url;
      if (!current || target.origin !== new URL(current).origin || target.pathname !== '/overlay') {
        event.preventDefault();
      }
    });
    return window;
  },
  () => {
    const url = overlay.snapshot().url;
    if (!url) throw new Error('Chat overlay server is unavailable.');
    return url;
  },
  reportError,
);
const preferenceStore = new PreferencesStore(app.getPath('userData'));
const credentialProtector = {
  available: () =>
    safeStorage.isEncryptionAvailable() &&
    (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
  encrypt: (secret: string) => safeStorage.encryptString(secret),
  decrypt: (encrypted: Buffer) => safeStorage.decryptString(encrypted),
};
const credentialPolicy = new CredentialPolicy(app.getPath('userData'));
const remoteStore = new RemoteInferenceStore(
  app.getPath('userData'),
  credentialProtector,
  process.env,
  credentialPolicy,
);
const chatGPTAuth = new ChatGPTAuth(
  app.getPath('userData'),
  credentialProtector,
  {
    openBrowser: (url) => shell.openExternal(url),
    onAuthorizationLink: (url) => {
      if (mainWindow && !mainWindow.isDestroyed())
        mainWindow.webContents.send('chatgpt:authorization:change', url);
    },
  },
  credentialPolicy,
);
const remotePlayground = new RemoteInferencePlayground();
const promptPresets = new PromptPresetStore(app.getPath('userData'));
const inferenceProfiles = new InferenceProfileStore(app.getPath('userData'), (ref, role) =>
  ref.kind === 'remote'
    ? remoteStore
        .list()
        .models.some(
          (model) =>
            model.id === ref.modelId &&
            (role !== 'observer' || (model.images && model.allowRemoteImages)),
        )
    : installs
        .snapshot()
        .installations.some(
          (model) =>
            model.id === ref.modelId && !model.projectorOnly && model.role === 'vision-language',
        ),
);
const audioConfig = new AudioConfigStore(app.getPath('userData'));
const transcriptCache = new RecordedTranscriptCache(app.getPath('userData'));
const speechCapture = new SpeechSegmentCapture(app.getPath('userData'), (error) =>
  logger.error('recording', 'Unable to store private speech segment evidence', error),
);
const savedCases = new SavedInferenceCases(app.getPath('userData'));
const recordedScenarios = new RecordedScenarioStore(app.getPath('userData'));
const recordedMediaAccess = new RecordedMediaAccess();
let activeRecordedRun: {
  id: string;
  sessionRunId: number;
  config: import('../shared/recorded-scenario-contract').RecordedScenarioConfig;
} | null = null;
let pendingRecordedFinish: Promise<void> = Promise.resolve();
const windowStore = new WindowPreferencesStore(app.getPath('userData'));
let windowPrefs: WindowPreferences = DEFAULT_WINDOW_PREFERENCES;
let pendingWindowSave: ReturnType<typeof setTimeout> | null = null;

function scheduleWindowSave(): void {
  if (pendingWindowSave) clearTimeout(pendingWindowSave);
  pendingWindowSave = setTimeout(() => {
    pendingWindowSave = null;
    void windowStore
      .write(windowPrefs)
      .catch((error: unknown) => logger.error('window', 'Unable to save window settings', error));
  }, 250);
}

async function flushWindowSave(): Promise<void> {
  if (pendingWindowSave) clearTimeout(pendingWindowSave);
  pendingWindowSave = null;
  await windowStore.write(windowPrefs);
}

// Compact opaque 24px chat icon. No platform asset path is needed in packaged builds.
const TRAY_ICON =
  'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAo0lEQVR4nO2VSxJAQAxEI2XDGbkFp+AWnJElq1HD5FcRO71MMq/plAHwS1FFFaduOzywcW0LHkbBubOoDbw1Qa4RZVJEFK1aGxiWRuzP/S72xTfQ4JYZ0UB7OsuMGpHFRJJ5yVQUlghNBgmUA6ma2yDFlMdF1dwGHMiyn8uAuqi8ylnINSLghcFbE+qsCHtegB5zdskRcADDlxy5/Jsi/w+f6gRvGkULxKoxWAAAAABJRU5ErkJggg==';
const lifecycle = new DesktopLifecycle(
  () => {
    const icon = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON, 'base64'));
    if (icon.isEmpty()) throw new Error('Tray icon is unavailable.');
    const tray = new Tray(icon);
    tray.setToolTip('Lonely Chat');
    return {
      setActions: (actions) =>
        tray.setContextMenu(
          Menu.buildFromTemplate(
            actions.map((action) => ({
              label: action.label,
              enabled: action.enabled,
              click: action.action,
            })),
          ),
        ),
      onClick: (listener) => tray.on('click', listener),
      destroy: () => tray.destroy(),
    };
  },
  () => !!session && ['starting', 'running', 'switching'].includes(session.snapshot().phase),
  () => {
    stopSession();
  },
  () => {
    app.quit();
  },
  () => {
    if (!mainWindow && !quitting) openMainWindow();
  },
  (error) => logger.warn('tray', 'System tray unavailable; window will close normally', error),
);

function windowStatus() {
  return { closeToTray: windowPrefs.closeToTray, trayAvailable: lifecycle.hasTray };
}
const models = new ModelDiscovery();
const installs = new ModelInstallManager(app.getPath('userData'), models);
const videoTools = new PlaygroundVideoTools(app.getPath('userData'));
let session: SessionController;
let audience: AudienceService;
let nativeInference: NativeInference;
let localModelPool: import('./local-model-pool').LocalModelPool | null = null;
let localWarmIdleMs = 0;
let playground: PlaygroundService;
let speechTest: SpeechPlaygroundService;
let audio: AudioService;
let sessionMedia: SessionMedia | undefined;
let mainWindow: BrowserWindow | null = null;
let quitting = false;
let teardownComplete = false;
let selectedDisplaySource: Electron.DesktopCapturerSource | null = null;
let videoSelectionGeneration = 0;
let rosterRegenerating = false;
let rosterGenerationAbort: AbortController | null = null;
let speechSwitchBusy = false;
// Block Playground acquisition throughout asynchronous Simulation start/retry validation.
let sessionStarting = false;
// A trusted IPC reservation serializes model ownership while decoder playback
// restarts; the Session timeline itself remains paused until the commit.
const resumeReservation = new RecordedResumeReservation();

/** Both desktop and tray Stop retire every producer, not only the VLM. */
function stopSession() {
  resumeReservation.cancel();
  if (localModelPool) void localModelPool.release();
  return sessionMedia ? sessionMedia.stop() : session?.stop();
}

async function listDesktopSources(): Promise<Electron.DesktopCapturerSource[]> {
  return desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 0, height: 0 },
    fetchWindowIcons: false,
  });
}

function trustedSender(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
  if (
    mainWindow?.webContents !== event.sender ||
    !event.senderFrame ||
    event.senderFrame !== event.sender.mainFrame
  )
    return false;
  return trustedDesktopURL(
    event.senderFrame.url,
    path.join(rendererDirectory, 'index.html'),
    devOrigin,
  );
}

function requireDesktop(event: Electron.IpcMainInvokeEvent): void {
  if (!trustedSender(event)) throw new Error('Unauthorized desktop IPC sender');
}

function requireRecordedAudio(): void {
  const state = session.snapshot();
  if (state.inputMode !== 'recorded' || !allowsRecordedSessionMedia(state))
    throw new Error('Recorded audio requires an active recorded simulation.');
}

function registerHandlers(): void {
  const broadcastVideoTools = (
    status: import('../shared/video-tools-contract').VideoToolsStatus,
  ) => {
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('video-tools:change', status);
    return status;
  };
  const actions = {
    'chatgpt:status': () => chatGPTAuth.status(),
    'chatgpt:persistence:set': async (persist: boolean) => {
      if (typeof persist !== 'boolean') throw new Error('Invalid credential persistence mode.');
      await credentialPolicy.setPersist(persist);
      await chatGPTAuth.applyCredentialPolicy();
      await remoteStore.applyCredentialPolicy();
      return chatGPTAuth.status();
    },
    'chatgpt:signin': (id?: string) => chatGPTAuth.signIn(id),
    'chatgpt:authorization:get': () => chatGPTAuth.authorizationUrl(),
    'chatgpt:authorization:open': () => chatGPTAuth.openAuthorizationLink(),
    'chatgpt:authorization:copy': () => {
      const url = chatGPTAuth.authorizationUrl();
      if (!url) throw new Error('ChatGPT authorization is not active.');
      clipboard.writeText(url);
    },
    'chatgpt:select': (id: string) => chatGPTAuth.select(id),
    'chatgpt:signout': (id: string) => chatGPTAuth.signOut(id),
    'chatgpt:models': (id: string) => chatGPTAuth.models(id),
    'remote:list': () => remoteStore.list(),
    'remote:connection:save': (
      connection: import('../shared/remote-inference-contract').RemoteConnection,
    ) => remoteStore.putConnection(connection),
    'remote:connection:delete': (id: string) => remoteStore.removeConnection(id),
    'remote:model:save': (
      model: import('../shared/remote-inference-contract').RemoteModelConfiguration,
    ) => remoteStore.putModel(model),
    'remote:model:delete': (id: string) => remoteStore.removeModel(id),
    'remote:credential:set': (id: string, secret: string) => remoteStore.setCredential(id, secret),
    'remote:models:list': async (connectionId: string) => {
      const { connection, credential } = remoteStore.resolve(connectionId);
      if (connection.credentialMode === 'chatgpt')
        return (await chatGPTAuth.models(connection.chatgptAccountId!)).map((model) => model.id);
      return listRemoteModels(
        {
          connection,
          credential,
          model: {
            id: 'model-discovery',
            connectionId,
            name: 'Discovery',
            model: 'discovery',
            images: false,
            allowRemoteImages: false,
            outputFormat: 'prompt-json',
          },
        },
        AbortSignal.timeout(20_000),
      );
    },
    'remote:model:probe': async (modelId: string) => {
      const selection = remoteStore.selected(modelId);
      const result =
        selection.connection.credentialMode === 'chatgpt'
          ? await probeChatGPTModel(selection, chatGPTAuth, AbortSignal.timeout(25_000))
          : await probeRemoteModel(selection, AbortSignal.timeout(25_000));
      await remoteStore.recordCapabilities(
        modelId,
        {
          connectionKey: remoteConnectionKey(selection.connection),
          model: selection.model.model,
        },
        'probe',
        {
          text: true,
          ...(selection.model.outputFormat === 'json-schema' ? { jsonSchema: true } : {}),
          ...(selection.model.outputFormat === 'json-object' ? { jsonObject: true } : {}),
        },
      );
      return result;
    },
    'remote:model:inspect': async (modelId: string) => {
      const selection = remoteStore.selected(modelId);
      if (selection.connection.credentialMode === 'chatgpt')
        throw new Error(
          'ChatGPT plan catalog does not expose capability metadata. Use a text compatibility probe or explicit overrides.',
        );
      const support = await inspectRemoteModel(selection, AbortSignal.timeout(20_000));
      return remoteStore.recordCapabilities(
        modelId,
        {
          connectionKey: remoteConnectionKey(selection.connection),
          model: selection.model.model,
        },
        'metadata',
        support,
      );
    },
    'remote:playground:unified': async (
      request: import('../shared/playground-contract').SimulationExperimentRequest,
      modelId: string,
    ) => {
      if (
        ['running', 'starting', 'switching'].includes(session.snapshot().phase) ||
        sessionStarting
      )
        throw new Error('Stop Simulation before running remote Playground.');
      const selection = remoteStore.selected(modelId);
      const settings = session.getPreferences();
      return remotePlayground.run(
        request,
        selection,
        settings,
        selection.connection.credentialMode === 'chatgpt'
          ? (roster) =>
              chatGPTUnifiedAdapter(selection, chatGPTAuth, {
                roster,
                timeoutMs: settings.inferenceTimeoutMs,
              })
          : undefined,
      );
    },
    'playground:status': () => playground.snapshot(),
    'video-tools:status': async () => broadcastVideoTools(await videoTools.status(true)),
    'video-tools:choose-directory': async () => {
      const selection = await dialog.showOpenDialog({
        title: 'Select directory containing ffmpeg and ffprobe',
        properties: ['openDirectory'],
      });
      if (selection.canceled || !selection.filePaths[0]) return videoTools.status();
      await playground.stop();
      return broadcastVideoTools(await videoTools.configure(selection.filePaths[0]));
    },
    'video-tools:reset': async () => {
      await playground.stop();
      return broadcastVideoTools(await videoTools.configure(null));
    },
    'video-tools:preferences': async (
      preferences: import('../shared/video-tools-contract').NativeVideoPreferences,
    ) => {
      await playground.stop();
      return broadcastVideoTools(await videoTools.configurePreferences(preferences));
    },
    'playground:video:choose': async (
      preferences?: import('../shared/video-tools-contract').NativeVideoPreferences,
    ) => {
      if (playground.busy) throw new Error('Wait for the current Playground request.');
      const selection = await dialog.showOpenDialog({
        title: 'Choose a native video clip',
        properties: ['openFile'],
        filters: [{ name: 'Video clips', extensions: ['mp4', 'webm', 'mov', 'mkv'] }],
      });
      if (selection.canceled || !selection.filePaths[0]) return null;
      return videoTools.select(selection.filePaths[0], preferences);
    },
    'profiles:list': () => inferenceProfiles.list(),
    'profiles:revisions': (id: string) => inferenceProfiles.revisions(id),
    'profiles:save': (input: Parameters<InferenceProfileStore['save']>[0]) =>
      inferenceProfiles.save(input),
    'profiles:delete': (id: string) => inferenceProfiles.delete(id),
    'presets:list': () => promptPresets.list(),
    'presets:revisions': (id: string) => promptPresets.revisions(id),
    'presets:save': (input: {
      id?: string;
      name: string;
      values: import('../shared/playground-contract').SimulationExperimentValues;
    }) => promptPresets.save(input),
    'presets:delete': (id: string) => promptPresets.delete(id),
    'playground:run': (request: import('../shared/playground-contract').FreeformRequest) =>
      playground.run(request),
    'profiles:preview-stages': (input: import('./fake-inference').InferenceInput, stages: import('../shared/inference-profile-contract').InferenceProfileValues['stageDefaults'], events: import('../shared/session-contract').InferredEvent[], observations: import('../shared/session-contract').CapturedObservation[]) => {
      const built = splitRequests(input, stages);
      const redact = (request: ReturnType<typeof built.chat>) => ({
        ...request,
        content: request.content.map((part) => part.type === 'image' ? { ...part, dataUrl: '[image bytes redacted]' } : part),
      });
      return { vision: redact(built.vision), chat: redact(built.chat(events, observations)) };
    },
    'playground:simulation:preview': (
      request: import('../shared/playground-contract').SimulationExperimentRequest,
    ) => playground.previewSimulation(request),
    'playground:simulation:run': async (
      request: import('../shared/playground-contract').SimulationExperimentRequest,
    ) => {
      const result = await playground.runSimulation(request);
      if (result.errorStage)
        logger.error('playground', 'Structured Simulation experiment failed', undefined, {
          phase: result.errorStage,
        });
      return result;
    },
    'speech-test:status': () => speechTest.snapshot(),
    'speech-test:start': (config: import('../shared/speech-playground-contract').SpeechTestStart) =>
      speechTest.start(config),
    'speech-test:pcm': (samples: Float32Array, backpressure?: boolean) =>
      speechTest.push(samples, backpressure),
    'speech-test:finish': () => speechTest.finish(),
    'speech-test:stop': () => speechTest.stop(),
    'speech-test:rerun-captured': (id: string) => speechTest.rerunCaptured(id),
    'speech-capture:get': () => speechCapture.status(),
    'speech-capture:configure': (enabled: boolean) => speechCapture.configure(enabled),
    'speech-capture:delete': (id: string) => speechCapture.deleteRecord(id),
    'speech-capture:clear': () => speechCapture.clear(),
    'speech-capture:export': async (id: string) => {
      if (!mainWindow) throw new Error('Desktop window is unavailable.');
      const payload = await speechCapture.exportRecord(id);
      const selection = await dialog.showSaveDialog(mainWindow, {
        title: 'Export private PCM, source labels and transcript (review before sharing)',
        defaultPath: `speech-segment-${id}.json`,
        filters: [{ name: 'Raw speech evidence (JSON)', extensions: ['json'] }],
      });
      if (selection.canceled || !selection.filePath) return false;
      await writeFile(selection.filePath, payload, { mode: 0o600 });
      return true;
    },
    'logs:get': async () => {
      await logReady;
      return logger.snapshot();
    },
    'logs:configure': (retention: import('../shared/log-contract').LogRetention) =>
      logger.configure(retention),
    'logs:export': async (ids: readonly string[]) => {
      if (!mainWindow) throw new Error('Desktop window is unavailable.');
      await logReady;
      const data = serializeOperationalLogs(logger.snapshot().entries, ids);
      const choice = await dialog.showSaveDialog(mainWindow, {
        title: 'Export operational logs (review before sharing)',
        defaultPath: 'lonely-chat-logs.jsonl',
        filters: [{ name: 'Operational JSONL logs', extensions: ['jsonl'] }],
      });
      if (choice.canceled || !choice.filePath) return false;
      await writeFile(choice.filePath, data, { mode: 0o600 });
      return true;
    },
    'renderer:report-failure': (
      value: import('../shared/renderer-log-contract').RendererFailure,
    ) => {
      const failure = validateRendererFailure(value);
      const error = new Error(failure.name + ' in desktop renderer');
      error.stack = [error.message, ...failure.frames.map((frame) => 'at ' + frame)].join('\n');
      if (failure.cause) error.cause = new Error('Caused by ' + failure.cause);
      logger.error('renderer', 'Desktop renderer failure', error, {
        operation: failure.area,
        phase: failure.kind,
      });
    },
    'compact:get': () => compactRecorder.status(),
    'compact:configure': (
      enabled: boolean,
      mode?: import('../shared/compact-recording-contract').InferenceRecordingMode,
    ) =>
      compactRecorder.configure(
        enabled,
        mode,
        !!session && !['stopped', 'completed', 'error'].includes(session.snapshot().phase),
      ),
    'compact:limits': (limits: import('../shared/compact-recording-contract').RecordingLimits) =>
      compactRecorder.setLimits(limits),
    'compact:save-case': async (id: string, recordingId: string) => {
      const evidence = await compactRecorder.reconstruct(id, recordingId);
      if (!evidence || evidence.request === null)
        throw new Error('Recorded attempt has no request to save.');
      return savedCases.save(
        await compactRecorder.restoreRecordedAttempt(id, recordingId),
        evidence.provenance === 'current-builder-reconstruction'
          ? 'current-builder-reconstruction'
          : 'exact-recorded-request',
      );
    },
    'compact:list': () => compactRecorder.list(),
    'compact:reconstruct': (id: string, recordingId: string) =>
      compactRecorder.reconstruct(id, recordingId),
    'diagnostics:get': () => diagnostics.status(),
    'diagnostics:worker-lines': () => diagnostics.privateWorkerLines(),
    'diagnostics:configure': (enabled: boolean) => diagnostics.configure(enabled),
    'diagnostics:export': async () => {
      if (!mainWindow) throw new Error('Desktop window is unavailable.');
      if (!diagnostics.status().enabled) throw new Error('Enable diagnostic capture first.');
      const choice = await dialog.showSaveDialog(mainWindow, {
        title: 'Export private diagnostic samples (includes images and transcripts)',
        defaultPath: 'lonely-chat-diagnostics.json',
        filters: [{ name: 'JSON diagnostic capture', extensions: ['json'] }],
      });
      if (choice.canceled || !choice.filePath) return false;
      await writeFile(choice.filePath, diagnostics.export(), { mode: 0o600 });
      return true;
    },
    'chat:snapshot': () => chat.snapshot(),
    'chat:sample': () => {
      publishSample(chat);
    },
    'overlay:url': () => overlay.snapshot().url,
    'overlay:status': () => overlay.snapshot(),
    'overlay:configure': async (port: number) => {
      const previous = overlay.snapshot().url;
      const next = await overlay.configure(port);
      if (next.url !== previous && floating.snapshot().open) {
        // Existing capture windows must reconnect to the new listener.
        floating.close();
        if (next.url) floating.open();
      }
      return next;
    },
    'floating:get': () => floating.snapshot(),
    'floating:open': () => {
      if (!overlay.snapshot().url) throw new Error('Start the overlay server in Settings first.');
      return floating.open();
    },
    'floating:close': () => floating.close(),
    'floating:configure': async (
      settings: import('../shared/floating-chat-contract').FloatingChatSettings,
    ) => {
      const result = floating.configure(settings);
      await flushWindowSave();
      return result;
    },
    'window:get': () => windowStatus(),
    'window:set-close-to-tray': async (enabled: boolean) => {
      if (typeof enabled !== 'boolean') throw new Error('Invalid close-to-tray setting.');
      windowPrefs = { ...windowPrefs, closeToTray: enabled };
      lifecycle.setCloseToTray(enabled);
      await flushWindowSave();
      return windowStatus();
    },
    'trace:list': () => session.trace.list(),
    'scenario:list': () => recordedScenarios.list(),
    'scenario:save': (
      name: string,
      config: import('../shared/recorded-scenario-contract').RecordedScenarioConfig,
      id?: string,
    ) => recordedScenarios.save(name, config, id),
    'scenario:delete': (id: string) => recordedScenarios.delete(id),
    'scenario:runs': async () => {
      await pendingRecordedFinish;
      return recordedScenarios.runs();
    },
    'scenario:export': async (id: string, includeMedia: boolean) => {
      if (!mainWindow) throw new Error('Desktop window unavailable.');
      if (typeof includeMedia !== 'boolean') throw new Error('Invalid media export option.');
      const scenario = (await recordedScenarios.list()).find((item) => item.id === id);
      if (!scenario) throw new Error('Recorded Scenario not found.');
      const choice = await dialog.showSaveDialog(mainWindow, {
        title: 'Export private Scenario (prompts, settings and optional original media)',
        defaultPath: 'lonely-chat-scenario.lcscenario',
        filters: [{ name: 'Portable Scenario', extensions: ['lcscenario'] }],
      });
      if (choice.canceled || !choice.filePath) return false;
      const archive = await packageScenario(scenario, includeMedia);
      await writeFile(choice.filePath, archive, { mode: 0o600 });
      return true;
    },
    'scenario:import': async () => {
      if (!mainWindow) throw new Error('Desktop window unavailable.');
      const choice = await dialog.showOpenDialog(mainWindow, {
        title: 'Import portable Scenario (review and relink media before Start)',
        properties: ['openFile'],
        filters: [{ name: 'Portable Scenario', extensions: ['lcscenario'] }],
      });
      if (choice.canceled || !choice.filePaths[0]) return null;
      if ((await stat(choice.filePaths[0])).size > 192 * 1024 * 1024)
        throw new Error('Portable Scenario exceeds size limit.');
      return importScenario(
        await readFile(choice.filePaths[0], 'utf8'),
        recordedScenarios,
        app.getPath('userData'),
      );
    },
    'run:export': async (id: string) => {
      if (!mainWindow) throw new Error('Desktop window unavailable.');
      await pendingRecordedFinish;
      const run = (await recordedScenarios.runs()).find((item) => item.id === id);
      if (!run) throw new Error('Recorded Run not found.');
      if (run.status === 'running') throw new Error('Stop this Run before exporting its evidence.');
      const choice = await dialog.showSaveDialog(mainWindow, {
        title: 'Export private Run (prompts, transcripts, JPEGs, retries, responses)',
        defaultPath: 'lonely-chat-run.lcrun',
        filters: [{ name: 'Portable recorded Run', extensions: ['lcrun'] }],
      });
      if (choice.canceled || !choice.filePath) return false;
      const evidence = await compactRecorder.exportRunEvidence(
        run.sessionRunId,
        run.recordingIds,
        Date.parse(run.startedAt),
        run.endedAt ? Date.parse(run.endedAt) : undefined,
      );
      await writeFile(
        choice.filePath,
        makeArchive(
          'run',
          {
            run: portableRun(run),
            recordings: evidence.recordings,
          },
          evidence.files,
        ),
        { mode: 0o600 },
      );
      return true;
    },
    'run:import': async () => {
      if (!mainWindow) throw new Error('Desktop window unavailable.');
      const choice = await dialog.showOpenDialog(mainWindow, {
        title: 'Import private recorded Run (never publishes to overlay)',
        properties: ['openFile'],
        filters: [{ name: 'Portable recorded Run', extensions: ['lcrun'] }],
      });
      if (choice.canceled || !choice.filePaths[0]) return null;
      if ((await stat(choice.filePaths[0])).size > 192 * 1024 * 1024)
        throw new Error('Portable Run exceeds size limit.');
      const { metadata, files } = openArchive(await readFile(choice.filePaths[0], 'utf8'), 'run');
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
        throw new Error('Invalid Run archive metadata.');
      const info = metadata as { run: unknown; recordings: unknown };
      const restored = await restoreRun(info.run, app.getPath('userData'));
      let imported: string[] = [];
      try {
        imported = await compactRecorder.importRunEvidence(
          restored.run.sessionRunId,
          info.recordings,
          files,
        );
        return await recordedScenarios.importRun({ ...restored.run, recordingIds: imported });
      } catch (error) {
        await rm(restored.directory, { recursive: true, force: true });
        for (const recording of imported)
          await rm(path.join(app.getPath('userData'), 'compact-inference', recording), {
            recursive: true,
            force: true,
          });
        await compactRecorder.loadLimits();
        throw error;
      }
    },
    'recorded:media:open': (file: string) => recordedMediaAccess.open(file),
    'recorded:media:fingerprint': (file: string) => recordedMediaAccess.fingerprint(file),
    'recorded:media:choose': async (kind: 'video' | 'audio') => {
      if (kind !== 'video' && kind !== 'audio') throw new Error('Invalid recorded media type.');
      if (!mainWindow || mainWindow.isDestroyed()) throw new Error('Desktop window unavailable.');
      const choice = await dialog.showOpenDialog(mainWindow, {
        title: kind === 'video' ? 'Select recorded video' : 'Select recorded audio',
        properties: ['openFile'],
        filters: [
          {
            name: kind === 'video' ? 'Video files' : 'Audio files',
            extensions:
              kind === 'video'
                ? ['mp4', 'mkv', 'mov', 'webm', 'm4v']
                : ['wav', 'flac', 'mp3', 'ogg', 'oga', 'm4a', 'aac'],
          },
        ],
      });
      return choice.canceled ? null : (choice.filePaths[0] ?? null);
    },
    'case:list': () => savedCases.list(),
    'case:get': (id: string) => savedCases.get(id),
    'case:save': (id: string) => {
      if (
        typeof id !== 'string' ||
        !/^attempt-(?:\d{1,12}|[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})$/i.test(id)
      )
        throw new Error('Invalid inference attempt ID.');
      const attempt = session.trace.get(id);
      if (!attempt) throw new Error('Inference attempt is no longer available in memory.');
      return savedCases.save(attempt);
    },
    'case:run': (fork: import('../shared/saved-case-contract').SavedCaseFork) =>
      playground.runSavedCase(fork, savedCases),
    'case:export': async (id: string) => {
      if (!mainWindow) throw new Error('Desktop window is unavailable.');
      const contents = await savedCases.exportPortable(id);
      const selection = await dialog.showSaveDialog(mainWindow, {
        title: 'Export exact inference case (includes private prompts and images)',
        defaultPath: 'lonely-chat-case.json',
        filters: [{ name: 'Exact inference case', extensions: ['json'] }],
      });
      if (selection.canceled || !selection.filePath) return false;
      await writeFile(selection.filePath, contents, { mode: 0o600 });
      return true;
    },
    'case:import': async () => {
      if (!mainWindow) throw new Error('Desktop window is unavailable.');
      const choice = await dialog.showOpenDialog(mainWindow, {
        title: 'Import exact inference case',
        properties: ['openFile'],
        filters: [{ name: 'Exact inference case', extensions: ['json'] }],
      });
      if (choice.canceled || !choice.filePaths[0]) return null;
      const selected = choice.filePaths[0];
      if ((await stat(selected)).size > 96 * 1024 * 1024)
        throw new Error('Inference case archive exceeds the import size limit.');
      return savedCases.importPortable(await readFile(selected, 'utf8'));
    },
    'trace:search': (filter: import('../shared/inference-trace-contract').TraceFilter) =>
      session.trace.search(filter),
    'trace:get': (id: string) => {
      if (
        typeof id !== 'string' ||
        !/^attempt-(?:\d{1,12}|[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})$/i.test(id)
      )
        throw new Error('Invalid inference attempt ID.');
      return session.trace.get(id);
    },
    'session:snapshot': () => session.snapshot(),
    'session:start': async (
      context: string,
      mode?: import('../shared/session-contract').InferenceMode,
      options?: import('../shared/session-contract').SimulationInputOptions,
    ) => {
      if (rosterRegenerating) throw new Error('Roster regeneration is in progress.');
      if (playground.busy || speechTest.busy)
        throw new Error('Stop Playground experiments before starting Simulation.');
      if (
        sessionStarting ||
        ['running', 'starting', 'switching'].includes(session.snapshot().phase)
      )
        throw new Error('The simulation is already running.');
      sessionStarting = true;
      try {
        const recordedConfig =
          options?.inputMode === 'recorded' && options.recordedConfig
            ? validateScenarioConfig(options.recordedConfig)
            : null;
        if (recordedConfig) {
          if (mode !== recordedConfig.mode) throw new Error('Run mode does not match Scenario.');
          await verifyRecordedSources(recordedConfig);
          if (
            options?.recordedScenarioId &&
            !(await recordedScenarios.list()).some((item) => item.id === options.recordedScenarioId)
          )
            throw new Error('Selected Scenario no longer exists.');
        }
        if (options?.inputMode === 'recorded') {
          ++videoSelectionGeneration;
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('media:stop');
          session.selectVideoSource(
            (recordedConfig ? !!recordedConfig.video : options.hasVideoFile)
              ? 'recorded:video'
              : null,
          );
        } else if (options?.inputMode === 'live' || !options) {
          // The live capture producer retains ownership of its existing source.
        } else {
          throw new Error('Unknown simulation media mode.');
        }
        const profileId = recordedConfig?.profileId ?? options?.profileId;
        const profileRevision = recordedConfig?.profileRevision ?? options?.profileRevision;
        const profile = profileId
          ? await inferenceProfiles.resolve(profileId, profileRevision ?? undefined)
          : null;
        if (profile?.values.topology === 'hybrid')
          throw new Error('Hybrid execution is not yet available.');
        const unifiedRole = profile?.values.roles.unified;
        if (unifiedRole && mode !== (unifiedRole.kind === 'local' ? 'native' : 'remote'))
          throw new Error(
            'The selected Inference Profile role does not match the simulation provider.',
          );
        const presetId = recordedConfig?.presetId ?? options?.presetId;
        const presetRevision = recordedConfig?.presetRevision ?? options?.presetRevision;
        const preset = presetId
          ? (await promptPresets.revisions(presetId))
              .slice()
              .reverse()
              .find(
                (item) =>
                  presetRevision === undefined ||
                  presetRevision === null ||
                  item.revision === presetRevision,
              )
          : undefined;
        if (presetId && !preset) throw new Error('Selected prompt preset was not found.');
        const splitChat = profile?.values.topology === 'split' ? profile.values.roles.chat : null;
        if (splitChat && mode !== (splitChat.kind === 'remote' ? 'remote' : 'native'))
          throw new Error('Split Simulation provider must match its Chat role.');
        const activeModel =
          splitChat?.modelId ??
          unifiedRole?.modelId ??
          (mode === 'remote'
            ? recordedConfig?.settingsPolicy === 'saved'
              ? recordedConfig.modelId
              : (options?.remoteModelConfigurationId ?? null)
            : mode === 'native'
              ? packageE2E
                ? 'cert-worker'
                : installs.snapshot().active['vision-language']
              : null);
        if (
          !splitChat &&
          recordedConfig?.settingsPolicy === 'saved' &&
          mode === 'native' &&
          recordedConfig.modelId !== activeModel
        )
          throw new Error('Activate the model saved in this Scenario before starting the Run.');
        if (
          unifiedRole?.kind === 'local' &&
          !packageE2E &&
          installs.snapshot().active['vision-language'] !== unifiedRole.modelId
        )
          throw new Error(
            'Activate the local Model Configuration selected by this Inference Profile before starting.',
          );
        const splitRoles = profile?.values.topology === 'split' ? profile.values.roles : null;
        const localSplitModels = splitRoles
          ? [splitRoles.observer, splitRoles.chat].filter((ref) => ref?.kind === 'local')
          : [];
        if (localSplitModels.length && !localModelPool && !packageE2E)
          throw new Error('Local Split model pool is unavailable.');
        const effectivePolicy = resolveUnifiedProfilePolicy(
          profile,
          recordedConfig?.settingsPolicy === 'saved'
            ? recordedConfig.settingsSnapshot
            : session.getPreferences(),
          recordedConfig?.context ?? context,
          preset?.values,
        );
        const effectiveSettings = effectivePolicy.settings;
        if (remotePlayground.busy)
          throw new Error('Stop remote Playground before starting Simulation.');
        // Audience size is managed outside SessionController; align it with the
        // frozen Run settings before inference (without rewriting global prefs).
        if (effectiveSettings.audienceCount !== audience.snapshot().targetCount)
          await audience.setTarget(effectiveSettings.audienceCount);
        // Validation and file checks above are async: reject starts superseded by
        // another caller before mutating an already active simulation.
        if (['running', 'starting', 'switching'].includes(session.snapshot().phase))
          throw new Error('The simulation is already running.');
        const effectiveOptions = recordedConfig
          ? {
              ...options!,
              publishToOverlay: recordedConfig.publishToOverlay,
              hasVideoFile: Boolean(recordedConfig.video),
              hasAudioFiles: recordedConfig.audio.some((source) => source.enabled),
              transcriptMode: recordedConfig.transcriptMode,
              ...(recordedConfig.seed === null
                ? { seed: undefined }
                : { seed: recordedConfig.seed }),
              presetId: presetId ?? undefined,
              presetRevision: presetRevision ?? undefined,
              profileId: profile?.id,
              profileRevision: profile?.revision,
            }
          : options;
        // Playground may own an idle warm worker even though it is not busy.
        // The start reservation prevents another Playground request during this await.
        await playground.stop();
        if (localSplitModels.length && !packageE2E) {
          localWarmIdleMs = profile?.values.architecture?.warmIdleMs ?? 0;
          await localModelPool!.reserve(localSplitModels.map((ref) => ref!.modelId));
        }
        if (splitRoles) {
          // Pin the resolved provider/model configuration for this entire Run.
          const pinnedRemote = {
            observer:
              splitRoles.observer?.kind === 'remote'
                ? remoteStore.selected(splitRoles.observer.modelId)
                : null,
            chat:
              splitRoles.chat?.kind === 'remote'
                ? remoteStore.selected(splitRoles.chat.modelId)
                : null,
          };
          const make = (
            role: 'observer' | 'chat',
            input: import('./fake-inference').InferenceInput,
          ) => {
            const ref = splitRoles[role]!;
            if (ref.kind === 'local')
              return packageE2E
                ? session.createLocalSplitAdapter(input)
                : localModelPool!.adapter(ref.modelId, role, input);
            const selected = pinnedRemote[role]!;
            return selected.connection.credentialMode === 'chatgpt'
              ? chatGPTUnifiedAdapter(selected, chatGPTAuth, {
                  timeoutMs: effectiveSettings.inferenceTimeoutMs,
                  roster: input.roster ?? [],
                })
              : remoteUnifiedAdapter(selected, {
                  timeoutMs: effectiveSettings.inferenceTimeoutMs,
                  roster: input.roster,
                });
          };
          session.configureSplit(
            (input) => ({
              vision: make('observer', input),
              chat: make('chat', input),
            }),
            localSplitModels.length > 0,
            splitChat?.kind === 'local'
              ? packageE2E
                ? nativeInference
                : localModelPool!.rosterProvider(splitChat.modelId)
              : null,
          );
        }
        if (mode === 'remote' && !splitRoles) {
          if (!activeModel) throw new Error('Select a remote Model Configuration.');
          const selected = remoteStore.selected(activeModel);
          session.configureRemote((input) =>
            selected.connection.credentialMode === 'chatgpt'
              ? chatGPTUnifiedAdapter(selected, chatGPTAuth, {
                  timeoutMs: effectiveSettings.inferenceTimeoutMs,
                  roster: input.roster ?? [],
                })
              : remoteUnifiedAdapter(selected, {
                  timeoutMs: effectiveSettings.inferenceTimeoutMs,
                  roster: input.roster,
                }),
          );
        }
        const started = session.start(
          effectivePolicy.context,
          mode,
          activeModel,
          effectiveOptions,
          preset
            ? {
                id: preset.id,
                name: preset.name,
                revision: preset.revision,
                chatActivity: preset.values.chatActivity,
              }
            : undefined,
          profile || recordedConfig ? effectiveSettings : undefined,
          profile,
        );
        if (recordedConfig) {
          try {
            await pendingRecordedFinish;
            const saved = await recordedScenarios.begin({
              scenarioId: options?.recordedScenarioId ?? null,
              name: options?.recordedScenarioId
                ? ((await recordedScenarios.list()).find(
                    (item) => item.id === options.recordedScenarioId,
                  )?.name ?? 'Scenario Run')
                : 'Ad hoc recorded Run',
              sessionRunId: started.runId!,
              effective: recordedConfig,
              effectiveSettings: session.getRunPreferences(),
              effectiveProfile: profile,
              effectiveModelId: activeModel,
              effectivePreset: started.promptPreset ?? null,
              effectivePrompt: {
                context: effectivePolicy.context,
                chatActivity:
                  preset?.values.chatActivity ?? session.getRunPreferences().chatActivity,
              },
              effectiveSeed: started.sessionSeed!,
            });
            activeRecordedRun = {
              id: saved.id,
              sessionRunId: started.runId!,
              config: recordedConfig,
            };
          } catch (error) {
            stopSession();
            throw error;
          }
        }
        return started;
      } finally {
        sessionStarting = false;
      }
    },
    'session:stop': async () => {
      const result = stopSession();
      await pendingRecordedFinish;
      return result;
    },
    'session:pause': () => {
      resumeReservation.cancel();
      const state = session.pauseRecorded();
      audio.pauseRecorded();
      return state;
    },
    'session:resume:prepare': async () => {
      resumeReservation.prepare(
        session.snapshot().recordedPlayback === 'paused',
        playground.busy || speechTest.resourcesBusy,
      );
      try {
        await playground.stop();
      } catch (error) {
        resumeReservation.cancel();
        throw error;
      }
    },
    'session:resume:cancel': () => resumeReservation.cancel(),
    'session:resume': () => {
      resumeReservation.commit(playground.busy || speechTest.resourcesBusy);
      audio.resumeRecorded();
      return session.resumeRecorded();
    },
    'session:recorded:eof': () => session.finishRecorded(),
    'session:retry': async () => {
      if (playground.busy || speechTest.busy || sessionStarting)
        throw new Error('Stop Playground experiments before retrying Simulation.');
      sessionStarting = true;
      try {
        await playground.stop();
        return session.retry();
      } finally {
        sessionStarting = false;
      }
    },
    'native:status': () => nativeInference.snapshot(),
    'local-models:unload': async () => {
      if (!['stopped', 'error'].includes(session.snapshot().phase) || sessionStarting)
        throw new Error('Stop the active Simulation before unloading local models.');
      await localModelPool?.unload();
    },
    'preferences:get': () => session.getPreferences(),
    'preferences:set': async (
      preferences: import('../shared/session-contract').SessionPreferences,
    ) => {
      const next = validatePreferences(preferences);
      if (next.audienceCount !== audience.snapshot().targetCount) {
        if (
          ['starting', 'running', 'switching'].includes(session.snapshot().phase) ||
          (session.snapshot().phase === 'error' &&
            session.snapshot().failureKind !== 'recorded-video')
        ) {
          throw new Error('Stop the simulation before resizing the audience.');
        }
        if (rosterRegenerating) throw new Error('Roster regeneration is in progress.');
      }
      const written = await preferenceStore.write(next);
      if (written.audienceCount !== audience.snapshot().targetCount) {
        await audience.setTarget(written.audienceCount);
      }
      return session.setPreferences(written);
    },
    'audience:get': () => audience.snapshot(),
    'audience:regenerate': async (
      mode: import('../shared/session-contract').InferenceMode,
      seed?: number,
    ) => {
      if (!['stopped', 'error'].includes(session.snapshot().phase)) {
        throw new Error('Stop the simulation before regenerating its audience.');
      }
      if (mode !== 'fake' && mode !== 'native') throw new Error('Invalid inference mode.');
      if (rosterRegenerating) throw new Error('Roster regeneration is already in progress.');
      if (playground.busy || speechTest.busy)
        throw new Error('Stop Playground experiments before regenerating the roster.');
      rosterRegenerating = true;
      const provider = mode === 'native' ? nativeInference : new FakeInference();
      const abort = new AbortController();
      rosterGenerationAbort = abort;
      try {
        await playground.stop();
        await session.awaitShutdown();
        return await audience.ensure(provider, abort.signal, true, seed);
      } finally {
        if (mode === 'native') await nativeInference.stop();
        rosterRegenerating = false;
        rosterGenerationAbort = null;
      }
    },
    'models:discover': (source: string) => models.discover(source),
    'models:snapshot': () => installs.snapshot(),
    'models:install': (selection: import('../shared/model-install-contract').ModelInstallRequest) =>
      installs.install(selection),
    'models:projector:set': async (
      id: string,
      source: import('../shared/model-install-contract').ProjectorAssignment,
    ) => {
      if (
        playground.busy ||
        speechTest.busy ||
        rosterRegenerating ||
        speechSwitchBusy ||
        session.switchingModel ||
        session.snapshot().phase === 'switching'
      ) {
        throw new Error('Another model transition is in progress.');
      }
      await playground.stop();
      const current = session.snapshot();
      if (
        current.inferenceProfile?.topology === 'split' &&
        ['starting', 'running', 'error'].includes(current.phase)
      )
        throw new Error('Stop the Split Run before changing a pinned projector.');
      await localModelPool?.unload();
      if (
        current.mode === 'native' &&
        ['starting', 'running', 'error'].includes(current.phase) &&
        installs.snapshot().active['vision-language'] === id
      ) {
        await session.switchNativeModel(() => installs.setProjector(id, source).then(() => {}), id);
        return installs.snapshot();
      }
      return installs.setProjector(id, source);
    },
    'models:projector:install': async (id: string, source: string, candidateId: string) => {
      if (
        playground.busy ||
        speechTest.busy ||
        rosterRegenerating ||
        speechSwitchBusy ||
        session.switchingModel ||
        session.snapshot().phase === 'switching'
      ) {
        throw new Error('Another model transition is in progress.');
      }
      // Download before stopping the live worker. Only reassignment needs a worker reload.
      const projector = await installs.prepareProjector(id, source, candidateId);
      await playground.stop();
      const current = session.snapshot();
      if (
        current.inferenceProfile?.topology === 'split' &&
        ['starting', 'running', 'error'].includes(current.phase)
      )
        throw new Error('Stop the Split Run before changing a pinned projector.');
      await localModelPool?.unload();
      if (
        current.mode === 'native' &&
        ['starting', 'running', 'error'].includes(current.phase) &&
        installs.snapshot().active['vision-language'] === id
      ) {
        await session.switchNativeModel(
          () => installs.setProjector(id, projector).then(() => {}),
          id,
        );
        return installs.snapshot();
      }
      if (session.switchingModel || current.phase === 'switching') {
        throw new Error('Another model transition is in progress.');
      }
      return installs.setProjector(id, projector);
    },
    'models:cancel': () => installs.cancel(),
    'models:activate': async (
      role: import('../shared/model-contract').ModelRole,
      id: string | null,
    ) => {
      if (
        rosterRegenerating ||
        playground.busy ||
        speechTest.busy ||
        speechSwitchBusy ||
        session.switchingModel ||
        session.snapshot().phase === 'switching'
      ) {
        throw new Error('Another model transition is in progress.');
      }
      if (role !== 'vision-language' && role !== 'speech-to-text') {
        throw new Error('Invalid model role.');
      }
      const current = installs.snapshot().active[role];
      if (current === id) return installs.snapshot();
      if (role === 'vision-language') {
        if (
          session.snapshot().inferenceProfile?.topology === 'split' &&
          ['running', 'starting', 'switching', 'error'].includes(session.snapshot().phase)
        )
          throw new Error('Stop the Split Run before changing its pinned local models.');
        await playground.stop();
        await localModelPool?.unload();
      }
      if (
        role === 'vision-language' &&
        session.snapshot().mode === 'native' &&
        ['running', 'starting', 'error'].includes(session.snapshot().phase)
      ) {
        if (!id) throw new Error('Select a replacement VLM before deactivating the running model.');
        await session.switchNativeModel(async () => {
          await installs.setActive(role, id);
        }, id);
        return installs.snapshot();
      }
      if (
        role === 'speech-to-text' &&
        session.snapshot().inputMode === 'recorded' &&
        session.snapshot().transcriptMode === 'cached' &&
        allowsRecordedSessionMedia(session.snapshot())
      )
        throw new Error('Stop cached transcript playback before changing the speech model.');
      if (
        role === 'speech-to-text' &&
        audio
          .snapshot()
          .sources.some((source) => source.phase !== 'off' && source.phase !== 'disconnected')
      ) {
        if (!id)
          throw new Error('Select a replacement speech model before deactivating active audio.');
        speechSwitchBusy = true;
        try {
          await audio.reloadWorkers(async () => {
            await installs.setActive(role, id);
          });
          return installs.snapshot();
        } finally {
          speechSwitchBusy = false;
        }
      }
      return installs.setActive(role, id);
    },
    'models:remove': async (id: string) => {
      if (
        rosterRegenerating ||
        playground.busy ||
        speechTest.busy ||
        speechSwitchBusy ||
        session.switchingModel ||
        session.snapshot().phase === 'switching' ||
        session.snapshot().phase === 'running' ||
        session.snapshot().phase === 'starting'
      ) {
        throw new Error('Stop roster generation and simulation before removing a model.');
      }
      if (
        audio
          .snapshot()
          .sources.some((source) => source.phase === 'ready' || source.phase === 'starting') &&
        installs
          .snapshot()
          .installations.some((item) => item.id === id && item.role === 'speech-to-text')
      ) {
        throw new Error('Stop audio capture before removing a speech model.');
      }
      await session.awaitShutdown();
      await playground.stop();
      await localModelPool?.unload();
      return installs.remove(id);
    },
    'video:clock': () => observationNow(),
    'session:media-error': (message: string) => {
      // Older renderer clients may still report video errors by message.
      if (typeof message !== 'string' || !message.trim() || message.length > 500)
        throw new Error('Invalid recorded video decoder error.');
      const state = session.snapshot();
      logger.error('media', 'Recorded video decoder failed', undefined, {
        runId: state.runId,
        recordedRunId: activeRecordedRun?.id,
        sourceId: 'recorded:video',
      });
      return sessionMedia!.failRecordedVideo(message);
    },
    'session:media-issue': (issue: import('../shared/recorded-media-health').RecordedMediaIssue) =>
      reportRecordedMediaIssue(issue, activeRecordedRun, session.snapshot(), sessionMedia!, logger),
    'video:list-displays': async () =>
      (await listDesktopSources()).map((source) => ({
        id: `display:${source.id}`,
        label: source.name,
        kind: source.id.startsWith('screen:') ? ('screen' as const) : ('window' as const),
      })),
    'video:select': async (sourceId: string | null) => {
      if (
        session.snapshot().inputMode === 'recorded' &&
        ['starting', 'running', 'switching'].includes(session.snapshot().phase)
      )
        throw new Error('Live capture is disabled during a recorded simulation.');
      if (
        sourceId !== null &&
        (typeof sourceId !== 'string' ||
          sourceId.length > 250 ||
          (!sourceId.startsWith('display:') && !/^camera:[^\s]{1,180}$/.test(sourceId)))
      ) {
        throw new Error('Invalid video source.');
      }
      const generation = ++videoSelectionGeneration;
      let source: Electron.DesktopCapturerSource | null = null;
      if (sourceId?.startsWith('display:')) {
        source =
          (await listDesktopSources()).find((item) => `display:${item.id}` === sourceId) ?? null;
      }
      // Enumeration can finish after the user has already disabled/switched the input.
      if (generation !== videoSelectionGeneration) return observationNow();
      // Disabling capture clears the frame ring without discarding the chosen desktop
      // source. Chromium needs it armed before the next user-gesture capture request.
      if (sourceId !== null) selectedDisplaySource = source;
      session.selectVideoSource(
        source ? sourceId : sourceId?.startsWith('camera:') ? sourceId : null,
      );
      if (sourceId?.startsWith('display:') && !source) {
        throw new Error('The selected screen or window is no longer available.');
      }
      return observationNow();
    },
    'video:frame': (frame: import('../shared/video-contract').VideoFrame) =>
      sessionMedia!.recordVideoFrame(frame),
    'audio:configuration:get': () => audioConfig.read(),
    'audio:configuration:set': (
      inputs: import('../shared/audio-contract').AudioInputConfiguration[],
    ) => audioConfig.write(inputs),
    'audio:status': () => audio.snapshot(),
    'audio:capabilities': () => ({ windowsLoopback: process.platform === 'win32' }),
    'audio:start': (id: string, sourceId: string, label: string, captureId: string) =>
      audio.start(id, sourceId, label, captureId),
    'audio:retry': (id: string) => audio.retry(id),
    'audio:label': (id: string, label: string) => audio.changeLabel(id, label),
    'audio:disconnected': (captureId: string) => audio.disconnected(captureId),
    'audio:remove': (id: string) => audio.remove(id),
    'audio:stop': (captureId: string) => audio.stop(captureId),
    'audio:segment': (
      segment: import('../shared/audio-contract').AudioSegment,
      captureId: string,
    ) => audio.submit(segment, captureId),
    'audio:cache:check': (
      query: import('../shared/recorded-transcript-cache').TranscriptCacheQuery,
    ) => {
      const speechModel = installs.snapshot().active['speech-to-text'];
      if (!speechModel) return { available: false, reason: 'unavailable' as const, count: 0 };
      return transcriptCache.check(validateTranscriptCacheQuery(query), speechModel);
    },
    'audio:recorded:start': (source: import('../shared/audio-contract').RecordedAudioStart) => {
      requireRecordedAudio();
      if (
        (source?.cache?.mode ?? 'transcribe') !==
        (session.snapshot().transcriptMode ?? 'transcribe')
      )
        throw new Error('Recorded audio transcription mode does not match this Run.');
      return audio.startRecorded(source);
    },
    'audio:recorded:arm': (captureId: string, originMs: number, mediaStartMs: number) => {
      requireRecordedAudio();
      audio.armRecorded(captureId, originMs, mediaStartMs);
    },
    'audio:recorded:resync': (captureId: string, originMs: number, mediaStartMs: number) => {
      requireRecordedAudio();
      audio.resyncRecorded(captureId, originMs, mediaStartMs);
    },
    'audio:recorded:pcm': (samples: Float32Array, captureId: string) => {
      requireRecordedAudio();
      audio.pushRecorded(samples, captureId);
    },
    'audio:recorded:finish': (captureId: string) => {
      requireRecordedAudio();
      return audio.finishRecorded(captureId);
    },
    'models:choose-directory': async () => {
      if (playground.busy || speechTest.busy)
        throw new Error('Stop Playground experiments before changing model storage.');
      if (!mainWindow) throw new Error('Desktop window is unavailable.');
      const choice = await dialog.showOpenDialog(mainWindow, {
        title: 'Select model storage directory',
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: installs.snapshot().storageDirectory,
      });
      if (choice.canceled || !choice.filePaths[0]) return installs.snapshot();
      await playground.stop();
      return installs.changeDirectory(choice.filePaths[0]);
    },
  } satisfies {
    [K in keyof DesktopInvocations]: (
      ...args: DesktopArguments[K]
    ) => DesktopInvocations[K] | Promise<DesktopInvocations[K]>;
  };
  for (const channel of Object.keys(actions) as Array<keyof DesktopInvocations>) {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      requireDesktop(event);
      try {
        // Channel-specific input validation occurs in the owning service/store.
        return await (actions[channel] as (...values: unknown[]) => unknown)(...args);
      } catch (error) {
        // Never log renderer-provided arguments or raw provider replies.
        logger.error('ipc', 'Desktop operation failed', error, { operation: channel });
        throw error;
      }
    });
  }
}

function openMainWindow(): void {
  const window = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 720,
    minHeight: 520,
    title: 'Lonely Chat',
    backgroundColor: '#101015',
    webPreferences: {
      preload: preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      // Keep live and recorded video sampling independent of window visibility.
      backgroundThrottling: false,
    },
  });
  mainWindow = window;
  lifecycle.attach(window);
  window.webContents.session.setPermissionRequestHandler((contents, permission, callback) => {
    callback(
      contents === window.webContents &&
        (permission === 'media' || permission === 'display-capture'),
    );
  });
  window.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
    if (request.frame !== window.webContents.mainFrame) {
      callback(null);
      return;
    }
    if (request.audioRequested && process.platform === 'win32') {
      void listDesktopSources()
        .then((sources) => {
          const screen = sources.find((source) => source.id.startsWith('screen:'));
          if (screen) callback({ video: screen, audio: 'loopback' });
          else callback(null);
        })
        .catch(() => callback(null));
      return;
    }
    callback(selectedDisplaySource ? { video: selectedDisplaySource } : null);
  });
  window.webContents.setBackgroundThrottling(false);
  window.webContents.on('render-process-gone', (_event, details) => {
    logger.error('renderer', 'Desktop renderer exited unexpectedly', new Error(details.reason), {
      code: details.exitCode,
      reason: details.reason,
    });
  });
  window.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (isMainFrame && code !== -3)
      logger.error('renderer', 'Desktop page failed to load', new Error(description), { code });
  });
  logger.info('window', 'Desktop window created');
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url === overlay.snapshot().url) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!trustedDesktopURL(url, path.join(rendererDirectory, 'index.html'), devOrigin)) {
      event.preventDefault();
    }
  });
  if (packageE2E) {
    installPackagedE2E(window, {
      chat,
      session,
      compact: compactRecorder,
      cases: savedCases,
      scenarios: recordedScenarios,
      logger,
    });
  } else if (process.env.LONELY_CHAT_SMOKE === '1') {
    installElectronSmoke(window, { chat, session, overlay, floating, lifecycle });
  }
  if (devOrigin) void window.loadURL(devOrigin);
  else void window.loadFile(path.join(rendererDirectory, 'index.html'));
}

async function boot(): Promise<void> {
  await speechCapture.load();
  speechCapture.subscribe((status) => {
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('speech-capture:change', status);
  });
  protocol.handle(MEDIA_SCHEME, (request) => recordedMediaAccess.serve(request));
  try {
    windowPrefs = await windowStore.read();
  } catch (error) {
    logger.error('preferences', 'Invalid window preferences; using safe defaults', error);
    windowPrefs = DEFAULT_WINDOW_PREFERENCES;
  }
  floating.configure(windowPrefs.floating);
  lifecycle.initialize(windowPrefs.closeToTray);
  let preferences = DEFAULT_PREFERENCES;
  try {
    preferences = await preferenceStore.read();
  } catch (error) {
    logger.error('preferences', 'Invalid local preferences; using safe defaults', error);
  }
  await credentialPolicy.load();
  await remoteStore.load();
  await chatGPTAuth.load();
  await installs.open();
  audience = new AudienceService(app.getPath('userData'), preferences.audienceCount);
  await audience.open();
  audience.subscribe((status) => {
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('audience:change', status);
  });
  installs.subscribe((snapshot) => {
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('models:change', snapshot);
  });
  const buildNative = (
    resolveModel: () => Promise<{ modelPath: string; projectorPath: string | null }>,
    settings: () => import('../shared/session-contract').SessionPreferences,
    videoOptions?: import('../shared/video-tools-contract').NativeVideoPreferences,
    forbidCpuFallback = false,
  ) =>
    new NativeInference({
      executable: bundledLlamaServer(app.getAppPath(), app.isPackaged, process.resourcesPath),
      gpuExecutables: {
        cuda: bundledAcceleratedLlamaServer(
          app.getAppPath(),
          app.isPackaged,
          process.resourcesPath,
          'cuda',
        ),
        vulkan: bundledAcceleratedLlamaServer(
          app.getAppPath(),
          app.isPackaged,
          process.resourcesPath,
          'vulkan',
        ),
      },
      resolveModel,
      reasoningEnabled: () => settings().reasoningEnabled,
      inferenceTimeoutMs: () => settings().inferenceTimeoutMs,
      resourcePreferences: settings,
      forbidCpuFallback,
      videoFfmpegDir: () => videoTools.directory,
      videoPreferences: videoOptions,
      resolveVideo: (token, preferences) => videoTools.encoded(token, preferences),
      log: logger,
      privateWorkerLine: (worker, stream, line) =>
        diagnostics.recordWorkerLine(worker, stream, line),
    });
  nativeInference = buildNative(
    () => installs.activeVisionFiles(),
    nativeWorkerSettings(session, 'simulation'),
  );
  localModelPool = new (await import('./local-model-pool')).LocalModelPool({
    files: (id) => installs.visionFiles(id),
    create: (id) =>
      buildNative(
        () => installs.visionFiles(id),
        nativeWorkerSettings(session, 'simulation'),
        undefined,
        true,
      ),
    ramBudgetMiB: () => session.getPreferences().ramBudgetMiB,
    vramBudgetMiB: () => session.getPreferences().vramBudgetMiB,
    computeBackend: () => session.getPreferences().computeBackend,
    timeoutMs: () => session.getPreferences().inferenceTimeoutMs,
    warmIdleMs: () => localWarmIdleMs,
  });
  await videoTools.open();
  playground = new PlaygroundService(
    () =>
      !quitting &&
      !resumeReservation.reserved &&
      !sessionStarting &&
      !rosterRegenerating &&
      !speechSwitchBusy &&
      !speechTest?.busy &&
      !session.switchingModel &&
      (['stopped', 'error'].includes(session.snapshot().phase) ||
        session.canExecutePausedPlayground()) &&
      installs.snapshot().progress.phase === 'idle',
    (id, needsVision, videoOptions, imageMaxTokens) => {
      if (packageE2E) return certificationPlaygroundProvider();
      // Playground workers own a fresh immutable snapshot, never the previous Run's settings.
      const playgroundSettings = nativeWorkerSettings(session, 'playground');
      return buildNative(
        async () => {
          const files = await installs.visionFiles(id);
          if (needsVision && !files.projectorPath)
            throw new Error(
              'Selected model has no installed vision projector. Install a matching projector or remove selected frames.',
            );
          return {
            modelPath: files.modelPath,
            projectorPath: needsVision ? files.projectorPath : null,
          };
        },
        imageMaxTokens === undefined
          ? playgroundSettings
          : () => ({ ...playgroundSettings(), imageMaxTokens }),
        videoOptions,
      );
    },
    () => session.preparePausedPlayground(),
    () => session.getPreferences(),
    (modelId) => {
      const registry = installs.snapshot();
      const model = registry.installations.find((item) => item.id === modelId);
      const assigned = registry.projectorAssignments?.[modelId] ?? model?.projectorId;
      return JSON.stringify({
        settings: session.getPreferences(),
        storageDirectory: registry.storageDirectory,
        model,
        assigned,
        projector: registry.installations.find((item) => item.id === assigned),
      });
    },
    undefined,
    () => videoTools.preferences,
  );
  speechTest = new SpeechPlaygroundService(
    () =>
      new NativeSpeech({
        executable: bundledWhisperWorker(app.getAppPath(), app.isPackaged, process.resourcesPath),
        resolveModel: () => installs.activeSpeechFile(),
        reportError,
        log: logger,
        privateWorkerLine: (worker, stream, line) =>
          diagnostics.recordWorkerLine(worker, stream, line),
      }),
    () =>
      !quitting &&
      !resumeReservation.reserved &&
      !playground.busy &&
      !rosterRegenerating &&
      !speechSwitchBusy &&
      !session.switchingModel &&
      (['stopped', 'error'].includes(session.snapshot().phase) ||
        canStartPausedSpeech(session.canExecutePausedPlayground(), audio.snapshot())) &&
      installs.snapshot().progress.phase === 'idle',
    undefined,
    speechCapture,
  );
  speechTest.subscribe((status) => {
    if (status.phase === 'error' && status.error)
      logger.error('whisper', 'Speech Playground worker failed', new Error(status.error));
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('speech-test:change', status);
  });
  playground.subscribe((status) => {
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('playground:status-change', status);
  });
  let previousNativePhase = '';
  nativeInference.subscribe((status) => {
    if (status.phase !== previousNativePhase) {
      previousNativePhase = status.phase;
      if (status.phase === 'failed' && status.error)
        logger.error('llama.cpp', 'Inference worker failed', new Error(status.error));
      else logger.info('llama.cpp', 'Inference worker phase changed', { phase: status.phase });
    }
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('native:change', status);
  });
  session = new SessionController(
    chat,
    undefined,
    undefined,
    preferences,
    packageE2E ? certificationSessionInferenceProvider() : nativeInference,
    audience,
    diagnostics,
    reportError,
  );
  session.trace.attachRecorder(compactRecorder);
  await compactRecorder.loadLimits();
  audio = new AudioService(
    () =>
      packageE2E
        ? (new CertificationSpeechWorker() as unknown as NativeSpeech)
        : new NativeSpeech({
            executable: bundledWhisperWorker(
              app.getAppPath(),
              app.isPackaged,
              process.resourcesPath,
            ),
            resolveModel: () => installs.activeSpeechFile(),
            reportError,
            log: logger,
            privateWorkerLine: (worker, stream, line) =>
              diagnostics.recordWorkerLine(worker, stream, line),
          }),
    (entry) => sessionMedia?.recordTranscript(entry),
    undefined,
    undefined,
    reportError,
    transcriptCache,
    () => installs.snapshot().active['speech-to-text'],
    speechCapture,
  );
  sessionMedia = new SessionMedia(session, audio, () => {
    ++videoSelectionGeneration;
    // Keep the display selection armed for the next explicit Start video click.
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('media:stop');
  });
  let previousAudioPhase = '';
  audio.subscribe((status) => {
    const phase = status.sources.map((source) => source.phase).join(',');
    if (phase !== previousAudioPhase) {
      previousAudioPhase = phase;
      const failures = status.sources.filter((source) => source.phase === 'error' && source.error);
      for (const source of failures)
        logger.error('whisper', 'Speech source failed', new Error(source.error!));
      logger.info('whisper', 'Audio source state changed', { phase });
    }
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('audio:change', status);
  });
  let previousSessionPhase = '';
  session.subscribe((status) => {
    if (
      activeRecordedRun &&
      status.runId === activeRecordedRun.sessionRunId &&
      (status.phase === 'stopped' ||
        (status.phase === 'error' &&
          (status.failureKind === 'recorded-video' || status.failureKind === 'recorded-media')))
    ) {
      const completed = activeRecordedRun;
      activeRecordedRun = null;
      const outcome: RecordedRun['status'] =
        status.failureKind === 'recorded-video' || status.failureKind === 'recorded-media'
          ? 'failed'
          : status.recordedPlayback === 'completed'
            ? 'completed'
            : 'stopped';
      pendingRecordedFinish = recordedScenarios
        .finish(
          completed.id,
          outcome,
          status.cycle,
          status.error,
          compactRecorder.takeRunRecordingIds(completed.sessionRunId),
        )
        .catch((error: unknown) =>
          logger.error('scenario', 'Unable to finalize recorded Run', error),
        );
    }
    if (status.phase !== previousSessionPhase) {
      if (status.phase === 'error') void localModelPool?.unload();
      else if (status.phase === 'stopped') void localModelPool?.release();
      previousSessionPhase = status.phase;
      if (status.phase === 'error') logger.error('session', 'Simulation entered error state');
      else logger.info('session', 'Simulation phase changed', { phase: status.phase });
    }
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('session:change', status);
    lifecycle.refreshTray();
  });
  registerHandlers();
  session.trace.subscribe((traces) => {
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('trace:change', traces);
  });
  logger.subscribe((entry) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('logs:entry', entry);
  });
  floating.subscribe((state) => {
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('floating:change', state);
    const old = windowPrefs.floating;
    const next = state.settings;
    if (
      old.width !== next.width ||
      old.height !== next.height ||
      old.transparent !== next.transparent ||
      old.decorated !== next.decorated ||
      old.alwaysOnTop !== next.alwaysOnTop
    ) {
      windowPrefs = { ...windowPrefs, floating: next };
      scheduleWindowSave();
    }
  });
  chat.subscribe((event: ChatEvent) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('chat:event', event);
  });
  publishSample(chat);
  overlay.subscribe((status) => {
    if (status.error)
      logger.error('overlay', 'Overlay server unavailable', new Error(status.error));
    else if (status.url) logger.info('overlay', 'Overlay server listening', { port: status.port });
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('overlay:change', status);
  });
  const overlayStatus = await overlay.initialize(process.env.LONELY_CHAT_OVERLAY_PORT);
  if (!overlayStatus.url) logger.warn('overlay', 'Overlay server did not start');
  openMainWindow();
}

app
  .whenReady()
  .then(async () => {
    await logReady;
    logger.info('application', 'Electron ready; initializing desktop services');
    await boot();
    logger.info('application', 'Desktop startup complete');
  })
  .catch((error: unknown) => {
    logger.error('application', 'Unable to start Lonely Chat', error);
    app.quit();
  });
app.on('activate', () => {
  logger.info('application', 'Application activated');
  if (!quitting) lifecycle.show();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
const shutdown = new ManagedShutdown(
  () => {
    stopSession();
    remotePlayground.stop();
  },
  () => {
    installs.cancel();
    rosterGenerationAbort?.abort();
  },
  () => {
    floating.close();
  },
  [
    () => session?.terminate() ?? Promise.resolve(),
    () => audio?.terminate() ?? Promise.resolve(),
    () => nativeInference?.stop() ?? Promise.resolve(),
    () => localModelPool?.unload() ?? Promise.resolve(),
    () => playground?.stop() ?? Promise.resolve(),
    () => speechTest?.stop().then(() => {}) ?? Promise.resolve(),
    () => overlay.stop(),
    () => flushWindowSave(),
    () => pendingRecordedFinish,
  ],
  (error) => logger.error('application', 'Managed shutdown failed', error),
);

app.on('before-quit', (event) => {
  if (teardownComplete) return;
  event.preventDefault();
  if (quitting) return; // repeated Quit must not bypass async worker teardown
  quitting = true;
  logger.info('application', 'Application shutdown requested');
  lifecycle.beginShutdown();
  void shutdown.stop().then(async () => {
    // All captured attempts are cancelled/completed before we drain the recorder.
    await compactRecorder.flush();
    await speechCapture.flush();
    // ManagedShutdown runs services concurrently. Close logs afterward so late
    // worker/shutdown failures cannot be dropped by an already-closed logger.
    try {
      await logger.close();
    } catch (error) {
      process.stderr.write('Unable to finalize operational logs: ' + String(error) + '\n');
    }
    teardownComplete = true;
    app.quit();
  });
});
app.on('will-quit', () => {
  for (const channel of [
    'chatgpt:status',
    'chatgpt:persistence:set',
    'chatgpt:signin',
    'chatgpt:authorization:get',
    'chatgpt:authorization:open',
    'chatgpt:authorization:copy',
    'chatgpt:select',
    'chatgpt:signout',
    'chatgpt:models',
    'profiles:list',
    'profiles:revisions',
    'profiles:save',
    'profiles:delete',
    'remote:list',
    'remote:connection:save',
    'remote:connection:delete',
    'remote:model:save',
    'remote:model:delete',
    'remote:credential:set',
    'remote:models:list',
    'remote:model:probe',
    'remote:model:inspect',
    'remote:playground:unified',
  ])
    ipcMain.removeHandler(channel);
  ipcMain.removeHandler('playground:status');
  ipcMain.removeHandler('video-tools:status');
  ipcMain.removeHandler('video-tools:choose-directory');
  ipcMain.removeHandler('video-tools:reset');
  ipcMain.removeHandler('video-tools:preferences');
  ipcMain.removeHandler('playground:video:choose');
  ipcMain.removeHandler('playground:run');
  ipcMain.removeHandler('playground:simulation:preview');
  ipcMain.removeHandler('profiles:preview-stages');
  ipcMain.removeHandler('playground:simulation:run');
  ipcMain.removeHandler('speech-test:status');
  ipcMain.removeHandler('speech-test:start');
  ipcMain.removeHandler('speech-test:pcm');
  ipcMain.removeHandler('speech-test:finish');
  ipcMain.removeHandler('speech-test:stop');
  ipcMain.removeHandler('speech-test:rerun-captured');
  for (const channel of [
    'speech-capture:get',
    'speech-capture:configure',
    'speech-capture:delete',
    'speech-capture:clear',
    'speech-capture:export',
  ])
    ipcMain.removeHandler(channel);
  ipcMain.removeHandler('logs:get');
  ipcMain.removeHandler('logs:configure');
  ipcMain.removeHandler('logs:export');
  ipcMain.removeHandler('renderer:report-failure');
  ipcMain.removeHandler('diagnostics:get');
  ipcMain.removeHandler('diagnostics:worker-lines');
  ipcMain.removeHandler('diagnostics:configure');
  ipcMain.removeHandler('diagnostics:export');
  ipcMain.removeHandler('chat:snapshot');
  ipcMain.removeHandler('chat:sample');
  ipcMain.removeHandler('overlay:url');
  ipcMain.removeHandler('overlay:status');
  ipcMain.removeHandler('overlay:configure');
  ipcMain.removeHandler('floating:get');
  ipcMain.removeHandler('floating:open');
  ipcMain.removeHandler('floating:close');
  ipcMain.removeHandler('floating:configure');
  ipcMain.removeHandler('window:get');
  ipcMain.removeHandler('window:set-close-to-tray');
  for (const channel of [
    'compact:get',
    'compact:configure',
    'compact:limits',
    'compact:list',
    'compact:reconstruct',
    'compact:save-case',
  ])
    ipcMain.removeHandler(channel);
  ipcMain.removeHandler('trace:list');
  ipcMain.removeHandler('trace:get');
  ipcMain.removeHandler('trace:search');
  for (const channel of [
    'scenario:list',
    'scenario:save',
    'scenario:delete',
    'scenario:runs',
    'scenario:export',
    'scenario:import',
    'run:export',
    'run:import',
    'recorded:media:open',
    'recorded:media:choose',
    'recorded:media:fingerprint',
  ])
    ipcMain.removeHandler(channel);
  protocol.unhandle(MEDIA_SCHEME);
  for (const channel of [
    'case:list',
    'case:get',
    'case:save',
    'case:run',
    'case:import',
    'case:export',
  ])
    ipcMain.removeHandler(channel);
  ipcMain.removeHandler('session:snapshot');
  ipcMain.removeHandler('session:start');
  ipcMain.removeHandler('session:stop');
  ipcMain.removeHandler('session:pause');
  ipcMain.removeHandler('session:resume:prepare');
  ipcMain.removeHandler('session:resume:cancel');
  ipcMain.removeHandler('session:resume');
  ipcMain.removeHandler('session:recorded:eof');
  ipcMain.removeHandler('session:retry');
  ipcMain.removeHandler('native:status');
  ipcMain.removeHandler('local-models:unload');
  ipcMain.removeHandler('preferences:get');
  ipcMain.removeHandler('preferences:set');
  ipcMain.removeHandler('audience:get');
  ipcMain.removeHandler('audience:regenerate');
  ipcMain.removeHandler('models:discover');
  ipcMain.removeHandler('models:snapshot');
  ipcMain.removeHandler('models:install');
  ipcMain.removeHandler('models:projector:set');
  ipcMain.removeHandler('models:projector:install');
  ipcMain.removeHandler('models:cancel');
  ipcMain.removeHandler('models:activate');
  ipcMain.removeHandler('models:remove');
  ipcMain.removeHandler('models:choose-directory');
  ipcMain.removeHandler('video:clock');
  ipcMain.removeHandler('session:media-error');
  ipcMain.removeHandler('session:media-issue');
  ipcMain.removeHandler('video:list-displays');
  ipcMain.removeHandler('video:select');
  ipcMain.removeHandler('video:frame');
  ipcMain.removeHandler('audio:configuration:get');
  ipcMain.removeHandler('audio:configuration:set');
  ipcMain.removeHandler('audio:status');
  ipcMain.removeHandler('audio:capabilities');
  ipcMain.removeHandler('audio:start');
  ipcMain.removeHandler('audio:retry');
  ipcMain.removeHandler('audio:label');
  ipcMain.removeHandler('audio:disconnected');
  ipcMain.removeHandler('audio:remove');
  ipcMain.removeHandler('audio:stop');
  ipcMain.removeHandler('audio:segment');
  ipcMain.removeHandler('audio:cache:check');
  ipcMain.removeHandler('audio:recorded:start');
  ipcMain.removeHandler('audio:recorded:arm');
  ipcMain.removeHandler('audio:recorded:resync');
  ipcMain.removeHandler('audio:recorded:pcm');
  ipcMain.removeHandler('audio:recorded:finish');
});
