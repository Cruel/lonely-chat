import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  RecordedScenarioStore,
  validateScenarioConfig,
  verifyRecordedSources,
} from './recorded-scenarios';
import { DEFAULT_PREFERENCES } from '../shared/session-contract';
import type { RecordedScenarioConfig } from '../shared/recorded-scenario-contract';

const roots: string[] = [];
const sample = (video: string, audio: string): RecordedScenarioConfig => ({
  context: 'Watch the scene',
  mode: 'native',
  video: { path: video, offsetMs: 0 },
  audio: [
    {
      id: 'mic',
      kind: 'file',
      path: audio,
      label: 'Mic',
      enabled: true,
      offsetMs: -125,
      embeddedTrackIndex: null,
    },
    {
      id: 'game',
      kind: 'video',
      path: null,
      label: 'Game sounds',
      enabled: false,
      offsetMs: 0,
      embeddedTrackIndex: 0,
    },
  ],
  segment: { startMs: 100, endMs: 3000 },
  transcriptMode: 'transcribe',
  publishToOverlay: false,
  seed: 412,
  presetId: null,
  presetRevision: null,
  modelId: 'installed-vlm',
  settingsSnapshot: { ...DEFAULT_PREFERENCES, cycleIntervalMs: 5000 },
  settingsPolicy: 'saved',
});
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lonely-scenarios-'));
  roots.push(root);
  const video = path.join(root, 'video.mp4');
  const audio = path.join(root, 'mic.wav');
  await Promise.all([writeFile(video, 'video'), writeFile(audio, 'audio')]);
  return { root, video, audio, store: new RecordedScenarioStore(root) };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

it('saves and reloads named Scenarios with exact media paths, audio offsets and explicit embedded audio selection', async () => {
  const { root, store, video, audio } = await setup();
  const config = sample(video, audio);
  await verifyRecordedSources(config);
  const saved = await store.save('Important scene', config);
  expect(saved.config).toEqual(config);
  const restarted = new RecordedScenarioStore(root);
  expect(await restarted.list()).toEqual([saved]);
  const bytes = await readFile(path.join(root, 'recorded-scenarios.json'), 'utf8');
  expect(JSON.parse(bytes)).toMatchObject({ scenarios: [{ config: { video: { path: video } } }] });
  expect(bytes).toContain('-125');
  expect(bytes).not.toContain('data:image/'); // only path metadata, not duplicated media data
});

it('persists signed video offsets and a live microphone source without treating a device as a file', async () => {
  const { store, video, audio } = await setup();
  const config = sample(video, audio);
  const updated = validateScenarioConfig({
    ...config,
    video: { path: video, offsetMs: -1300 },
    audio: [
      ...config.audio,
      {
        kind: 'device',
        id: 'device-source',
        label: 'Guest mic',
        path: null,
        deviceId: 'microphone-123',
        enabled: true,
        offsetMs: 500,
        embeddedTrackIndex: null,
      },
    ],
  });
  await verifyRecordedSources(updated);
  const saved = await store.save('With hardware', updated);
  expect(saved.config.video?.offsetMs).toBe(-1300);
  expect(saved.config.audio[2]).toMatchObject({ kind: 'device', deviceId: 'microphone-123' });
  expect(() =>
    validateScenarioConfig({
      ...updated,
      audio: updated.audio.map((item) =>
        item.kind === 'device' ? { ...item, deviceId: ' ' } : item,
      ),
    }),
  ).toThrow(/source definition/);
  expect(() =>
    validateScenarioConfig({
      ...updated,
      audio: updated.audio.map((item) =>
        item.kind === 'device' ? { ...item, path: '/not-a-file' } : item,
      ),
    }),
  ).toThrow(/source definition/);
});

it('preflight rejects missing enabled media, allows explicitly disabled sources and relinking', async () => {
  const { store, video, audio } = await setup();
  const config = sample(video, audio);
  const saved = await store.save('Relink me', config);
  await rm(audio);
  await expect(verifyRecordedSources(saved.config)).rejects.toThrow(
    /Relink it or explicitly disable/,
  );
  const disabled = {
    ...config,
    audio: config.audio.map((item) => (item.id === 'mic' ? { ...item, enabled: false } : item)),
  };
  await verifyRecordedSources(disabled);
  const replacement = path.join(path.dirname(audio), 'relinked.wav');
  await writeFile(replacement, 'new audio');
  const relinked = {
    ...config,
    audio: config.audio.map((item) => (item.id === 'mic' ? { ...item, path: replacement } : item)),
  };
  await verifyRecordedSources(relinked);
  const updated = await store.save('Relink me', relinked, saved.id);
  expect(updated.id).toBe(saved.id);
  expect(updated.config.audio[0].path).toBe(replacement);
});

