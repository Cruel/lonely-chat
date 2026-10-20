# Reproducible desktop packaging and unsigned releases (#17)

The **authoritative app version** is `package.json`'s `version` field. `pnpm verify:release` validates its SemVer format, the optional `v`-prefixed release tag, and the pinned `.node-version` (Node 24.18.0) and pnpm 11.15.0. The lockfile is required with `pnpm install --frozen-lockfile`. A release tag must be exactly `v<package.json version>`. To prepare a new release, update `package.json`'s version and commit the matching pnpm lockfile if necessary.

## Native upstream pins

`scripts/native-release.mjs` is the central manifest of **llama.cpp b11700** archive filenames and pinned SHA-256s for Linux x64, Windows x64, and macOS ARM64. `scripts/stage-llama.mjs <platform> --accelerators` verifies every archive, extracts a matching platform binary and its adjacent libraries, and emits `native/llama/<platform>/manifest.json` plus the compatibility marker. It does not attempt cross-OS execution or depend on a local compiler.

The Linux/Windows distributables contain three **separate**, self-contained llama.cpp runtime directories: `bin/` (CPU), `vulkan/bin/`, and `cuda/bin/`. CUDA uses the pinned upstream CUDA **13.4** redistributable archive in the CUDA runtime directory; NVIDIA *drivers* are not redistributed. The macOS ARM64 b11700 build includes `libggml-metal.dylib` alongside the app executable, with CPU fallback on machines where Metal devices cannot be used. At run time, each actual binary is probed for devices, and the requested/automatic backend selects its corresponding executable. Missing drivers or optional backends are not claimed as usable; the CPU bundle is always available. The default VRAM target and GPU offload are zero, so GPU acceleration is opt-in.

`scripts/stage-whisper.mjs` fetches the pinned whisper.cpp v1.9.5 source commit `d1be6fde11ac6e0407606b4e42fe72d34add8037`, verifies its source archive checksum, compiles the small CPU-only speech worker **on the target operating system**, and records the source identity and executable SHA-256 in `native/whisper/<platform>/manifest.json`. MSVC uses the static CRT to avoid requiring a Visual Studio redistributable. Linux/macOS compile via the respective platform CMake toolchains. This build intentionally does not depend on Python, CUDA or a developer-installed compiler at runtime.

Electron Builder packages the UI as `app.asar` but places all native executable and shared library directories outside ASAR under `resources/llama` and `resources/whisper`. `node scripts/verify-native-stage.mjs native <platform> --accelerators` checks the source identities, expected variants, executable presence, contained library symlinks and whisper worker checksum. Packaged `pnpm certify:package` applies the same checks to the **packaged** resources and runs the bundled binaries and packaged Electron app. Linux CPU launcher checks include actual shared-library dynamic loading; CUDA/Vulkan/Metal driver availability cannot be established on headless CI runners.

## Local build

With the matching operating system/architecture and native toolchain:

```sh
pnpm install --frozen-lockfile
pnpm verify:release
pnpm package:linux                 # Ubuntu x64: AppImage
# On the corresponding build hosts:
pnpm package:windows               # Windows x64: NSIS .exe
pnpm package:mac                   # macOS ARM64: .dmg
```

All package commands produce unsigned assets under `out/`. Use `electron-builder --<target> --dir` after the same staging/build steps to make the unpacked app, then run `pnpm certify:package`. On Linux, wrap the last command with `xvfb-run -a`; set `LONELY_CHAT_REQUIRE_ACCELERATORS=1` to require both CUDA and Vulkan. No locally installed Windows toolchain is needed on the Linux/WSL development machine: GitHub-hosted Windows and Apple Silicon runners build their respective releases.

## GitHub workflow and release gate

`.github/workflows/check.yml` runs regular CI and is also a reusable workflow for `.github/workflows/release.yml`. Each OS builds the application, stages the pinned native binaries/accelerators, validates manifests, packages the unsigned installer/app bundle, and launches the unpacked app and bundled CPU workers. Linux additionally executes the real AppImage in extraction mode to prove the distributed file starts without FUSE. Linux also runs the full `pnpm check` and Chromium overlay test. Workflow artifacts retain the built `.AppImage`, `.exe`, and `.dmg` for 14 days.

A pushed tag matching `v<package.json version>` triggers the release workflow. The workflow can also be started manually using **Actions → Publish unsigned release → Run workflow**, selecting a branch for certification without publishing, or selecting an existing version tag for certification and publishing. It checks the authoritative version and, for a tag, rejects a mismatched tag; then waits for **all three** platform certification jobs to succeed. The `publish` job runs **only on a version tag** (including an explicitly dispatched tag), downloads artifacts, rejects missing/empty/extra assets, writes `SHA256SUMS.txt`, and creates an unsigned GitHub release with those assets. Release publishing requires the workflow's `contents:write` permission, not a local personal access token. No CI step creates or pushes a tag; the maintainer does so after the desired commit is ready.

Signing, notarization, auto-update, GPU benchmarks, and hardware-specific capture compatibility testing are not included. Drivers/ICD loaders provided by the operating system or GPU vendor are not bundled. CUDA 13.4 requires a sufficiently new NVIDIA driver; lacking it or a Vulkan driver, inference falls back to CPU, not an artificial GPU quota. CPU inference with a real GGUF and STT with a real GGML model are optional opt-in fixtures (environment variables described in [CERTIFICATION.md](CERTIFICATION.md)); routine CI validates native startup without downloading large user model weights. A GitHub-hosted CI result cannot prove performance or hardware device availability on a streamer's system.
