import path from 'node:path';
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
const chat = new ChatService();
const overlay = new OverlayController(
  () => new OverlayServer(chat, rendererDirectory, devOrigin),
  new OverlayPortStore(app.getPath('userData')),
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
      .catch((error: unknown) => console.error('Unable to save window settings', error));
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
    session.stop();
  },
  () => {
    app.quit();
  },
  () => {
    if (!mainWindow && !quitting) openMainWindow();
  },
  (error) => console.warn('System tray unavailable, main window will close normally:', error),
);

function windowStatus() {
  return { closeToTray: windowPrefs.closeToTray, trayAvailable: lifecycle.hasTray };
}
const models = new ModelDiscovery();
const installs = new ModelInstallManager(app.getPath('userData'), models);
let session: SessionController;
let audience: AudienceService;
let nativeInference: NativeInference;
let audio: AudioService;
let mainWindow: BrowserWindow | null = null;
let quitting = false;
let teardownComplete = false;
let selectedDisplaySource: Electron.DesktopCapturerSource | null = null;
let videoSelectionGeneration = 0;
let rosterRegenerating = false;
let rosterGenerationAbort: AbortController | null = null;
let speechSwitchBusy = false;

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
    ) => {
      if (rosterRegenerating) throw new Error('Roster regeneration is in progress.');
      return session.start(
        context,
        mode,
        mode === 'native' ? installs.snapshot().active['vision-language'] : null,
      );
    },
    'session:stop': () => session.stop(),
    'session:retry': () => session.retry(),
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
    'audience:regenerate': async (mode: import('../shared/session-contract').InferenceMode) => {
      if (!['stopped', 'error'].includes(session.snapshot().phase)) {
        throw new Error('Stop the simulation before regenerating its audience.');
      }
      if (mode !== 'fake' && mode !== 'native') throw new Error('Invalid inference mode.');
      if (rosterRegenerating) throw new Error('Roster regeneration is already in progress.');
      rosterRegenerating = true;
      const provider = mode === 'native' ? nativeInference : new FakeInference();
      const abort = new AbortController();
      rosterGenerationAbort = abort;
      try {
        await session.awaitShutdown();
        return await audience.ensure(provider, abort.signal, true);
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
    'video:list-displays': async () =>
      (await listDesktopSources()).map((source) => ({
        id: `display:${source.id}`,
        label: source.name,
        kind: source.id.startsWith('screen:') ? ('screen' as const) : ('window' as const),
      })),
    'video:select': async (sourceId: string | null) => {
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
      if (generation !== videoSelectionGeneration) return;
      // Disabling capture clears the frame ring without discarding the chosen desktop
      // source. Chromium needs it armed before the next user-gesture capture request.
      if (sourceId !== null) selectedDisplaySource = source;
      session.selectVideoSource(
        source ? sourceId : sourceId?.startsWith('camera:') ? sourceId : null,
      );
      if (sourceId?.startsWith('display:') && !source) {
        throw new Error('The selected screen or window is no longer available.');
      }
    },
    'video:frame': (frame: import('../shared/video-contract').VideoFrame) =>
      session.recordVideoFrame(frame),
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
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      requireDesktop(event);
      // Channel-specific input validation occurs in the owning service/store.
      return (actions[channel] as (...values: unknown[]) => unknown)(...args);
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
    window.webContents.once('did-finish-load', () => {
      void (async () => {
        const result: {
          initial: number;
          later: number;
          overlayUrl: string;
          previewReady: boolean;
          apiKeys: string[];
          session: import('../shared/session-contract').SessionSnapshot;
        } = await window.webContents.executeJavaScript(`(async () => {
          // The chat preview now belongs to its own desktop category.
          for (let attempt = 0; attempt < 100; attempt++) {
            const chatNavigation = document.querySelector('nav[aria-label="Main navigation"] button[aria-label="Chat & Overlay"]');
            if (chatNavigation) { chatNavigation.click(); break; }
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          let previewReady = false;
          for (let attempt = 0; attempt < 100; attempt++) {
            previewReady = document.querySelector('[role="log"]')?.textContent?.includes('pixelpilot') === true;
            if (previewReady) break;
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          const initial = await window.lonelyChat.getChatSnapshot();
          await window.lonelyChat.publishSample();
          const later = await window.lonelyChat.getChatSnapshot();
          const session = await window.lonelyChat.startSession('smoke test from Electron');
          return {
            initial: initial.sequence,
            later: later.sequence,
            previewReady,
            session,
            apiKeys: Object.keys(window.lonelyChat).sort(),
            overlayUrl: await window.lonelyChat.getOverlayUrl()
          };
        })()`);
        if (
          result.initial !== 1 ||
          result.later !== 2 ||
          result.overlayUrl !== overlay.snapshot().url ||
          !result.previewReady ||
          result.session.phase !== 'running' ||
          result.apiKeys.join(',') !==
            'activateModel,audioDisconnected,cancelModelDownload,chooseModelDirectory,closeFloatingChat,configureFloatingChat,configureOverlayPort,discoverModels,getAudience,getAudioCapabilities,getAudioConfiguration,getAudioStatus,getChatSnapshot,getFloatingChat,getModelsSnapshot,getNativeStatus,getOverlayStatus,getOverlayUrl,getPreferences,getSessionSnapshot,getWindowStatus,installModel,listDisplaySources,onAudienceChange,onAudioChange,onChatEvent,onFloatingChatChange,onModelsChange,onNativeChange,onOverlayChange,onSessionChange,openFloatingChat,publishSample,regenerateAudience,removeAudioInput,removeModel,retryAudio,retrySession,selectVideoSource,setAudioConfiguration,setAudioLabel,setCloseToTray,setPreferences,startAudio,startSession,stopAudio,stopSession,submitAudioSegment,submitVideoFrame'
        ) {
          throw new Error(`Electron smoke failed: ${JSON.stringify(result)}`);
        }
        const floatingState = await window.webContents.executeJavaScript(
          'window.lonelyChat.openFloatingChat()',
        );
        const captureWindow = BrowserWindow.getAllWindows().find((item) => item !== window);
        if (!floatingState.open || !captureWindow) {
          throw new Error('Floating capture window failed to open');
        }
        const captureInitial = await captureWindow.webContents.executeJavaScript(`(async () => {
          for (let attempt = 0; attempt < 100; attempt++) {
            if (document.querySelector('[role="log"]')?.textContent?.includes('pixelpilot')) break;
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          return {
            visible: document.querySelector('[role="log"]')?.textContent?.includes('pixelpilot'),
            privileged: !!window.lonelyChat
          };
        })()`);
        if (!captureInitial.visible || captureInitial.privileged) {
          throw new Error('Floating capture did not receive safe public chat');
        }
        const beforeFloatingMessage = chat.snapshot().sequence;
        await window.webContents.executeJavaScript('window.lonelyChat.publishSample()');
        const latestText = chat.snapshot().messages.at(-1)?.text;
        const captureUpdated = await captureWindow.webContents.executeJavaScript(`(async () => {
          for (let attempt = 0; attempt < 100; attempt++) {
            if (document.querySelector('[role="log"]')?.textContent?.includes(${JSON.stringify(latestText)})) return true;
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          return false;
        })()`);
        const floatingClosed = await window.webContents.executeJavaScript(
          'window.lonelyChat.closeFloatingChat()',
        );
        if (
          !captureUpdated ||
          floatingClosed.open ||
          chat.snapshot().sequence !== beforeFloatingMessage + 1
        ) {
          throw new Error('Floating capture changed chat delivery or failed to close');
        }
        const requestedTray = await window.webContents.executeJavaScript(
          'window.lonelyChat.setCloseToTray(true)',
        );
        if (!requestedTray.closeToTray) throw new Error('Close-to-tray preference did not apply');
        if (requestedTray.trayAvailable) {
          const floatingAgain = floating.open();
          if (!floatingAgain.open) throw new Error('Unable to reopen floating presentation');
          window.close();
          if (window.isDestroyed() || window.isVisible()) {
            throw new Error('Main window was not hidden on active simulation close');
          }
          if (!floating.snapshot().open || (await fetch(overlay.snapshot().url!)).status !== 200) {
            throw new Error('Background presentation failed after hiding main window');
          }
          await new Promise((resolve) => setTimeout(resolve, 1700));
          if (chat.snapshot().sequence <= beforeFloatingMessage + 1) {
            throw new Error('Simulation stopped advancing with hidden configuration window');
          }
          lifecycle.show();
          if (!window.isVisible()) throw new Error('Tray Show failed to restore main window');
          floating.close();
        }
        window.minimize();
        await new Promise((resolve) => setTimeout(resolve, 2500));
        const visibleWhileMinimized = chat.snapshot();
        if (visibleWhileMinimized.sequence < 4 || session.snapshot().phase !== 'running') {
          throw new Error(
            `Simulation stopped publishing while minimized: sequence=${visibleWhileMinimized.sequence}, status=${JSON.stringify(session.snapshot())}`,
          );
        }
        await window.webContents.executeJavaScript('window.lonelyChat.stopSession()');
        const retained = chat.snapshot().sequence;
        await new Promise((resolve) => setTimeout(resolve, 2200));
        if (chat.snapshot().sequence !== retained || session.snapshot().pendingMessages !== 0) {
          throw new Error('Stop failed to cancel pending playback');
        }
        const restarted = await window.webContents.executeJavaScript(
          "window.lonelyChat.startSession('restarted smoke')",
        );
        if (restarted.phase !== 'running') throw new Error('Simulation did not restart');
        // Quit while the scheduler is active; teardown must cancel pending work.
        if (session.snapshot().phase !== 'running') throw new Error('No active playback at quit');
        console.info(
          'PASS: Electron preload IPC, floating window, tray background lifecycle, Start/Stop/Restart, minimized playback, retained chat',
        );
        app.quit();
      })().catch((error: unknown) => {
        console.error('FAIL: Electron smoke', error);
        process.exitCode = 1;
        app.quit();
      });
    });
  }
  if (devOrigin) void window.loadURL(devOrigin);
  else void window.loadFile(path.join(rendererDirectory, 'index.html'));
}