it('blocks unsupported enabled containers before starting but ignores disabled invalid inputs', async () => {
  const { video, audio } = await setup();
  const config = sample(video, audio);
  const unsupported = {
    ...config,
    audio: config.audio.map((item) =>
      item.id === 'mic'
        ? { ...item, path: path.join(path.dirname(audio), 'unsupported.txt') }
        : item,
    ),
  };
  await expect(verifyRecordedSources(unsupported)).rejects.toThrow(
    /unsupported audio container.*Relink or disable/,
  );
  const ignored = {
    ...unsupported,
    audio: unsupported.audio.map((item) =>
      item.id === 'mic' ? { ...item, enabled: false } : item,
    ),
  };
  await verifyRecordedSources(ignored);
  await rm(video);
  await expect(verifyRecordedSources(ignored)).rejects.toThrow(
    /Video: source file is missing or unreadable/,
  );
});

it('creates separate immutable effective Run snapshots across edits, settings changes, deletes and restarts', async () => {
  const { root, store, video, audio } = await setup();
  const first = sample(video, audio);
  const original = await store.save('Test capture', first);
  const runInput = {
    scenarioId: original.id,
    name: original.name,
    sessionRunId: 11,
    effective: first,
    effectiveSettings: first.settingsSnapshot,
    effectiveModelId: first.modelId,
    effectivePreset: null,
    effectivePrompt: { context: first.context, chatActivity: first.settingsSnapshot.chatActivity },
    effectiveSeed: 412,
  };
  const a = await store.begin(runInput);
  const bConfig = { ...first, context: 'Revised', seed: 88, settingsPolicy: 'current' as const };
  const updated = await store.save('Test capture', bConfig, original.id);
  const b = await store.begin({
    ...runInput,
    sessionRunId: 12,
    effective: bConfig,
    effectiveSeed: 88,
    effectiveSettings: { ...DEFAULT_PREFERENCES, cycleIntervalMs: 1500 },
  });
  expect(a.id).not.toBe(b.id);
  await store.finish(a.id, 'completed', 4, null);
  await store.finish(b.id, 'failed', 1, 'decoder failed');
  await store.delete(updated.id);
  expect(await store.list()).toEqual([]);
  const reloaded = new RecordedScenarioStore(root);
  expect(await reloaded.runs()).toEqual([
    { ...a, status: 'completed', cycles: 4, endedAt: expect.any(String), error: null },
    { ...b, status: 'failed', cycles: 1, endedAt: expect.any(String), error: 'decoder failed' },
  ]);
  expect((await reloaded.runs())[0].effective).toEqual(first);
  expect((await reloaded.runs())[1].effective).toEqual(bConfig);
  expect((await reloaded.runs())[1].effectiveSettings.cycleIntervalMs).toBe(1500);
});

it('identifies an interrupted running Run after restart without modifying the original evidence', async () => {
  const { root, store, video, audio } = await setup();
  const config = sample(video, audio);
  const run = await store.begin({
    scenarioId: null,
    name: 'Ad hoc',
    sessionRunId: 1,
    effective: config,
    effectiveSettings: config.settingsSnapshot,
    effectiveModelId: config.modelId,
    effectivePreset: null,
    effectivePrompt: {
      context: config.context,
      chatActivity: config.settingsSnapshot.chatActivity,
    },
    effectiveSeed: 1,
  });
  expect((await store.runs())[0].status).toBe('running');
  expect((await new RecordedScenarioStore(root).runs())[0]).toMatchObject({
    id: run.id,
    status: 'interrupted',
    effective: config,
  });
});

it('rejects malformed Scenario data and never rewrites the source after invalid edits', async () => {
  const { store, video, audio } = await setup();
  const config = sample(video, audio);
  const original = await store.save('Valid', config);
  expect(() =>
    validateScenarioConfig({ ...config, audio: [{ ...config.audio[0], path: '../relative.wav' }] }),
  ).toThrow();
  expect(() =>
    validateScenarioConfig({ ...config, audio: [{ ...config.audio[0], offsetMs: 1.5 }] }),
  ).toThrow();
  expect(() =>
    validateScenarioConfig({ ...config, segment: { startMs: 4000, endMs: 100 } }),
  ).toThrow();
  await expect(
    store.save('Invalid', { ...config, settingsSnapshot: { cycleIntervalMs: -1 } }),
  ).rejects.toThrow();
  await expect(store.save('Valid', config)).rejects.toThrow(/unique/);
  expect(await store.list()).toEqual([original]);
});
