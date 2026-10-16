# Lonely Chat

Local simulated stream chat with an Electron app and browser-source overlay. The application can now run a continuous **zero-input test simulation** using manual context and deterministic fake inference. It runs **without a model, camera, microphone or OBS**. Real capture and model integration are later milestones.

## Requirements

- Node.js 24.18.0 or newer and pnpm 11.15.0
- Linux x64 (development); Windows x64 and macOS ARM64 are packaging targets.
- For headless Electron smoke tests on Linux: `xvfb-run` and the usual Chromium/Electron shared libraries.

## Quick start

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Enter stream context, then click **Start simulation**. Application-owned inference cycles produce validated chat batches; the scheduler plays them at their offsets in both the preview and browser overlay. **Stop simulation** cancels all pending output without clearing the existing chat, and **Start** can be used again immediately. You can still publish a single independent sample message. The overlay URL is shown in the app, normally **http://127.0.0.1:45939/overlay**; load it in any browser or a browser source. The application binds the HTTP/WebSocket server **only to 127.0.0.1**. If that port is occupied, quit the conflicting service or set `LONELY_CHAT_OVERLAY_PORT` to a free port before launching Electron.

`pnpm dev` compiles Electron/main/preload once, starts the Vite+ development renderer on an available local port with HMR, and launches Electron. Restart to pick up changes in Electron code. `pnpm build` builds production UI, main and preload bundles.

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm test:overlay
xvfb-run -a pnpm smoke:electron   # Linux headless GUI
pnpm package:linux               # unsigned AppImage
```

For `test:overlay`, install Chromium as needed: `pnpm exec playwright install chromium`. It starts a deterministic test server, uses a real headless browser, and tests snapshot, live update, reload, and isolation. `smoke:electron` tests a real Electron window, sandboxed preload IPC, running playback while minimized, Stop cancellation, and restart. Deterministic unit and WebSocket integration tests cover scheduler ordering, overlapping batches, reconnect snapshots, stale completion rejection, error recovery, and configuration persistence. GitHub Actions runs verification on Linux and checks Windows/macOS builds.

## Application boundaries

- `src/main/session-controller.ts`: authoritative Start/Stop, one in-flight inference at a time, fake provider, error states and restart cancellation. It is independent of renderer lifecycle and remains active while the app is minimized.
- `src/main/fake-inference.ts`: deterministic validated chat batches with relative playback offsets. Replaceable with the later inference adapter.
- `src/main/chat-scheduler.ts`: one monotonic, deadline-ordered queue across overlapping inference batches. Pending output is canceled on Stop; delivered messages remain.
- `src/main/preferences-store.ts`: versioned `preferences.json` in Electron user data, storing only the approved cycle interval setting (1.5, 3, or 5 seconds). Manual context and chat history are never written to disk.
- `src/main/chat-service.ts`: authoritative, in-memory visible chat. Its only published data are safe display messages with monotonic sequence IDs.
- `src/main/overlay-server.ts`: public loopback HTTP `/overlay` and read-only WebSocket `/overlay/live`. New clients receive one snapshot, followed by ordered append events; reconnect obtains a new snapshot. The server does not expose configuration, transcript, inference, or control endpoints.
- `src/main/index.ts` + `src/preload/index.ts`: main lifecycle, sender-authorized IPC, sandboxed/context-isolated preload, and minimal desktop methods. The browser overlay never loads the preload.
- `src/renderer/components/chat-view.tsx`: shared accessible and reduced-motion-friendly chat renderer for desktop and browser overlay. It displays already-published events; it does not schedule them.

All presentation history is in-memory and bounded to 200 recent messages. No captures, transcripts, manual context, or inference replies are persisted. The fixture publisher is retained for independent diagnostics; real media capture and model inference are not part of this milestone.

### Security and origin policy

External HTTP clients can request only the public overlay page and its static assets; WebSocket upgrades require `/overlay/live` and reject foreign browser origins. Browser clients cannot call Electron IPC. Electron only accepts IPC requests from its own top-level main window. Arbitrary navigation and extra windows are denied, apart from the explicit external overlay launch. There is no browser-accessible control API.

### Distribution

`electron-builder.yml` provides unsigned Linux x64 AppImage, Windows x64 NSIS and macOS ARM64 DMG scaffolding; signing, notarization, releases and native model binaries are later tickets. Output is under `out/`.
