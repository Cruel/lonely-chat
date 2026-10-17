import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, ipcMain, shell, dialog, desktopCapturer } from 'electron';
import { ChatService, publishSample } from './chat-service';
import { SessionController } from './session-controller';
import { PreferencesStore } from './preferences-store';
import { DEFAULT_PREFERENCES } from '../shared/session-contract';
import { OverlayServer } from './overlay-server';
import { ModelDiscovery } from './model-discovery';
import { ModelInstallManager } from './model-install-manager';
import { NativeInference } from './native-inference';
import { bundledLlamaServer, bundledWhisperWorker } from './native-runtime-path';
import { NativeSpeech } from './native-speech';
import { AudioService } from './audio-service';
import { AudioConfigStore } from './audio-config-store';
import type { ChatEvent, DesktopInvocations, DesktopArguments } from '../shared/chat-contract';

const rendererDirectory = path.join(__dirname, '../renderer');
const preloadPath = path.join(__dirname, '../preload/preload.cjs');
const devOrigin = process.env.LONELY_CHAT_RENDERER_URL;
const chat = new ChatService();
const overlay = new OverlayServer(chat, rendererDirectory, devOrigin);
const preferenceStore = new PreferencesStore(app.getPath('userData'));
const audioConfig = new AudioConfigStore(app.getPath('userData'));
const models = new ModelDiscovery();
const installs = new ModelInstallManager(app.getPath('userData'), models);
let session: SessionController;
let audio: AudioService;
let mainWindow: BrowserWindow | null = null;
let quitting = false;
let selectedDisplaySource: Electron.DesktopCapturerSource | null = null;
let videoSelectionGeneration = 0;

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
    'overlay:url': () => overlay.url,
    'session:snapshot': () => session.snapshot(),
    'session:start': (context: string, mode?: import('../shared/session-contract').InferenceMode) =>
      session.start(context, mode),
    'session:stop': () => session.stop(),
    'preferences:get': () => session.getPreferences(),
    'preferences:set': async (
      preferences: import('../shared/session-contract').SessionPreferences,
    ) => {
      const written = await preferenceStore.write(preferences);
      return session.setPreferences(written);
    },
    'models:discover': (source: string) => models.discover(source),
    'models:snapshot': () => installs.snapshot(),
    'models:install': (selection: import('../shared/model-install-contract').ModelInstallRequest) =>
      installs.install(selection),
    'models:cancel': () => installs.cancel(),
    'models:activate': (role: import('../shared/model-contract').ModelRole, id: string | null) => {
      if (session.snapshot().phase === 'running' || session.snapshot().phase === 'starting') {
        throw new Error('Stop the simulation before changing the active model.');
      }
      if (
        role === 'speech-to-text' &&
        audio
          .snapshot()
          .sources.some((source) => source.phase === 'ready' || source.phase === 'starting')
      ) {
        throw new Error('Stop audio capture before changing the speech model.');
      }
      return installs.setActive(role, id);
    },
    'models:remove': (id: string) => {
      if (session.snapshot().phase === 'running' || session.snapshot().phase === 'starting') {
        throw new Error('Stop the simulation before removing a model.');
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
    if (mainWindow === window) {
      mainWindow = null;
      audio?.stop();
    }
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url === overlay.url) void shell.openExternal(url);
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
          result.overlayUrl !== overlay.url ||
          !result.previewReady ||
          result.session.phase !== 'running' ||
          result.apiKeys.join(',') !==
            'activateModel,audioDisconnected,cancelModelDownload,chooseModelDirectory,discoverModels,getAudioCapabilities,getAudioConfiguration,getAudioStatus,getChatSnapshot,getModelsSnapshot,getOverlayUrl,getPreferences,getSessionSnapshot,installModel,listDisplaySources,onAudioChange,onChatEvent,onModelsChange,onSessionChange,publishSample,removeAudioInput,removeModel,selectVideoSource,setAudioConfiguration,setAudioLabel,setPreferences,startAudio,startSession,stopAudio,stopSession,submitAudioSegment,submitVideoFrame'
        ) {
          throw new Error(`Electron smoke failed: ${JSON.stringify(result)}`);
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
        session.stop();
        console.info(
          'PASS: Electron preload IPC, Start/Stop/Restart, minimized playback, retained chat',
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
  let preferences = DEFAULT_PREFERENCES;
  try {
    preferences = await preferenceStore.read();
  } catch (error) {
    console.error('Invalid local preferences; using safe defaults', error);
  }
  await installs.open();
  installs.subscribe((snapshot) => {
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('models:change', snapshot);
  });
  session = new SessionController(
    chat,
    undefined,
    undefined,
    preferences,
    new NativeInference({
      executable: bundledLlamaServer(app.getAppPath(), app.isPackaged, process.resourcesPath),
      resolveModel: () => installs.activeVisionFiles(),
      reasoningEnabled: () => session.getPreferences().reasoningEnabled,
      inferenceTimeoutMs: () => session.getPreferences().inferenceTimeoutMs,
    }),
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
  });
  registerHandlers();
  chat.subscribe((event: ChatEvent) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('chat:event', event);
  });
  publishSample(chat);
  await overlay.start(Number(process.env.LONELY_CHAT_OVERLAY_PORT ?? 45939));
  console.info(`Lonely Chat overlay: ${overlay.url}`);
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
  if (BrowserWindow.getAllWindows().length === 0 && !quitting) openMainWindow();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  installs.cancel();
  audio?.stop();
  void Promise.all([session?.terminate(), overlay.stop()]).finally(() => app.quit());
});
app.on('will-quit', () => {
  ipcMain.removeHandler('chat:snapshot');
  ipcMain.removeHandler('chat:sample');
  ipcMain.removeHandler('overlay:url');
  ipcMain.removeHandler('session:snapshot');
  ipcMain.removeHandler('session:start');
  ipcMain.removeHandler('session:stop');
  ipcMain.removeHandler('preferences:get');
  ipcMain.removeHandler('preferences:set');
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
  ipcMain.removeHandler('audio:label');
  ipcMain.removeHandler('audio:disconnected');
  ipcMain.removeHandler('audio:remove');
  ipcMain.removeHandler('audio:stop');
  ipcMain.removeHandler('audio:segment');
});
