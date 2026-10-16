import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { ChatService, publishSample } from './chat-service';
import { OverlayServer } from './overlay-server';
import type { ChatEvent, DesktopInvocations } from '../shared/chat-contract';

const rendererDirectory = path.join(__dirname, '../renderer');
const preloadPath = path.join(__dirname, '../preload/preload.cjs');
const devOrigin = process.env.LONELY_CHAT_RENDERER_URL;
const chat = new ChatService();
const overlay = new OverlayServer(chat, rendererDirectory, devOrigin);
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
  } satisfies { [K in keyof DesktopInvocations]: () => DesktopInvocations[K] };
  for (const channel of Object.keys(actions) as Array<keyof DesktopInvocations>) {
    ipcMain.handle(channel, (event) => {
      requireDesktop(event);
      return actions[channel]();
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
          return {
            initial: initial.sequence,
            later: later.sequence,
            previewReady,
            apiKeys: Object.keys(window.lonelyChat).sort(),
            overlayUrl: await window.lonelyChat.getOverlayUrl()
          };
        })()`);
        if (
          result.initial !== 1 ||
          result.later !== 2 ||
          result.overlayUrl !== overlay.url ||
          !result.previewReady ||
          result.apiKeys.join(',') !== 'getChatSnapshot,getOverlayUrl,onChatEvent,publishSample'
        ) {
          throw new Error(`Electron smoke failed: ${JSON.stringify(result)}`);
        }
        console.info('PASS: Electron main window, sandboxed preload IPC, and app-owned sample');
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
  void overlay.stop().finally(() => app.quit());
});
app.on('will-quit', () => {
  ipcMain.removeHandler('chat:snapshot');
  ipcMain.removeHandler('chat:sample');
  ipcMain.removeHandler('overlay:url');
});
