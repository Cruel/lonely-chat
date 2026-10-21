import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InferenceProfile } from '../shared/inference-profile-contract';
import type { RecordingPrivacy } from '../shared/compact-recording-contract';
import { CompactInferenceRecorder } from './compact-inference-recorder';
import { InferenceTrace } from './inference-trace';
import { ChatService } from './chat-service';
import { SessionController } from './session-controller';
import { FakeClock, flushMicrotasks } from './test-support/fake-clock';
import type { UnifiedInferenceAdapter } from './inference-coordinator';

const dirs: string[] = [];
async function fixture(privacy?: RecordingPrivacy, mode: 'exact' | 'compact' = 'exact') {
  const root = await mkdtemp(path.join(tmpdir(), 'lonely-stage-evidence-'));
  dirs.push(root);
  const recorder = new CompactInferenceRecorder(root);
  const trace = new InferenceTrace(24 * 1024 * 1024, 1);
  trace.attachRecorder(recorder);
  await recorder.configure(true, mode, false, privacy);
  return { root, recorder, trace };
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const jpeg = 'data:image/jpeg;base64,/9j/2Q==';
const input = {
  cycle: 1,
  context: 'private conversation',
  captureSelection: {
    observations: [],
    transcripts: [],
    events: [],
    chat: [],
    frames: ['cam:1200:0'],
  },
  frames: [{ sourceId: 'cam', observedAt: 1200, width: 1, height: 1, dataUrl: jpeg }],
  recentTranscripts: [],
  recentEvents: [],
  observations: [],
  recentChat: [],
};
function start(
  trace: InferenceTrace,
  role: 'vision' | 'chat' | 'memory',
  dependsOn: string[] = [],
) {
  return trace.begin({
    role,
    profileRevision: 7,
    observedAt: 1200,
    startedTimelineAt: 1000,
    sourceFrameIds: ['cam:1200:0'],
    observationRefs: ['transcript:mic:1190'],
    dependsOn,
    runId: 17,
    cycle: 1,
    attempt: 1,
    seed: 72,
    rosterSeed: 85,
    mode: 'remote',
    modelId: `${role}-model`,
    startedAt: 1250,
    input,
    settings: { maxTokens: 512 },
    promptPreset: null,
    adaptation: { topology: 'split' },
  });
}
const stageRequest = {
  role: 'vision',
  instructions: 'private instruction',
  content: [{ type: 'image', sourceId: 'cam', observedAt: 1200, dataUrl: jpeg }],
  response: { kind: 'json', schema: { type: 'object' } },
};

describe('private correlated multi-stage recording', () => {
  it('defaults to metadata-only but preserves identities, provenance, outcomes, cancellation, and presentation links', async () => {
    const { root, recorder, trace } = await fixture();
    const vision = start(trace, 'vision');
    trace.update(vision, {
      stage: 'accepted',
      availableAt: 1500,
      request: { ...stageRequest, authorization: 'Bearer secret-credential' },
      rawResponse: { sceneState: 'private winner' },
      accepted: { events: [{ summary: 'private winner' }], messages: [] },
    });
    const memory = start(trace, 'memory', [vision]);
    trace.update(memory, { stage: 'cancelled', error: 'sk-topsecretcredentialabc' });
    const chat = start(trace, 'chat', [vision, memory]);
    trace.update(chat, {
      stage: 'scheduled',
      availableAt: 1600,
      accepted: { events: [], messages: [{ text: 'private answer', author: 'viewer' }] },
    });
    trace.present(
      chat,
      { id: 'chat-123', author: 'viewer', text: 'private answer', presentedAt: 1750 },
      0,
    );
    trace.closePresentation(17);
    await recorder.configure(false);
    await recorder.flush();
    const recordingId = recorder.status().recordingId!;
    const opened = new CompactInferenceRecorder(root);
    const items = await opened.list();
    expect(items.map((item) => item.role)).toEqual(['vision', 'memory', 'chat']);
    expect(items[0]).toMatchObject({
      profileRevision: 7,
      sourceFrameIds: ['cam:1200:0'],
      observedAt: 1200,
      availableAt: 1500,
    });
    expect(items[2].dependsOn).toEqual([vision, memory]);
    const visionRecord = await opened.reconstruct(vision, recordingId);
    expect(visionRecord?.provenance).toBe('metadata-only');
    expect(visionRecord?.request).toBeNull();
    expect(visionRecord?.input).toMatchObject({
      context: '[content omitted]',
      frames: [{ mediaOmitted: true, sourceId: 'cam' }],
    });
    expect(visionRecord?.outcome).toMatchObject({
      stage: 'accepted',
      accepted: { events: [{ summary: '[content omitted]' }] },
    });
    const chatRecord = await opened.reconstruct(chat, recordingId);
    expect(chatRecord?.outcome).toMatchObject({
      stage: 'scheduled',
      presented: [{ id: 'chat-123', text: '[content omitted]' }],
      presentationClosed: true,
    });
    expect(await readdir(path.join(root, 'compact-inference', recordingId, 'frames'))).toEqual([]);
    const chunks = (
      await readdir(path.join(root, 'compact-inference', recordingId, 'chunks'))
    ).join('');
    expect(chunks).not.toContain('private answer');
    const raw = await Promise.all(
      (await readdir(path.join(root, 'compact-inference', recordingId, 'chunks'))).map((file) =>
        readFile(path.join(root, 'compact-inference', recordingId, 'chunks', file)).then((buf) =>
          gunzipSync(buf).toString('utf8'),
        ),
      ),
    );
    expect(raw.join('')).not.toMatch(
      /private winner|private answer|secret-credential|sk-topsecretcredentialabc|private instruction|\/9j\/2Q/,
    );
  });

  it.each([
    [{ retainMedia: true, retainContent: false }, true, false],
    [{ retainMedia: false, retainContent: true }, false, true],
    [{ retainMedia: true, retainContent: true }, true, true],
  ] as const)('honors independent media/content consent (%j)', async (privacy, media, content) => {
    const { root, recorder, trace } = await fixture(privacy);
    const vision = start(trace, 'vision');
    trace.update(vision, {
      stage: 'accepted',
      request: stageRequest,
      accepted: { events: [{ summary: 'private winner' }], messages: [] },
    });
    await recorder.flush();
    const recordingId = recorder.status().recordingId!;
    const saved = await new CompactInferenceRecorder(root).reconstruct(vision, recordingId);
    const frames = await readdir(path.join(root, 'compact-inference', recordingId, 'frames'));
    expect(frames.length).toBe(media ? 1 : 0);
    expect(JSON.stringify(saved?.outcome)).toContain(
      content ? 'private winner' : '[content omitted]',
    );
    if (media && content) {
      expect(saved?.provenance).toBe('exact-recorded-request');
      expect(saved?.request).toEqual(stageRequest);
    } else {
      expect(saved?.provenance).toBe('metadata-only');
      expect(saved?.request).toBeNull();
    }
  });

  it('routes independent Vision/Chat/memory production traces into durable stage evidence', async () => {
    const { root, recorder, trace } = await fixture({ retainMedia: false, retainContent: true });
    const clock = new FakeClock();
    const session = new SessionController(
      new ChatService(),
      undefined,
      clock,
      { cycleIntervalMs: 1500 },
      undefined,
      undefined,
      undefined,
      undefined,
      trace,
    );
    const profile: InferenceProfile = {
      id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      name: 'Evidence profile',
      revision: 4,
      values: {
        topology: 'split',
        roles: {
          observer: { kind: 'remote', modelId: 'vision' },
          chat: { kind: 'remote', modelId: 'chat' },
          memory: { kind: 'remote', modelId: 'memory' },
        },
        stageDefaults: {},
        memory: { enabled: true, intervalMs: 0, maxCharacters: 500, expireAfterMs: 0 },
        architecture: {
          execution: 'sequential',
          hybridMaxImages: 0,
          visionIntervalMs: 100,
          chatIntervalMs: 1500,
          maximumWaitMs: 1000,
          maximumAgeMs: 5000,
          strictWait: false,
        },
      },
    };
    const adapter = (value: unknown): UnifiedInferenceAdapter => ({
      capabilities: { images: true },
      complete: vi.fn(async () => ({ raw: value, normalized: value })),
    });
    const vision = adapter({
      sceneState: 'Alice wins',
      events: [{ kind: 'reaction', summary: 'Win', ageMs: 0 }],
      messages: [],
    });
    const chat = adapter({
      events: [{ kind: 'context', summary: 'Alice celebrated', ageMs: 0 }],
      messages: [],
    });
    const memory = adapter({ summary: 'Alice won her championship' });
    session.configureSplit(() => ({ vision, chat, memory }), false);
    session.start(
      'A racing event',
      'remote',
      'chat',
      { inputMode: 'live', publishToOverlay: true },
      undefined,
      undefined,
      profile,
    );
    await flushMicrotasks();
    await flushMicrotasks();
    session.stop();
    await recorder.flush();
    const entries = await new CompactInferenceRecorder(root).list();
    expect(entries.map((entry) => entry.role).sort()).toEqual(['chat', 'memory', 'vision']);
    expect(entries.every((entry) => entry.profileRevision === 4)).toBe(true);
    const visionEntry = entries.find((entry) => entry.role === 'vision')!;
    const chatEntry = entries.find((entry) => entry.role === 'chat')!;
    expect(chatEntry.dependsOn).toContain(visionEntry.id);
    expect(
      (await recorder.reconstruct(visionEntry.id, recorder.status().recordingId!))?.outcome,
    ).toMatchObject({ stage: 'accepted' });
  });

  it('deduplicates hybrid Chat-only frames and reconstructs their exact request after restart', async () => {
    const { root, recorder, trace } = await fixture({ retainMedia: true, retainContent: true });
    const chatJpeg = 'data:image/jpeg;base64,/9j/2g==';
    const hybridInput = {
      ...input,
      chatFrames: [
        { sourceId: 'chat-cam', observedAt: 1270, width: 1, height: 1, dataUrl: chatJpeg },
      ],
      captureSelection: { ...input.captureSelection, chatFrames: ['chat-cam:1270:0'] },
    };
    const request = {
      ...stageRequest,
      role: 'chat',
      content: [{ type: 'image', dataUrl: chatJpeg, sourceId: 'chat-cam', observedAt: 1270 }],
    };
    const first = trace.begin({
      role: 'chat',
      runId: 17,
      cycle: 1,
      attempt: 1,
      seed: 72,
      rosterSeed: 85,
      mode: 'remote',
      modelId: 'chat-model',
      startedAt: 1300,
      input: hybridInput,
      profileRevision: 7,
      observedAt: 1270,
      sourceFrameIds: ['cam:1200:0', 'chat-cam:1270:0'],
      dependsOn: [],
      settings: {},
      promptPreset: null,
      adaptation: {},
    });
    trace.update(first, { stage: 'scheduled', request, scheduled: { messages: [], events: [] } });
    const second = trace.begin({
      role: 'chat',
      runId: 17,
      cycle: 2,
      attempt: 1,
      seed: 82,
      rosterSeed: 95,
      mode: 'remote',
      modelId: 'chat-model',
      startedAt: 1450,
      input: hybridInput,
      profileRevision: 7,
      observedAt: 1270,
      sourceFrameIds: ['cam:1200:0', 'chat-cam:1270:0'],
      dependsOn: [first],
      settings: {},
      promptPreset: null,
      adaptation: {},
    });
    trace.update(second, { stage: 'scheduled', request, scheduled: { messages: [], events: [] } });
    await recorder.configure(false);
    await recorder.flush();
    const archiveId = recorder.status().recordingId!;
    const folder = path.join(root, 'compact-inference', archiveId);
    expect(await readdir(path.join(folder, 'frames'))).toHaveLength(2);
    const reopened = new CompactInferenceRecorder(root);
    const rebuilt = await reopened.reconstruct(second, archiveId);
    expect(rebuilt?.input).toMatchObject({
      chatFrames: [{ sourceId: 'chat-cam', observedAt: 1270, dataUrl: chatJpeg }],
    });
    expect(rebuilt?.request).toEqual(request);
    expect(rebuilt?.provenance).toBe('exact-recorded-request');
  });

  it('keeps retry attempts independent and freezes admission details before later mutations', async () => {
    const { root, recorder, trace } = await fixture({ retainMedia: true, retainContent: true });
    const original = start(trace, 'vision');
    trace.update(original, {
      stage: 'failed',
      error: 'provider unavailable',
      request: stageRequest,
    });
    const retryInput = { ...input, context: 'retry scene', frames: [...input.frames] };
    const retry = trace.begin({
      role: 'vision',
      runId: 17,
      cycle: 1,
      attempt: 2,
      seed: 73,
      rosterSeed: 85,
      mode: 'remote',
      modelId: 'vision-model',
      startedAt: 1800,
      profileRevision: 7,
      observedAt: 1200,
      sourceFrameIds: ['cam:1200:0'],
      dependsOn: [original],
      input: retryInput,
      settings: { maxTokens: 1024 },
      promptPreset: null,
      adaptation: { topology: 'split' },
    });
    retryInput.context = 'changed after admission';
    trace.update(retry, {
      stage: 'accepted',
      request: stageRequest,
      accepted: { events: [{ summary: 'retry result' }], messages: [] },
    });
    await recorder.flush();
    const reloaded = new CompactInferenceRecorder(root);
    const list = await reloaded.list();
    expect(list).toHaveLength(2);
    expect(list.map((entry) => entry.attempt)).toEqual([1, 2]);
    expect(list[1].dependsOn).toEqual([original]);
    const archiveId = recorder.status().recordingId!;
    expect((await reloaded.reconstruct(original, archiveId))?.outcome).toMatchObject({
      stage: 'failed',
    });
    const later = await reloaded.reconstruct(retry, archiveId);
    expect(later?.input).toMatchObject({ context: 'retry scene' });
    expect(later?.request).toEqual(stageRequest);
    expect(later?.outcome).toMatchObject({ stage: 'accepted' });
    expect(await readdir(path.join(root, 'compact-inference', archiveId, 'frames'))).toHaveLength(
      1,
    );
  });

  it('preserves finalized stage snapshots after queued writes and removes expired archives', async () => {
    const { root, recorder, trace } = await fixture();
    const id = start(trace, 'vision');
    await recorder.configure(false);
    trace.update(id, { stage: 'accepted', accepted: { events: [], messages: [] } });
    await recorder.flush();
    const oldId = recorder.status().recordingId!;
    await recorder.configure(true, 'exact');
    expect((await recorder.reconstruct(id, oldId))?.outcome).toMatchObject({ stage: 'accepted' });
    await recorder.configure(false);
    await recorder.flush();
    const folder = path.join(root, 'compact-inference', oldId);
    const manifest = JSON.parse(
      await readFile(path.join(folder, 'manifest.json'), 'utf8'),
    ) as Record<string, unknown>;
    manifest.createdAt = '2022-01-01T00:00:00.000Z';
    await writeFile(path.join(folder, 'manifest.json'), JSON.stringify(manifest));
    await recorder.setLimits({ diskBytes: 1024 ** 3, memoryBytes: 64 * 1024 ** 2, maxAgeDays: 1 });
    expect(await readdir(path.join(root, 'compact-inference'))).not.toContain(oldId);
  });

  it('rejects forged archive payloads even when the attacker recomputes the chunk digest', async () => {
    const { root, recorder, trace } = await fixture({ retainMedia: false, retainContent: true });
    const id = start(trace, 'memory');
    trace.update(id, { stage: 'accepted', accepted: { summary: 'Okay' } });
    await recorder.flush();
    const folder = path.join(root, 'compact-inference', recorder.status().recordingId!);
    const indexFile = path.join(folder, 'index.jsonl');
    const index = (await readFile(indexFile, 'utf8')).trim().split('\n');
    const rows = index.map((line) => JSON.parse(line) as Record<string, unknown>);
    const selected = rows.find((row) => row.type === 'attempt')!;
    const chunkFile = path.join(folder, 'chunks', selected.chunk as string);
    const payload = gunzipSync(await readFile(chunkFile))
      .toString('utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const attempt = payload.find((row) => row.type === 'attempt')!;
    (attempt.details as Record<string, unknown>).authorization = 'Bearer stolen-secret';
    const bytes = gzipSync(payload.map((row) => JSON.stringify(row) + '\n').join(''));
    await writeFile(chunkFile, bytes);
    selected.sha256 = createHash('sha256').update(bytes).digest('hex');
    await writeFile(indexFile, rows.map((row) => JSON.stringify(row) + '\n').join(''));
    await expect(
      new CompactInferenceRecorder(root).reconstruct(id, recorder.status().recordingId!),
    ).rejects.toThrow(/credentials/);
  });
});
