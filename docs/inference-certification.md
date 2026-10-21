# T21: Inference integration and release qualification (#68)

This is the certification inventory for the Unified / Split / Hybrid inference refactor. The deterministic cases use production coordinators, stage contracts and validation, with model/network edges replaced by isolated fixtures. They do **not** claim actual GPU throughput or live provider availability.

## Automated regression matrix

All of the following run with `pnpm test`. They require no model downloads, credentials, physical capture devices or GPU:

| Boundary | Reproducible evidence |
| --- | --- |
| Unified local request, frame chronology, scheduling and retry | `src/main/full-session-certification.test.ts`, `src/main/native-session.test.ts`, `src/main/native-inference.test.ts` |
| OpenAI-compatible provider, image permission, output schemas and abort/error isolation | `src/main/remote-inference.test.ts` |
| ChatGPT-plan OAuth, concurrent refresh, scope/nonce checks, usage limits, streamed replies and isolated Playground | `src/main/chatgpt-inference.test.ts` (local OAuth/HTTP fixtures) |
| Local Vision + local Chat sharing one role adapter, and local Vision + real loopback-compatible remote Chat | `src/main/inference-topology-certification.test.ts` (recorded SessionController cycles) |
| Hybrid remote Chat image consent, Split text-only Chat and private recorded presentation | `src/main/inference-topology-certification.test.ts`, `src/main/split-session.test.ts` |
| Independent Vision/Chat cadence, EOF drain, revision admission, memory and GPU worker serialization | `src/main/split-lifecycle-regressions.test.ts`, `src/main/stage-cadence.test.ts`, `src/main/local-model-pool.test.ts`, `src/main/memory-production-adapters.test.ts` |
| Frozen Exact/Compact outcomes, causality, recorded replay and restricted archived evidence | `src/main/compact-inference-recorder.test.ts`, `src/main/run-replay.test.ts`, `src/main/saved-inference-cases.test.ts`, `src/main/portable-archives.test.ts` |
| Current-only preferences and exact-case source evidence; reject old schemas rather than guessing | `src/main/preferences-store.test.ts`, `src/main/saved-inference-cases.test.ts` |

Current profile validation permits per-stage `inferenceTimeoutMs` for Split/Hybrid local and remote transports; other per-stage SessionPreferences are rejected rather than reported as effective. Frame selection, context, prompts, output tokens and stage cadence use their dedicated profile policies. Memory without a dedicated model uses the pinned Chat model with its own scheduling priority and timeout; local Profile Playground experiments likewise reuse that Chat worker instead of loading duplicate weights. Each local stage's admitted request deadline overrides the worker's global Run timeout (including the native-video transport). A running Split/Hybrid session rejects live edits to Observer, Chat, or Memory transport timeouts until Stop/new Run, avoiding a mismatch between pinned adapters and Inspector evidence. Unified narrative memory is not implemented: enabling it is rejected at profile validation rather than silently ignored.

The private archive tests verify malformed fields and payloads fail before insertion. The recorded Split/Hybrid tests assert no Chat is published on the public overlay when the Run is private, and that only explicitly consented Hybrid profiles send images to Chat.

## Packaged desktop qualification

On the target OS with native workers already staged, run:

```sh
pnpm typecheck
pnpm test
pnpm test:overlay
pnpm build
pnpm exec electron-builder --linux --dir --publish never
xvfb-run -a pnpm certify:package
```

Replace the Linux packaging and display commands with the Windows or macOS instructions in [packaged-certification.md](packaged-certification.md). The package lane exercises **packaged** Chromium/renderer/preload, Scenario/Run lifecycle, two real WAV/PCM tracks, JPEG capture, private overlay isolation, Playground, exact native request traces, frozen archives, bundled CPU worker startup, and Stop/Restart. The packaged end-to-end worker returns deterministic data, but the app still performs real media decode, IPC, scheduling and persistence. Inspect `out/certification-<platform>-<arch>.json` for status; a compilation pass alone is insufficient. Separate distribution certification verifies the actual installed/distributed artifact.

## Optional real-provider qualification

For local llama.cpp/whisper.cpp on a machine with the necessary model files, set `LONELY_CHAT_CPU_SMOKE_MODEL` (text GGUF) and `LONELY_CHAT_CPU_SMOKE_SPEECH_MODEL` (Whisper GGML) when running the package suite. These opt-in checks execute model-dependent CPU inference/transcription; without them, the package suite explicitly reports skips. Actual local multi-model residency, GPU scheduling/performance and native-video capability still need target-device and matching-model qualification.

To qualify a live remote provider, configure a dedicated test Connection and model in the desktop UI, run its compatibility probe, select Unified / Split / Hybrid profiles, and verify session output and Run Inspector traces. For ChatGPT-plan inference, authorize a test account with the permitted scope and confirm model listing, refresh and usage-limit handling. Use short, private synthetic media; **never** use personal streams or production tokens as certification fixtures. These live exercises are optional and are not claimed by the deterministic CI matrix; they can incur provider charges or plan limits. Never record/replay actual account credentials in Run evidence or export archives.

Cross-platform hardware, OS keyring, native codec, GPU and live OAuth qualification must be recorded separately. The Linux result does not certify Windows or macOS. No hard GPU compute/VRAM partitioning is claimed; configured resource budgets are advisory.
