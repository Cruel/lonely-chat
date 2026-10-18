import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { DiagnosticCapture } from './diagnostic-capture';
import { OperationalLogger } from './operational-logger';
import { serializeOperationalLogs } from './operational-log-export';
import { validateRendererFailure } from '../shared/renderer-log-contract';
import { PlaygroundService } from './playground-service';
import { SpeechPlaygroundService } from './speech-playground-service';
import { installElectronSmoke } from './electron-smoke';
import { observationNow } from '../shared/observation-clock';
import { pathToFileURL } from 'node:url';
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
} from 'electron';
import { ChatService, publishSample } from './chat-service';
import { SessionController } from './session-controller';
import { SessionMedia } from './session-media';
import { PreferencesStore } from './preferences-store';
import { DEFAULT_PREFERENCES, validatePreferences } from '../shared/session-contract';
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
import {
  bundledAcceleratedLlamaServer,
  bundledLlamaServer,
  bundledWhisperWorker,
} from './native-runtime-path';
import { NativeSpeech } from './native-speech';
import { AudioService } from './audio-service';
import { AudioConfigStore } from './audio-config-store';
import type { ChatEvent, DesktopInvocations, DesktopArguments } from '../shared/chat-contract';

const rendererDirectory = path.join(__dirname, '../renderer');
const preloadPath = path.join(__dirname, '../preload/preload.cjs');
const devOrigin = process.env.LONELY_CHAT_RENDERER_URL;
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
const audioConfig = new AudioConfigStore(app.getPath('userData'));
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
let session: SessionController;
let audience: AudienceService;
let nativeInference: NativeInference;
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

/** Both desktop and tray Stop retire every producer, not only the VLM. */
function stopSession() {
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
  const url = event.senderFrame.url;
  if (devOrigin) return url === devOrigin || url === `${devOrigin}/`;
  return url === pathToFileURL(path.join(rendererDirectory, 'index.html')).href;
}

function requireDesktop(event: Electron.IpcMainInvokeEvent): void {
  if (!trustedSender(event)) throw new Error('Unauthorized desktop IPC sender');
}

