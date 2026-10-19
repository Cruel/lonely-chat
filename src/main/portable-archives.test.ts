import { randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { DEFAULT_PREFERENCES } from '../shared/session-contract';
import type { RecordedScenarioConfig } from '../shared/recorded-scenario-contract';
import type { InferenceInput } from './fake-inference';
import { InferenceTrace } from './inference-trace';
import { CompactInferenceRecorder } from './compact-inference-recorder';
import { nativeChatRequest } from './native-inference';
import { archiveHash, makeArchive, openArchive } from './portable-archive';
import { importScenario, packageScenario, portableRun, restoreRun } from './portable-scenarios';
import { RecordedScenarioStore, verifyRecordedSources } from './recorded-scenarios';

const fixtureJpeg = readFileSync(
  new URL('../../tests/fixtures/playground-red.jpg', import.meta.url),
);
const roots: string[] = [];
async function temp(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lonely-portable-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function config(root: string): RecordedScenarioConfig {
  return {
    context: 'Private game prompt',
    mode: 'native',
    video: { path: path.join(root, 'original-video.mp4') },
    audio: [
      {
        id: 'mic:source/1',
        kind: 'file',
        path: path.join(root, 'mic.wav'),
        label: 'Mic',
        enabled: true,
        offsetMs: -500,
        embeddedTrackIndex: null,
      },
    ],
    segment: { startMs: 100, endMs: 2000 },
    transcriptMode: 'save',
    publishToOverlay: true,
    seed: 17,
    presetId: null,
    presetRevision: null,
    modelId: 'local-model',
    settingsSnapshot: DEFAULT_PREFERENCES,
    settingsPolicy: 'saved',
  };
}
it('exports metadata-only Scenario without absolute paths and imports relinkable sources privately', async () => {
  const root = await temp();
  const target = await temp();
  const store = new RecordedScenarioStore(root);
  const original = await store.save('Test scene', config(root));
  const raw = await packageScenario(original, false);
  expect(raw).toContain('Private game prompt');
  expect(raw).not.toContain(root);
  expect(raw).not.toContain('original-video.mp4\\');
  expect(openArchive(raw, 'scenario').files.size).toBe(0);
  const imported = await importScenario(raw, new RecordedScenarioStore(target), target);
  expect(imported.missing).toEqual(['original-video.mp4', 'mic.wav']);
  expect(imported.scenario.id).not.toBe(original.id);
  expect(imported.scenario.config.publishToOverlay).toBe(false);
  expect(imported.scenario.config.audio[0].offsetMs).toBe(-500);
  expect(imported.scenario.config.video?.path).toContain(path.join(target, 'portable-media'));
  await expect(verifyRecordedSources(imported.scenario.config)).rejects.toThrow(
    /missing or unreadable/,
  );
  const second = await importScenario(raw, new RecordedScenarioStore(target), target);
  expect(second.scenario.name).not.toBe(imported.scenario.name);
});

it('bundles original media only when explicitly requested; rejects unsafe paths and corrupt bytes', async () => {
  const root = await temp();
  const target = await temp();
  await writeFile(path.join(root, 'original-video.mp4'), 'video payload');
  await writeFile(path.join(root, 'mic.wav'), 'audio payload');
  const scenario = await new RecordedScenarioStore(root).save('Scene', config(root));
  const raw = await packageScenario(scenario, true);
  expect(raw).not.toContain(root);
  expect(openArchive(raw, 'scenario').files.size).toBe(2);
  const imported = await importScenario(raw, new RecordedScenarioStore(target), target);
  expect(imported.missing).toEqual([]);
  await verifyRecordedSources(imported.scenario.config);
  expect(await readFile(imported.scenario.config.video!.path, 'utf8')).toBe('video payload');
  expect(await readFile(imported.scenario.config.audio[0].path!, 'utf8')).toBe('audio payload');

  const corrupt = JSON.parse(raw);
  corrupt.entries[0].data = 'AAAA';
  await expect(
    importScenario(JSON.stringify(corrupt), new RecordedScenarioStore(target), target),
  ).rejects.toThrow(/integrity|payload/);
  const escape = JSON.parse(raw);
  escape.entries[0].name = '../escape';
  await expect(
    importScenario(JSON.stringify(escape), new RecordedScenarioStore(target), target),
  ).rejects.toThrow(/Unsafe/);
  const pathAttack = JSON.parse(raw);
  pathAttack.metadata.sources[0].filename = '../../secret.mp4';
  await expect(
    importScenario(JSON.stringify(pathAttack), new RecordedScenarioStore(target), target),
  ).rejects.toThrow(/Unsafe|invalid/);
  const unsupported = JSON.parse(raw);
  unsupported.version = 99;
  await expect(
    importScenario(JSON.stringify(unsupported), new RecordedScenarioStore(target), target),
  ).rejects.toThrow(/Unsupported/);
});

it('round-trips multi-megabyte media entries without regex stack overflow', () => {
  const content = Buffer.alloc(4 * 1024 * 1024, 0xab);
  const archive = makeArchive('scenario', { version: 1 }, new Map([['media/clip.webm', content]]));
  expect(openArchive(archive, 'scenario').files.get('media/clip.webm')).toEqual(content);
  const altered = JSON.parse(archive);
  altered.entries[0].data = '*' + altered.entries[0].data.slice(1);
  expect(() => openArchive(JSON.stringify(altered), 'scenario')).toThrow(/payload/);
}, 15000);

function addAttempt(trace: InferenceTrace, runId: number, cycle: number): string {
  const input = {
    context: 'sensitive context',
    cycle,
    seed: 99,
    frames: [
      {
        sourceId: 'video',
        width: 4,
        height: 4,
        observedAt: 1000,
        dataUrl: 'data:image/jpeg;base64,' + fixtureJpeg.toString('base64'),
      },
    ],
    observations: [],
    recentTranscripts: [{ sourceId: 'mic', source: 'mic', text: 'hello', observedAt: 900 }],
    recentEvents: [],
    recentChat: [],
    roster: [],
    captureSelection: {
      observations: [],
      transcripts: [1],
      events: [],
      chat: [],
      frames: ['frame-1'],
    },
  } as unknown as InferenceInput;
  const id = trace.begin({
    runId,
    cycle,
    attempt: 1,
    seed: 99,
    rosterSeed: 44,
    mode: 'native',
    modelId: 'local',
    startedAt: 1000,
    input,
    settings: {},
    promptPreset: null,
    adaptation: {},
  });
  trace.update(id, { stage: 'transport', request: nativeChatRequest(input) });
  trace.update(id, {
    stage: 'scheduled',
    rawResponse: 'Sensitive output',
    normalized: { output: 'response' },
  });
  return id;
}

it('imports Compact Run evidence with an explicit current-builder provenance, never while recording is active', async () => {
  const source = await temp();
  const target = await temp();
  const recorder = new CompactInferenceRecorder(source);
  const trace = new InferenceTrace(24 * 1024 * 1024, 1);
  trace.attachRecorder(recorder);
  await recorder.configure(true);
  const attemptId = addAttempt(trace, 11, 1);
  await recorder.flush();
  const packageData = await recorder.exportRunEvidence(11);
  const imported = new CompactInferenceRecorder(target);
  await imported.configure(true);
  await expect(
    imported.importRunEvidence(11, packageData.recordings, packageData.files),
  ).rejects.toThrow(/Stop inference recording/);
  await imported.configure(false);
  const folders = await imported.importRunEvidence(11, packageData.recordings, packageData.files);
  expect(folders).toHaveLength(1);
  const restored = await imported.reconstruct(attemptId, folders[0]);
  expect(restored?.provenance).toBe('current-builder-reconstruction');
  expect(restored?.warning).toContain('not the byte-exact');
  const restoredInput = restored?.input as InferenceInput | undefined;
  expect(restoredInput?.recentTranscripts?.[0]?.text).toBe('hello');
});

it('round-trips a Run with exact requests, shared JPEGs and replies without leaking adjacent Run evidence', async () => {
  const root = await temp();
  const destination = await temp();
  const recorder = new CompactInferenceRecorder(root);
  const trace = new InferenceTrace(24 * 1024 * 1024, 1);
  trace.attachRecorder(recorder);
  await recorder.configure(true, 'exact');
  const first = addAttempt(trace, 3, 1);
  const second = addAttempt(trace, 3, 2);
  const foreign = addAttempt(trace, 4, 1);
  trace.closePresentation(3);
  await recorder.flush();
  const sourceRecordingId = recorder.status().recordingId!;
  await recorder.configure(false);
  await recorder.configure(true, 'exact');
  const reusedRunId = addAttempt(trace, 3, 99);
  await recorder.flush();
  const evidence = await recorder.exportRunEvidence(3, [sourceRecordingId]);
  expect(evidence.recordings).toHaveLength(1);
  expect([...evidence.files.keys()].filter((entry) => entry.endsWith('.jpg'))).toHaveLength(1);
  const importedSnapshot = {
    id: randomUUID(),
    scenarioId: null,
    name: 'Imported Run',
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    sessionRunId: 3,
    status: 'completed' as const,
    cycles: 2,
    error: null,
    effective: config(root),
    effectiveSettings: DEFAULT_PREFERENCES,
    effectiveModelId: 'local',
    effectivePreset: null,
    effectivePrompt: {
      context: 'sensitive context',
      chatActivity: DEFAULT_PREFERENCES.chatActivity,
    },
    effectiveSeed: 99,
  };
  const raw = makeArchive(
    'run',
    {
      run: portableRun(importedSnapshot),
      recordings: evidence.recordings,
    },
    evidence.files,
  );
  expect(raw).not.toContain(root);
  const unpacked = openArchive(raw, 'run');
  const meta = unpacked.metadata as { run: unknown; recordings: unknown };
  const restored = await restoreRun(meta.run, destination);
  const imported = new CompactInferenceRecorder(destination);
  const folders = await imported.importRunEvidence(3, meta.recordings, unpacked.files);
  expect(folders).toHaveLength(1);
  const saved = await new RecordedScenarioStore(destination).importRun(restored.run);
  expect(saved.id).not.toBe(importedSnapshot.id);
  expect(saved.effective.publishToOverlay).toBe(false);
  const cases = await imported.list();
  expect(cases.map((item) => item.id).sort()).toEqual([first, second].sort());
  expect(cases.some((entry) => entry.id === foreign || entry.id === reusedRunId)).toBe(false);
  const original = await recorder.reconstruct(first, sourceRecordingId);
  const recovered = await imported.reconstruct(first, folders[0]);
  expect(recovered?.provenance).toBe('exact-recorded-request');
  expect(recovered?.request).toEqual(original?.request);
  expect((await imported.restoreExactAttempt(first, folders[0])).rawResponse).toBe(
    'Sensitive output',
  );
  const corrupt = JSON.parse(raw);
  corrupt.entries[0].data = 'AAAA';
  expect(() => openArchive(JSON.stringify(corrupt), 'run')).toThrow();
  // A forged chunk with a rehashed archive still fails frame-metadata validation.
  const modified = new Map(unpacked.files);
  const evidencePart = (
    meta.recordings as Array<{
      folder: string;
      index: Array<{ type: string; chunk: string; sha256: string }>;
    }>
  )[0];
  const originalIndex = evidencePart.index.find((item) => item.type === 'attempt')!;
  const filename = evidencePart.folder + '/chunks/' + originalIndex.chunk;
  const rows = gunzipSync(modified.get(filename)!)
    .toString('utf8')
    .trim()
    .split('\n')
    .map(
      (line) =>
        JSON.parse(line) as {
          type: string;
          kind?: string;
          data?: { width?: number };
        },
    );
  rows.find((row) => row.type === 'evidence' && row.kind === 'frame')!.data!.width = 100000;
  const altered = gzipSync(rows.map((row) => JSON.stringify(row) + '\n').join(''));
  modified.set(filename, altered);
  const changedIndex = structuredClone(meta.recordings) as typeof meta.recordings;
  const amended = (changedIndex as (typeof evidencePart)[])[0].index.find(
    (row) => row.chunk === originalIndex.chunk,
  )!;
  amended.sha256 = archiveHash(altered);
  await expect(imported.importRunEvidence(3, changedIndex, modified)).rejects.toThrow(
    /frame metadata|dimensions/,
  );
  const framePath = [...unpacked.files.keys()].find((name) => name.endsWith('.jpg'))!;
  const tamperFrame = async (bytes: Buffer, width = 4, height = 4) => {
    const modifiedFiles = new Map(unpacked.files);
    modifiedFiles.delete(framePath);
    const replacedName = framePath.replace(/[^/]+$/, archiveHash(bytes) + '.jpg');
    modifiedFiles.set(replacedName, bytes);
    const rewritten = structuredClone(meta.recordings) as typeof meta.recordings;
    for (const part of rewritten as (typeof evidencePart)[]) {
      for (const row of part.index) {
        const chunkPath = part.folder + '/chunks/' + row.chunk;
        const chunkRows = gunzipSync(modifiedFiles.get(chunkPath)!)
          .toString('utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        let changed = false;
        for (const chunkRow of chunkRows) {
          if (chunkRow.type === 'evidence' && chunkRow.kind === 'frame') {
            chunkRow.data.jpeg = path.basename(replacedName);
            chunkRow.data.width = width;
            chunkRow.data.height = height;
            changed = true;
          }
        }
        if (changed) {
          const changedChunk = gzipSync(
            chunkRows.map((item) => JSON.stringify(item) + '\n').join(''),
          );
          modifiedFiles.set(chunkPath, changedChunk);
          row.sha256 = archiveHash(changedChunk);
        }
      }
    }
    return imported.importRunEvidence(3, rewritten, modifiedFiles);
  };
  await expect(tamperFrame(Buffer.from('not a JPEG'))).rejects.toThrow(/JPEG/);
  await expect(tamperFrame(fixtureJpeg, 1, 1)).rejects.toThrow(/dimensions/);
  // A valid compressed JPEG claiming an unsafe decoded width must not be accepted.
  const bogus = Buffer.from(fixtureJpeg);
  const sof = bogus.findIndex((value, index) => value === 0xff && bogus[index + 1] === 0xc0);
  expect(sof).toBeGreaterThan(0);
  bogus.writeUInt16BE(1000, sof + 7);
  await expect(tamperFrame(bogus)).rejects.toThrow(/dimensions/);
  const extra = new Map(unpacked.files);
  extra.set('other/stray', Buffer.from('bad'));
  await expect(imported.importRunEvidence(3, meta.recordings, extra)).rejects.toThrow(
    /unreferenced/,
  );
});
