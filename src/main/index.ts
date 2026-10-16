import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
import { ChatService, publishSample } from './chat-service';
import { SessionController } from './session-controller';
import { PreferencesStore } from './preferences-store';
import { DEFAULT_PREFERENCES } from '../shared/session-contract';
import { OverlayServer } from './overlay-server';
import { ModelDiscovery } from './model-discovery';
import { ModelInstallManager } from './model-install-manager';
import type { ChatEvent, DesktopInvocations, DesktopArguments } from '../shared/chat-contract';

const rendererDirectory = path.join(__dirname, '../renderer');
const preloadPath = path.join(__dirname, '../preload/preload.cjs');
const devOrigin = process.env.LONELY_CHAT_RENDERER_URL;
const chat = new ChatService();
const overlay = new OverlayServer(chat, rendererDirectory, devOrigin);
const preferenceStore = new PreferencesStore(app.getPath('userData'));
const models = new ModelDiscovery();
const installs = new ModelInstallManager(app.getPath('userData'), models);
let session: SessionController;
let mainWindow: BrowserWindow | null = null;
let quitting = false;

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
    'session:start': (context: string) => session.start(context),
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
    'models:activate': (role: import('../shared/model-contract').ModelRole, id: string | null) =>
      installs.setActive(role, id),
    'models:remove': (id: string) => installs.remove(id),
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
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
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
            'activateModel,cancelModelDownload,chooseModelDirectory,discoverModels,getChatSnapshot,getModelsSnapshot,getOverlayUrl,getPreferences,getSessionSnapshot,installModel,onChatEvent,onModelsChange,onSessionChange,publishSample,removeModel,setPreferences,startSession,stopSession'
        ) {
          throw new Error(`Electron smoke failed: ${JSON.stringify(result)}`);
        }
        window.minimize();
        await new Promise((resolve) => setTimeout(resolve, 1150));
        const visibleWhileMinimized = chat.snapshot();
        if (visibleWhileMinimized.sequence < 4 || session.snapshot().phase !== 'running') {
          throw new Error('Simulation stopped publishing while minimized');
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
  session = new SessionController(chat, undefined, undefined, preferences);
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
  session?.stop();
  installs.cancel();
  void overlay.stop().finally(() => app.quit());
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
});