function registerHandlers(): void {
  const actions = {
    'playground:status': () => playground.snapshot(),
    'playground:run': (request: import('../shared/playground-contract').FreeformRequest) =>
      playground.run(request),
    'playground:simulation:preview': (
      request: import('../shared/playground-contract').SimulationExperimentRequest,
    ) => playground.previewSimulation(request),
    'playground:simulation:run': (
      request: import('../shared/playground-contract').SimulationExperimentRequest,
    ) => playground.runSimulation(request),
    'speech-test:status': () => speechTest.snapshot(),
    'speech-test:start': (config: import('../shared/speech-playground-contract').SpeechTestStart) =>
      speechTest.start(config),
    'speech-test:pcm': (samples: Float32Array, backpressure?: boolean) =>
      speechTest.push(samples, backpressure),
    'speech-test:finish': () => speechTest.finish(),
    'speech-test:stop': () => speechTest.stop(),
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
    'diagnostics:get': () => diagnostics.status(),
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
    'session:snapshot': () => session.snapshot(),
    'session:start': (
      context: string,
      mode?: import('../shared/session-contract').InferenceMode,
      options?: import('../shared/session-contract').SimulationInputOptions,
    ) => {
      if (rosterRegenerating) throw new Error('Roster regeneration is in progress.');
      if (playground.busy || speechTest.busy)
        throw new Error('Stop Playground experiments before starting Simulation.');
      if (options?.inputMode === 'recorded') {
        ++videoSelectionGeneration;
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('media:stop');
        session.selectVideoSource(options.hasVideoFile ? 'recorded:video' : null);
      } else if (options?.inputMode === 'live' || !options) {
        // The live capture producer retains ownership of its existing source.
      } else {
        throw new Error('Unknown simulation media mode.');
      }
      return session.start(
        context,
        mode,
        mode === 'native' ? installs.snapshot().active['vision-language'] : null,
        options,
      );
    },
    'session:stop': () => stopSession(),
    'session:retry': () => {
      if (playground.busy || speechTest.busy)
        throw new Error('Stop Playground experiments before retrying Simulation.');
      return session.retry();
    },
    'native:status': () => nativeInference.snapshot(),
    'preferences:get': () => session.getPreferences(),
    'preferences:set': async (
      preferences: import('../shared/session-contract').SessionPreferences,
    ) => {
      const next = validatePreferences(preferences);
      if (next.audienceCount !== session.getPreferences().audienceCount) {
        if (['starting', 'running', 'switching'].includes(session.snapshot().phase)) {
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
      return installs.remove(id);
    },
    'video:clock': () => observationNow(),
    'session:media-error': (message: string) => {
      const result = sessionMedia!.failRecordedVideo(message);
      logger.error('media', 'Recorded video decoding failed', new Error(message));
      return result;
    },
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
    const expected = devOrigin ?? pathToFileURL(path.join(rendererDirectory, 'index.html')).href;
    if (url !== expected && url !== `${expected}/`) event.preventDefault();
  });
  if (process.env.LONELY_CHAT_SMOKE === '1') {
    installElectronSmoke(window, { chat, session, overlay, floating, lifecycle });
  }
  if (devOrigin) void window.loadURL(devOrigin);
  else void window.loadFile(path.join(rendererDirectory, 'index.html'));
}

async function boot(): Promise<void> {
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
      reasoningEnabled: () => session.getPreferences().reasoningEnabled,
      inferenceTimeoutMs: () => session.getPreferences().inferenceTimeoutMs,
      resourcePreferences: () => session.getPreferences(),
      log: logger,
      privateWorkerLine: (worker, stream, line) =>
        diagnostics.recordWorkerLine(worker, stream, line),
    });
  nativeInference = buildNative(() => installs.activeVisionFiles());
  playground = new PlaygroundService(
    () =>
      !quitting &&
      !rosterRegenerating &&
      !speechSwitchBusy &&
      !speechTest?.busy &&
      !session.switchingModel &&
      ['stopped', 'error'].includes(session.snapshot().phase) &&
      installs.snapshot().progress.phase === 'idle',
    (id, needsVision) =>
      buildNative(async () => {
        const files = await installs.visionFiles(id);
        if (needsVision && !files.projectorPath)
          throw new Error(
            'Selected model has no installed vision projector. Install a matching projector or remove selected frames.',
          );
        return {
          modelPath: files.modelPath,
          projectorPath: needsVision ? files.projectorPath : null,
        };
      }),
    () => session.awaitShutdown(),
    () => session.getPreferences(),
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
      !playground.busy &&
      !rosterRegenerating &&
      !speechSwitchBusy &&
      !session.switchingModel &&
      ['stopped', 'error'].includes(session.snapshot().phase) &&
      installs.snapshot().progress.phase === 'idle',
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
    nativeInference,
    audience,
    diagnostics,
    reportError,
  );
  audio = new AudioService(
    () =>
      new NativeSpeech({
        executable: bundledWhisperWorker(app.getAppPath(), app.isPackaged, process.resourcesPath),
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
    if (status.phase !== previousSessionPhase) {
      previousSessionPhase = status.phase;
      if (status.phase === 'error') logger.error('session', 'Simulation entered error state');
      else logger.info('session', 'Simulation phase changed', { phase: status.phase });
    }
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('session:change', status);
    lifecycle.refreshTray();
  });
  registerHandlers();
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
    () => playground?.stop() ?? Promise.resolve(),
    () => speechTest?.stop().then(() => {}) ?? Promise.resolve(),
    () => overlay.stop(),
    () => flushWindowSave(),
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
  ipcMain.removeHandler('playground:status');
  ipcMain.removeHandler('playground:run');
  ipcMain.removeHandler('playground:simulation:preview');
  ipcMain.removeHandler('playground:simulation:run');
  ipcMain.removeHandler('speech-test:status');
  ipcMain.removeHandler('speech-test:start');
  ipcMain.removeHandler('speech-test:pcm');
  ipcMain.removeHandler('speech-test:finish');
  ipcMain.removeHandler('speech-test:stop');
  ipcMain.removeHandler('logs:get');
  ipcMain.removeHandler('logs:configure');
  ipcMain.removeHandler('logs:export');
  ipcMain.removeHandler('renderer:report-failure');
  ipcMain.removeHandler('diagnostics:get');
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
  ipcMain.removeHandler('session:snapshot');
  ipcMain.removeHandler('session:start');
  ipcMain.removeHandler('session:stop');
  ipcMain.removeHandler('session:retry');
  ipcMain.removeHandler('native:status');
  ipcMain.removeHandler('preferences:get');
  ipcMain.removeHandler('preferences:set');
  ipcMain.removeHandler('audience:get');
  ipcMain.removeHandler('audience:regenerate');
  ipcMain.removeHandler('models:discover');
  ipcMain.removeHandler('models:snapshot');
  ipcMain.removeHandler('models:install');
  ipcMain.removeHandler('models:cancel');
  ipcMain.removeHandler('models:activate');
  ipcMain.removeHandler('models:remove');
  ipcMain.removeHandler('models:choose-directory');
  ipcMain.removeHandler('video:clock');
  ipcMain.removeHandler('session:media-error');
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
});
