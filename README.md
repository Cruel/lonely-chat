# Lonely Chat

Local simulated stream chat with an Electron app and browser-source overlay. The application can run a continuous **zero-input test simulation** using manual context and deterministic fake inference. It also discovers and installs public Hugging Face GGUF and native whisper.cpp model packages from the desktop UI. It runs **without a model, camera, microphone or OBS** in deterministic fixture mode. A managed native llama.cpp server now supports local GGUF inference from manual context; real media capture remains a later milestone.

## Requirements

- Node.js 24.18.0 or newer and pnpm 11.15.0
- Linux x64 (development); Windows x64 and macOS ARM64 are packaging targets.
- For headless Electron smoke tests on Linux: `xvfb-run` and the usual Chromium/Electron shared libraries.

## Quick start

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open **Models** in the desktop sidebar and paste a Hugging Face owner/repository name, repository URL, or direct file URL under **Hugging Face model discovery** to browse weight variants, sizes, split shards and possible multimodal projectors. Direct file URLs preselect the referenced artifact. When multiple projectors are possible, explicitly select one or choose text-only. Select **Install selected model** to download the model and chosen projector into managed storage. You can choose an existing storage folder before installing models; to switch folders later, remove existing managed installations first. Progress, cancellation, and resume-after-interruption are available; files are verified before they appear under **Installed models**. Each installed package can be activated/deactivated for its role or removed. Only public repositories are supported; selecting an installation alone does not launch a worker.

Open **Simulation**, enter stream context and choose **Deterministic fixture** or **Local llama.cpp** as the inference provider, then click **Start simulation**. Adjust the initial observation baseline, recent history entry count and history age limits under **Settings**; these settings are saved (old cycle-only preferences migrate automatically). Each inference uses a fresh bounded event, transcript, observation and already-presented chat snapshot plus the stable chatter roster. Consecutive inference cycles run one at a time without waiting for earlier chat batches to finish. Failed requests retry with bounded backoff against the same observation boundary, leaving previously validated events and queued chat intact; Stop cancels pending work and playback. Inferred-event timestamps describe observation time, separately from future chat playback offsets. Smoothed measured inference duration determines the native chat playback window. For llama.cpp, activate a verified vision/language GGUF installation (and include its matching projector if required) in the model manager first. The desktop shows model startup and errors. On demand, Electron starts the pinned native server on a private loopback port with an ephemeral API key and no Web UI, then stops it when the simulation stops or quits. Inference requests use JSON-schema-constrained generation where supported, and all resulting events/chat are independently validated before publication. Inferred events appear in the desktop; scheduled chat is shown in both the desktop and overlay. In fixture mode, application-owned inference cycles produce validated chat batches; the scheduler plays them at their offsets in both the preview and browser overlay. **Stop simulation** cancels all pending output without clearing the existing chat, and **Start** can be used again immediately. You can still publish a single independent sample message. The desktop **Chat & Overlay** section contains the preview, sample publisher and overlay URL, normally **http://127.0.0.1:45939/overlay**; load it in any browser or a browser source. The application binds the HTTP/WebSocket server **only to 127.0.0.1**. If that port is occupied, quit the conflicting service or set `LONELY_CHAT_OVERLAY_PORT` to a free port before launching Electron.

`pnpm dev` compiles Electron/main/preload once, starts the Vite+ development renderer on an available local port with HMR, and launches Electron. Restart to pick up changes in Electron code. `pnpm build` builds production UI, main and preload bundles.

```sh
pnpm typecheck
pnpm test
pnpm stage:llama      # downloads SHA-256-pinned b11700 binaries for this host
pnpm smoke:llama      # verifies the native binary and shared-library closure
pnpm build
pnpm test:overlay
xvfb-run -a pnpm smoke:electron   # Linux headless GUI
pnpm package:linux               # unsigned AppImage, includes staged native worker
```

For `test:overlay`, install Chromium as needed: `pnpm exec playwright install chromium`. It starts a deterministic test server, uses a real headless browser, and tests snapshot, live update, reload, and isolation. `smoke:electron` tests a real Electron window, sandboxed preload IPC, running playback while minimized, Stop cancellation, and restart. Deterministic unit and WebSocket integration tests cover scheduler ordering, overlapping batches, reconnect snapshots, stale completion rejection, fixed capture boundaries, history count/age pruning, model-duration smoothing, bounded retries, error recovery, and configuration migration. Native process tests cover the authenticated loopback server, health readiness, response validation, cancellation and worker exit. Set `LONELY_CHAT_CPU_SMOKE_MODEL=/absolute/path/to/small-model.gguf` when running `pnpm smoke:llama` to exercise a real CPU model completion; without this variable, the smoke checks the executable and libraries only. Small language models may fail to honor the requested schema even when the server returns HTTP 200; the application rejects malformed batches rather than publishing them. Controlled fake Hub HTTP/filesystem tests cover staged shard/projector installs, native speech artifacts, HTTP resume/ETag changes, checksum failures, disk checks, file tampering, and symlink-safe removal. GitHub Actions runs verification on Linux and checks Windows/macOS builds.

