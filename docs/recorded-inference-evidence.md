# Private multi-stage inference recording

The desktop **Persistent inference recording** control is disabled by default. Once enabled, it records independent Unified, Vision, Chat, and memory attempts in a private, bounded, compressed archive. The normal Run Inspector remains an in-memory diagnostic view; the public chat overlay and operational logs do not receive these recording payloads.

Each attempt is tied to its original Run and includes the stage role, model, profile revision, seed, source-frame references, observed and available timestamps, terminal outcome or failure, and explicit downstream `dependsOn` stage IDs. Scheduled Chat batches, actually presented messages, and Run presentation closure are recorded separately, so a successful Vision observation cannot be confused with a later Chat result or publication time.

## Privacy and storage

Recording does **not** imply consent to store private content. Two independent permissions, both off by default, can be selected before starting a recording:

- **Retain raw sampled image frames** stores the selected inference JPEGs as deduplicated, content-addressed files. Without it, frame IDs and timestamps remain, but image bytes are omitted. The recorder does not copy source video clips or raw audio.
- **Retain full prompts and responses** preserves text, transcripts, scene descriptions, validated output, and chat text. Without it, content is redacted, while correlation metadata remains. Exact mode can preserve a submitted request when consent and required source media are available; otherwise reconstruction explicitly reports metadata-only provenance. Compact mode reconstructs eligible Unified requests using the current builder and makes no such claim for Split-stage prompts.

Recording permissions are frozen for each archive. Credential field names and recognized token patterns are redacted even when full content is enabled. Raw-content archives may still contain sensitive material and are not encrypted by the recorder: local filesystem permissions restrict access. Review evidence before sharing or exporting it.

A configurable total disk quota, in-flight memory limit and maximum archive age (30 days by default) bound retention. Expired archives are removed during normal configuration and evidence access, but active writes are protected. Quota exhaustion stops further recording without stopping inference; saved Playground cases are governed separately. Deletion is not guaranteed secure erasure.

## Recovery and integrity

The recorder snapshots input and policy at admission. It writes a compressed JSONL evidence chunk, then appends its index after chunk and optional media writes complete. Already-admitted stages are allowed to finish writing to their **original** archive after recording is stopped. Clean completion has an archive marker; interrupted attempts and recovered bounded orphan chunks are labelled distinctly.

Reading and importing archives validates chunk hashes, stage identity and causal references, path-safe filenames, JPEG hashes, structural limits, and known secret patterns. Checksums protect against corruption but are **not** cryptographic signatures or proof of an archive's origin. Reconstruction never invokes a provider, invents missing media, or modifies the active Run's event history.
