import { app, BrowserWindow } from 'electron';
import type { ChatService } from './chat-service';
import type { SessionController } from './session-controller';
import type { OverlayController } from './overlay-controller';
import type { FloatingChatWindowController } from './floating-chat-window';
import type { DesktopLifecycle } from './desktop-lifecycle';

/** Opt-in package certification driver; not part of normal desktop lifecycle policy. */
export function installElectronSmoke(
  window: BrowserWindow,
  services: {
    chat: ChatService;
    session: SessionController;
    overlay: OverlayController;
    floating: FloatingChatWindowController;
    lifecycle: DesktopLifecycle;
  },
): void {
  const { chat, session, overlay, floating, lifecycle } = services;
  window.webContents.once('did-finish-load', () => {
    void run().catch((error: unknown) => {
      console.error('FAIL: Electron smoke', error);
      process.exitCode = 1;
      app.quit();
    });
  });
  async function run() {
    const result: {
      initial: number;
      later: number;
      overlayUrl: string;
      previewReady: boolean;
      apiKeys: string[];
      logCount: number;
      playgroundReady: boolean;
      session: import('../shared/session-contract').SessionSnapshot;
    } = await window.webContents.executeJavaScript(`(async () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const navigation = document.querySelector('nav[aria-label="Main navigation"] button[aria-label="Chat & Overlay"]');
        if (navigation) { navigation.click(); break; }
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
      const logs = await window.lonelyChat.getOperationalLogs();
      const playgroundStatus = await window.lonelyChat.getPlaygroundStatus();
      const playgroundReady = playgroundStatus.busy === false && !!document.querySelector('nav button[aria-label="Playground"]');
      const session = await window.lonelyChat.startSession('smoke test from Electron');
      return { initial: initial.sequence, later: later.sequence, previewReady, playgroundReady, session, logCount: logs.entries.length,
        apiKeys: Object.keys(window.lonelyChat).sort(), overlayUrl: await window.lonelyChat.getOverlayUrl() };
    })()`);
    if (
      result.initial !== 1 ||
      result.logCount < 2 ||
      result.later !== 2 ||
      result.overlayUrl !== overlay.snapshot().url ||
      !result.previewReady ||
      !result.playgroundReady ||
      result.session.phase !== 'running' ||
      result.apiKeys.join(',') !==
        'activateModel,audioDisconnected,cancelModelDownload,chooseModelDirectory,closeFloatingChat,configureDiagnosticCapture,configureFloatingChat,configureOperationalLogs,configureOverlayPort,discoverModels,exportDiagnosticCapture,getAudience,getAudioCapabilities,getAudioConfiguration,getAudioStatus,getChatSnapshot,getDiagnosticCapture,getFloatingChat,getModelsSnapshot,getNativeStatus,getOperationalLogs,getOverlayStatus,getOverlayUrl,getPlaygroundStatus,getPreferences,getSessionSnapshot,getWindowStatus,installModel,listDisplaySources,onAudienceChange,onAudioChange,onChatEvent,onFloatingChatChange,onMediaStop,onModelsChange,onNativeChange,onOperationalLog,onOverlayChange,onPlaygroundStatus,onSessionChange,openFloatingChat,publishSample,regenerateAudience,removeAudioInput,removeModel,retryAudio,retrySession,runFreeform,selectVideoSource,setAudioConfiguration,setAudioLabel,setCloseToTray,setPreferences,startAudio,startSession,stopAudio,stopSession,submitAudioSegment,submitVideoFrame'
    ) {
      throw new Error(`Electron smoke failed: ${JSON.stringify(result)}`);
    }
    const floatingState = await window.webContents.executeJavaScript(
      'window.lonelyChat.openFloatingChat()',
    );
    const captureWindow = BrowserWindow.getAllWindows().find((item) => item !== window);
    if (!floatingState.open || !captureWindow)
      throw new Error('Floating capture window failed to open');
    const captureInitial = await captureWindow.webContents.executeJavaScript(`(async () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (document.querySelector('[role="log"]')?.textContent?.includes('pixelpilot')) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return { visible: document.querySelector('[role="log"]')?.textContent?.includes('pixelpilot'), privileged: !!window.lonelyChat };
    })()`);
    if (!captureInitial.visible || captureInitial.privileged)
      throw new Error('Floating capture did not receive safe public chat');
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
      if (!floating.open().open) throw new Error('Unable to reopen floating presentation');
      window.close();
      if (window.isDestroyed() || window.isVisible())
        throw new Error('Main window was not hidden on active simulation close');
      if (!floating.snapshot().open || (await fetch(overlay.snapshot().url!)).status !== 200) {
        throw new Error('Background presentation failed after hiding main window');
      }
      await new Promise((resolve) => setTimeout(resolve, 1700));
      if (chat.snapshot().sequence <= beforeFloatingMessage + 1)
        throw new Error('Simulation stopped advancing with hidden configuration window');
      lifecycle.show();
      if (!window.isVisible()) throw new Error('Tray Show failed to restore main window');
      floating.close();
    }
    window.minimize();
    await new Promise((resolve) => setTimeout(resolve, 2500));
    if (chat.snapshot().sequence < 4 || session.snapshot().phase !== 'running') {
      throw new Error(
        `Simulation stopped publishing while minimized: ${JSON.stringify(session.snapshot())}`,
      );
    }
    await window.webContents.executeJavaScript('window.lonelyChat.stopSession()');
    const retained = chat.snapshot().sequence;
    await new Promise((resolve) => setTimeout(resolve, 2200));
    if (chat.snapshot().sequence !== retained || session.snapshot().pendingMessages !== 0)
      throw new Error('Stop failed to cancel pending playback');
    const restarted = await window.webContents.executeJavaScript(
      "window.lonelyChat.startSession('restarted smoke')",
    );
    if (restarted.phase !== 'running') throw new Error('Simulation did not restart');
    if (session.snapshot().phase !== 'running') throw new Error('No active playback at quit');
    console.info(
      'PASS: Electron preload IPC, floating window, tray background lifecycle, Start/Stop/Restart, minimized playback, retained chat',
    );
    app.quit();
  }
}