## Application boundaries

- `src/main/session-controller.ts`: authoritative Start/Stop and continuous one-at-a-time inference with configurable initial baseline, measured duration smoothing, fixed input snapshots, retry exhaustion diagnostics, and restart cancellation. It is independent of renderer lifecycle and remains active while the app is minimized.
- `src/main/inference-history.ts`: application-owned, ephemeral bounded event/transcript/observation history with high-water-mark snapshot boundaries and acknowledgement only after output validation. Later capture workers can submit timestamps and source-labeled observations/transcripts without opening public IPC.
- `src/main/fake-inference.ts`: deterministic fixture and atomic validation of inferred events and chat batches.
- `src/main/native-inference.ts`: managed llama.cpp child process (readiness, crash/stop, loopback-only secret-key API) and schema-hinted manual-context inference. Native binaries are pinned to llama.cpp `b11700` by `scripts/stage-llama.mjs`; stage output is ignored by Git and copied outside Electron's ASAR under `resources/llama/<platform>-<arch>`. The current pinned baseline is CPU-only, with GPU backends/resource tuning deferred.
- `src/main/chat-scheduler.ts`: one monotonic, deadline-ordered queue across overlapping inference batches. Pending output is canceled on Stop; delivered messages remain.
- `src/main/model-discovery.ts` + `src/shared/model-contract.ts`: desktop-only Hugging Face URL validation, recursive paginated Hub listing, GGUF/Whisper discovery, split-shard and projector grouping, and LFS SHA-256 metadata.
- `src/main/model-install-manager.ts` + `src/shared/model-install-contract.ts`: privately managed model package lifecycle, HTTP Range resume with ETag checks, disk-space preflight, per-file SHA-256 verification, staging/atomic publication, role activation, safe removal, and versioned `model-manager.json` configuration. Partial files remain outside the installed registry; unverified packages are disabled on reload. Manager-owned files live under `<selected storage>/installed` and interrupted transfers under `<selected storage>/.partial`. Only the registered package directory can be removed. File ownership is verified before removal.\n- `src/renderer/components/model-manager.tsx`: shadcn model/projector selectors, progress and cancellation, storage directory picker, installed package registry and activation/removal controls. The browser overlay receives none of these private details.
- `src/main/preferences-store.ts`: versioned `preferences.json` in Electron user data, storing only approved inference cadence, baseline duration, history entry count and history time horizon. Reads existing version-one cadence settings and writes version-two preferences. Manual context and history are never written to disk.
- `src/main/chat-service.ts`: authoritative, in-memory visible chat. Its only published data are safe display messages with monotonic sequence IDs.
- `src/main/overlay-server.ts`: public loopback HTTP `/overlay` and read-only WebSocket `/overlay/live`. New clients receive one snapshot, followed by ordered append events; reconnect obtains a new snapshot. The server does not expose configuration, transcript, inference, or control endpoints.
- `src/main/index.ts` + `src/preload/index.ts`: main lifecycle, sender-authorized IPC, sandboxed/context-isolated preload, and minimal desktop methods. The browser overlay never loads the preload.
- `src/renderer/components/desktop-sidebar.tsx` and `src/renderer/routes/app.tsx`: desktop category navigation for Simulation, Audience, Inputs, Models, Chat & Overlay, Logs, and Settings. Current chat/session views remain application-owned across category changes. Audience and Inputs are future feature placeholders; Logs currently shows available session metrics rather than a persisted native-process log stream. The read-only overlay route is unchanged.
- `src/renderer/components/chat-view.tsx`: shared accessible and reduced-motion-friendly chat renderer for desktop and browser overlay. It displays already-published events; it does not schedule them.

All presentation history is in-memory and bounded to 200 recent messages; inference context is separately bounded by both configured entry count and age, with an explicit count of observations dropped under backpressure. Validated event history remains visible after Stop until a new session begins. No captures, transcripts, manual context, or inference replies are persisted. The fixture publisher remains available for independent diagnostics. Media capture and speech inference are later milestones.

### Security and origin policy

External HTTP clients can request only the public overlay page and its static assets; WebSocket upgrades require `/overlay/live` and reject foreign browser origins. Browser clients cannot call Electron IPC. Electron only accepts IPC requests from its own top-level main window. Arbitrary navigation and extra windows are denied, apart from the explicit external overlay launch. There is no browser-accessible control API.

### Distribution

`electron-builder.yml` provides unsigned Linux x64 AppImage, Windows x64 NSIS and macOS ARM64 DMG scaffolding and stages pinned CPU llama.cpp native binaries and adjacent libraries outside ASAR. Packaged users need no Python or development tools. `pnpm package:linux`, `pnpm package:windows`, and `pnpm package:mac` fetch their respective pinned artifacts before packaging. Signing, notarization and release automation are later tickets. Output is under `out/`.
