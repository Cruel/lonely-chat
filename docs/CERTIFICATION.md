# T17: End-to-end certification (#18)

This is a **certification harness**, not a claim of release readiness. Run it against the implementation commits and native packages for the target platform. A successful JavaScript build alone does not certify a desktop release.

## Deterministic session coverage

`pnpm test` includes `src/main/full-session-certification.test.ts`. With a monotonic fake clock, synthetic timestamped video frames, two labeled transcript sources, a persistent generated roster, injected native inference replies and failures, it verifies:

- Explicit Start and initial capture baseline; no inference before baseline; one active model call at a time.
- Variable model latency (including a 30-second cycle), chronological sampling over the previous snapshot interval, bounded/adaptive frame selection, and original observation timestamps on inferred events.
- Source-labeled transcripts, recent events and chat in subsequent model requests; identical retry input even when new media arrives.
- Injected worker failure with bounded retry, advisory RAM pressure, scheduled chat delivery during the next in-flight inference, overlapping batches and exactly-once publication.
- The same ordered chat append events in the public browser WebSocket and an unprivileged floating-window client; snapshot-on-connect and full snapshot on reconnect, without exposing configuration/control endpoints.
- Persistent roster identity and placeholder resolution, Stop preserving published messages while clearing pending playback, and restart in no-video/no-audio manual-context mode.

Other focused integration suites (also required by `pnpm test`) certify history count/age pruning, shorter 3-second video windows, malformed output and retry exhaustion, model discovery/install/removal and worker/model switching, and independent audio-device disconnection/recovery. `pnpm test:overlay` exercises the React overlay with real headless Chromium. The packaged Electron smoke exercises the desktop preload, embedded chat, floating window, tray behavior where available, minimized playback, Start/Stop/Restart, and clean Quit.

## Package certification

The matrix in `.github/workflows/check.yml` builds unsigned Linux x64, Windows x64, and macOS ARM64 artifacts, then produces an **unpacked** electron-builder application (`--dir`) from the same staged inputs. `pnpm certify:package` inspects that unpacked application, not development executables:

1. Requires a nonempty packaged Electron executable and `resources/app.asar`.
2. Requires both exact pinned native worker release markers, target-specific executables and valid contained library symlinks **outside ASAR**.
3. Launches the bundled llama.cpp executable (including adjacent shared libraries) and sends a framed startup/error request to the bundled whisper.cpp worker.
4. Launches the actual packaged Electron executable, exercises the desktop/overlay/floating surfaces and lifecycle via `LONELY_CHAT_SMOKE=1`, and checks the overlay listener is gone after Quit.

For a local Linux headless run after staging native binaries:

```sh
pnpm build
pnpm exec electron-builder --linux --dir --publish never
xvfb-run -a pnpm certify:package
```

On Windows x64 or macOS ARM64, use the corresponding `pnpm package:windows` / `pnpm package:mac` staging steps and `electron-builder --win --dir` / `electron-builder --mac --arm64 --dir`, then `pnpm certify:package` on the actual target OS. Windows and macOS runs must pass CI before their packages are considered certified.

Optional **real** CPU inference fixtures use `LONELY_CHAT_CPU_SMOKE_MODEL=/absolute/path/to/small.gguf` and `LONELY_CHAT_CPU_SMOKE_SPEECH_MODEL=/absolute/path/to/ggml-tiny.en.bin` on the CI runner or local host; these cause packaged native smoke to load a GGUF, execute an authenticated structured llama.cpp completion, and run silent PCM through the real speech worker. Without these explicit model paths, the native smoke tests executable startup and negative-path IPC, **not** successful language generation or transcription. Model weights are deliberately excluded from app bundles.

## Qualification limits / release gates

- Linux x64 packaged smoke has a local headless execution path; Windows x64 and macOS ARM64 must be verified on their own runners. A package created locally for Linux cannot certify other platforms.
- Current pinned Linux/Windows llama.cpp assets are CPU-only. CUDA/Vulkan acceleration is **not certified** by package tests. macOS Metal availability and performance likewise require on-device GPU qualification. The advisory compute/RAM/VRAM controls are not hard partition limits.
- No physical camera, loopback/audio driver or GPU is required in normal CI. Those device-specific behaviors need separate hardware qualification; synthetic captures test the service behavior, not OS permissions.
- Worker startup without supplied real models is not a proof of model compatibility or inference accuracy. CPU fixture runs should be recorded when weights are supplied.
- **#17 remains a dependency:** a complete pinned native build/release pipeline, tag-driven publishing, shared-library closure checks on every target, and verified release assets must be signed off independently. This harness neither implements a release workflow nor substitutes for its cross-platform results.
- Code signing, notarization, auto-update, account integrations and broadcast-delay guarantees are outside parent spec #1's initial release scope.
