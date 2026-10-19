# Packaged end-to-end certification (#46)

A successful compile is not evidence that the distributed desktop works. The **Linux x64, Windows x64 and macOS ARM64** jobs in `.github/workflows/check.yml` invoke `pnpm certify:package` on an unpacked application, then independently run `node scripts/certify-distribution.mjs` on the actual distributed artifact (Linux AppImage, a silent-installed Windows NSIS exe, or a macOS app copied from the mounted DMG). The release workflow calls these CI jobs before publishing.

The package certification verifies pinned, executable bundled llama.cpp and whisper.cpp binaries, their linked libraries and IPC. It also starts the **packaged Electron binary** twice:

1. The existing packaged smoke verifies preload, event delivery, floating window, tray/background playback and Stop/Restart.
2. `certify:e2e` runs a new profile containing no user's models or preferences. It exercises desktop preload IPC, Playground freeform and structured output, a deliberately failed worker and persisted operational logs, the real Chromium video decoder/frame sampler, independent 16-kHz WAV tracks through the actual resampler/VAD path, labeled speech output, a recorded Scenario/Run, Events, private desktop Chat, Compact/Exact diagnostic recording, Run Inspector evidence, and Scenario/Run/Exact-case archive round trips through the desktop preload, IPC and controlled file dialogs. Exact mode executes real SessionController inference against a bounded deterministic native-provider fixture rather than manually creating trace entries. It also checks that private recorded Chat and diagnostics never appear on the read-only public overlay.

The second driver generates a short embedded VP8/WebM video and two labeled PCM WAV tracks on demand; it does **not** need FFmpeg on the CI host, a GPU, a large model, a webcam, or an audio device. It substitutes small deterministic CPU-only inference and speech workers for the expensive model calls, but otherwise runs through the **packaged UI and production media processing path**. The workers are replaced **only** when `LONELY_CHAT_CERTIFY_E2E=1`, with an isolated absolute profile and media directory, and only in a packaged binary.

To run locally after staging native runtimes and building the app:

```sh
pnpm build
pnpm exec electron-builder --linux --dir --publish never
xvfb-run -a pnpm certify:package
pnpm exec electron-builder --linux --publish never
xvfb-run -a node scripts/certify-distribution.mjs
```

On macOS, use the corresponding platform target and omit `xvfb-run`. **Never run the Windows NSIS distribution certification on a developer machine or a self-hosted runner.** Even with a temporary `/D` destination, NSIS can replace an existing Lonely Chat installation's registration and shortcuts. `certify-distribution.mjs` refuses Windows execution unless `CI=true`, `GITHUB_ACTIONS=true`, `RUNNER_OS=Windows`, and `RUNNER_ENVIRONMENT=github-hosted`. The disposable hosted runner uninstalls the temporary NSIS installation using its own silent uninstaller before deleting the files. If uninstall fails, the runner fails and preserves the directory for recovery rather than leaving broken registration/shortcuts. The unpacked `pnpm certify:package` lane remains available on Windows development machines without invoking NSIS. To rerun only the packaged UI/media lane use `pnpm certify:e2e` (`xvfb-run -a pnpm certify:e2e` on headless Linux). Unpacked results are saved to `out/certification-<platform>-<arch>.json`; the installed/distributed executable produces a separate `out/certification-distributed-<platform>-<arch>.json`. Both report `passed`, `failed`, `unsupported-codec`, or `unsupported-hardware`. CI uploads these JSON reports as certification artifacts, deliberately distinct from binary `lonely-chat-*` release artifacts. A failing/unsupported decoder **fails certification** rather than silently passing.

For additional real CPU inference checks, provide `LONELY_CHAT_CPU_SMOKE_MODEL` (small text GGUF) and/or `LONELY_CHAT_CPU_SMOKE_SPEECH_MODEL` (Whisper model) before running `pnpm certify:package`. The pinned bundled workers will execute real CPU freeform and structured llama completions and/or a real Whisper PCM request when their respective models exist. Without those variables the scripts still verify binary loading and framed IPC, but explicitly print `SKIP` for model-dependent work. These optional tests are not a requirement for ordinary CI. Codec support and graphics/audio hardware availability vary with operating system and installed Chromium; the packaged end-to-end test records unsupported conditions separately, never fabricates usable outputs.

The fixture profile, generated media, saved evidence and transcripts are removed on exit. No real user profile is read or modified during certification. Only synthetic data is written to the CI report.