async function boot(): Promise<void> {
  try {
    windowPrefs = await windowStore.read();
  } catch (error) {
    console.error('Invalid window preferences; using safe defaults', error);
    windowPrefs = DEFAULT_WINDOW_PREFERENCES;
  }
  floating.configure(windowPrefs.floating);
  lifecycle.initialize(windowPrefs.closeToTray);
  let preferences = DEFAULT_PREFERENCES;
  try {
    preferences = await preferenceStore.read();
  } catch (error) {
    console.error('Invalid local preferences; using safe defaults', error);
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
  nativeInference = new NativeInference({
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
    resolveModel: () => installs.activeVisionFiles(),
    reasoningEnabled: () => session.getPreferences().reasoningEnabled,
    inferenceTimeoutMs: () => session.getPreferences().inferenceTimeoutMs,
    resourcePreferences: () => session.getPreferences(),
  });
  nativeInference.subscribe((status) => {
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
  );
  audio = new AudioService(
    () =>
      new NativeSpeech({
        executable: bundledWhisperWorker(app.getAppPath(), app.isPackaged, process.resourcesPath),
        resolveModel: () => installs.activeSpeechFile(),
      }),
    (entry) => {
      if (session.snapshot().phase === 'running' || session.snapshot().phase === 'starting') {
        try {
          session.recordTranscript(entry);
        } catch (error) {
          console.error('Unable to record transcript', error);
        }
      }
    },
  );
  audio.subscribe((status) => {
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('audio:change', status);
  });
  session.subscribe((status) => {
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('session:change', status);
    lifecycle.refreshTray();
  });
  registerHandlers();
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
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('overlay:change', status);
  });
  const overlayStatus = await overlay.initialize(process.env.LONELY_CHAT_OVERLAY_PORT);
  if (overlayStatus.url) console.info(`Lonely Chat overlay: ${overlayStatus.url}`);
  else console.error('Lonely Chat overlay unavailable:', overlayStatus.error);
  openMainWindow();
}

app
  .whenReady()
  .then(boot)
  .catch((error: unknown) => {
    console.error('Unable to start Lonely Chat', error);
    app.quit();
  });
app.on('activate', () => {
  if (!quitting) lifecycle.show();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
const shutdown = new ManagedShutdown(
  () => {
    session?.stop();
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
    () => overlay.stop(),
    () => flushWindowSave(),
  ],
  (error) => console.error('Managed shutdown failed', error),
);

app.on('before-quit', (event) => {
  if (teardownComplete) return;
  event.preventDefault();
  if (quitting) return; // repeated Quit must not bypass async worker teardown
  quitting = true;
  lifecycle.beginShutdown();
  void shutdown.stop().then(() => {
    teardownComplete = true;
    app.quit();
  });
});
app.on('will-quit', () => {
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
