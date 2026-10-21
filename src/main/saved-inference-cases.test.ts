import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SavedInferenceCases } from './saved-inference-cases';
import { PlaygroundService } from './playground-service';
import { nativeChatRequest } from './native-inference';
import { AUDIENCE } from './fake-inference';
import type { TraceAttempt } from '../shared/inference-trace-contract';

const image =
  'data:image/jpeg;base64,' +
  readFileSync(new URL('../../tests/fixtures/playground-red.jpg', import.meta.url)).toString(
    'base64',
  );
const frame = {
  sourceId: 'recorded:video',
  observedAt: 1700000000420,
  mediaTimeMs: 420,
  width: 4,
  height: 4,
  dataUrl: image,
};
const input = {
  context: 'campfire',
  cycle: 2,
  seed: 42,
  recentTranscripts: [
    { source: 'mic', sourceId: 'voice-1', text: 'fire!', observedAt: 1700000000300 },
  ],
  recentEvents: [{ kind: 'context' as const, summary: 'campfire', observedAt: 1700000000300 }],
  recentChat: [{ author: 'pixelpilot', text: 'hello', presentedAt: 1700000000200 }],
  observations: [],
  frames: [frame],
  roster: AUDIENCE,
  chatActivity: 'normal' as const,
  boundary: {
    fromSequence: 1,
    throughSequence: 3,
    fromMs: 1700000000000,
    throughMs: 1700000001000,
  },
  videoWindow: { fromMs: 1700000000000, throughMs: 1700000001000, truncated: false },
  playbackWindowMs: 3000,
  captureSelection: {
    observations: [],
    transcripts: [2],
    chat: ['chat-1'],
    events: [],
    frames: ['recorded:video:1700000000420:0'],
  },
};
const originalRequest = nativeChatRequest(input);
const attempt: TraceAttempt = {
  id: 'attempt-7',
  runId: 1,
  cycle: 2,
  attempt: 1,
  mode: 'native',
  modelId: 'installed-vision',
  seed: 42,
  rosterSeed: 4,
  startedAt: 1700000001000,
  durationMs: 40,
  stage: 'scheduled',
  error: null,
  errorStage: null,
  usage: null,
  input,
  request: originalRequest,
  settings: {},
  promptPreset: null,
  adaptation: {},
  rawResponse: null,
  normalized: null,
  parsed: null,
  accepted: null,
  scheduled: null,
  transportError: null,
};
const roots: string[] = [];
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lonely-case-'));
  roots.push(root);
  return { root, cases: new SavedInferenceCases(root) };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('immutable exact inference cases', () => {
  it('round-trips exact submitted request, original source selection and binary images across restart and import', async () => {
    const { root, cases } = await setup();
    const saved = await cases.save({
      ...attempt, role: 'chat', profileRevision: 3,
      observedAt: 1700000000420, availableAt: 1700000001040,
      dependsOn: ['attempt-8'], sourceFrameIds: ['recorded:video:1700000000420:0'],
      observationRefs: ['transcript:voice-1:1700000000300'],
    });
    expect(saved).toMatchObject({ modelId: 'installed-vision', seed: 42, frameCount: 1 });
    const store = new SavedInferenceCases(root);
    expect((await store.list()).map((item) => item.id)).toEqual([saved.id]);
    const copy = await store.get(saved.id);
    expect(copy.request).not.toEqual(originalRequest); // privacy-safe image references in JSON
    expect(copy.input).toMatchObject({
      captureSelection: input.captureSelection,
      recentTranscripts: input.recentTranscripts,
    });
    expect(copy.sourceResult).toMatchObject({
      stage: 'scheduled',
      durationMs: 40,
      rawNativeOutput: null,
      normalizedResult: null,
      parsedResult: null,
      accepted: null,
      usage: null,
      role: 'chat', profileRevision: 3,
      observedAt: 1700000000420, availableAt: 1700000001040,
      dependsOn: ['attempt-8'],
      sourceFrameIds: ['recorded:video:1700000000420:0'],
      observationRefs: ['transcript:voice-1:1700000000300'],
    });
    expect(copy.frames[0]).toMatchObject({
      sourceId: frame.sourceId,
      mediaTimeMs: 420,
      dataUrl: image,
    });
    const contents = await readFile(
      path.join(root, 'saved-inference-cases', saved.id, 'case.json'),
      'utf8',
    );
    expect(contents).not.toContain(image.slice(35)); // encoded bytes stored in separate binary asset
    expect(
      (await readdir(path.join(root, 'saved-inference-cases', saved.id))).some((item) =>
        item.endsWith('.jpg'),
      ),
    ).toBe(true);
    const archive = await store.exportPortable(saved.id);
    const imported = await store.importPortable(archive);
    expect(imported.id).not.toBe(saved.id);
    expect((await store.get(imported.id)).request).toEqual(copy.request);
    expect((await store.get(imported.id)).sourceResult).toEqual(copy.sourceResult);
    expect((await store.get(imported.id)).frames[0].dataUrl).toEqual(image);
    expect((await store.list()).map((item) => item.id)).toHaveLength(2);
  });

  it('accepts larger exact JPEG evidence and round-trips it as a saved case', async () => {
    const { cases } = await setup();
    const original = Buffer.from(image.slice('data:image/jpeg;base64,'.length), 'base64');
    const payload = Buffer.alloc(65_000, 0);
    const app = Buffer.alloc(4);
    app[0] = 0xff;
    app[1] = 0xe1;
    app.writeUInt16BE(payload.length + 2, 2);
    const jpeg = Buffer.concat([
      original.subarray(0, 2),
      app,
      payload,
      app,
      payload,
      original.subarray(2),
    ]);
    const large = 'data:image/jpeg;base64,' + jpeg.toString('base64');
    expect(large.length).toBeGreaterThan(120_000);
    const inputWithFrame = { ...input, frames: [{ ...frame, dataUrl: large }] };
    const stored = await cases.save({
      ...attempt,
      input: inputWithFrame,
      request: nativeChatRequest(inputWithFrame),
    });
    expect((await cases.get(stored.id)).frames[0].dataUrl).toEqual(large);
    const copy = await cases.importPortable(await cases.exportPortable(stored.id));
    expect((await cases.get(copy.id)).frames[0].dataUrl).toEqual(large);
  });

  it('rejects injected private fields in exact case imports without changing existing evidence', async () => {
    const { cases } = await setup();
    const saved = await cases.save(attempt);
    const archive = JSON.parse(await cases.exportPortable(saved.id));
    archive.manifest.sourceResult.privateCredential = 'must-never-persist';
    await expect(cases.importPortable(JSON.stringify(archive))).rejects.toThrow(
      /Unsupported saved case outcome evidence field/,
    );
    delete archive.manifest.sourceResult.privateCredential;
    archive.manifest.remoteConnection = { token: 'must-never-persist' };
    await expect(cases.importPortable(JSON.stringify(archive))).rejects.toThrow(
      /Unsupported saved case metadata field/,
    );
    expect((await cases.get(saved.id)).sourceResult.stage).toBe(attempt.stage);
    expect(await cases.list()).toHaveLength(1);
  });

  it('rejects obsolete saved cases missing required original outcome evidence', async () => {
    const { root, cases } = await setup();
    const saved = await cases.save(attempt);
    const file = path.join(root, 'saved-inference-cases', saved.id, 'case.json');
    const manifest = JSON.parse(await readFile(file, 'utf8'));
    delete manifest.sourceResult;
    await writeFile(file, JSON.stringify(manifest));
    await expect(new SavedInferenceCases(root).get(saved.id)).rejects.toThrow(/source result/i);
  });

  it('executes a fork with exact captured input and edited seed/prompt/schema while preserving immutable original', async () => {
    const { root, cases } = await setup();
    const saved = await cases.save(attempt);
    const original = await cases.get(saved.id);
    const draft = structuredClone(original.request) as typeof originalRequest;
    draft.seed = 99;
    draft.temperature = 0.2;
    draft.messages[0].content = 'Different instructions';
    const provider = {
      completeFreeform: vi.fn(),
      completeSimulationRequest: vi.fn(async () => ({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({
                events: [],
                messages: [{ author: 'pixelpilot', text: 'Okay', offsetMs: 100 }],
              }),
            },
          },
        ],
      })),
      stop: vi.fn(async () => {}),
    };
    const playground = new PlaygroundService(
      () => true,
      () => provider,
    );
    const outcome = await playground.runSavedCase(
      {
        caseId: saved.id,
        modelId: 'installed-vision',
        rawRequestJson: JSON.stringify(draft),
        frameIndices: [0],
      },
      cases,
    );
    expect(outcome.result.errorStage).toBeNull();
    const [effectiveInput, exactRequest] = provider.completeSimulationRequest.mock
      .calls[0] as unknown as [typeof input, typeof originalRequest];
    expect(effectiveInput.recentTranscripts).toEqual(input.recentTranscripts);
    expect(effectiveInput.boundary).toEqual(input.boundary);
    expect(effectiveInput.captureSelection).toEqual(input.captureSelection);
    expect(effectiveInput.frames?.[0].dataUrl).toBe(image);
    expect(effectiveInput.seed).toBe(99);
    expect(exactRequest.messages[0].content).toBe('Different instructions');
    expect(exactRequest.messages[1]).toEqual({ ...originalRequest.messages[1] });
    expect(exactRequest.response_format).toEqual(originalRequest.response_format);
    expect(outcome.child.parentCaseId).toBe(saved.id);
    expect(outcome.child.frameIndices).toEqual([0]);
    expect(outcome.child.outcome?.accepted).toEqual(outcome.result.accepted);
    expect((await new SavedInferenceCases(root).get(saved.id)).request).toEqual(original.request);
    expect((await new SavedInferenceCases(root).get(saved.id)).children[0]).toMatchObject({
      id: outcome.child.id,
      frameIndices: [0],
    });
  });

  it('persists failed original attempts with their unmodified response, parsed events and errors', async () => {
    const { root, cases } = await setup();
    const saved = await cases.save({
      ...attempt,
      stage: 'failed',
      errorStage: 'validation',
      error: 'Invalid chatter',
      usage: { promptTokens: 9, completionTokens: 3, totalTokens: 12 },
      rawResponse: { choices: [{ message: { content: '{bad}' } }] },
      normalized: { events: [{ kind: 'reaction', summary: 'oops' }] },
      parsed: { events: [{ kind: 'reaction', summary: 'oops' }] },
      accepted: null,
      transportError: null,
    });
    const result = (await new SavedInferenceCases(root).get(saved.id)).sourceResult;
    expect(result).toMatchObject({
      stage: 'failed',
      errorStage: 'validation',
      error: 'Invalid chatter',
      rawNativeOutput: { choices: [{ message: { content: '{bad}' } }] },
      parsedResult: { events: [{ kind: 'reaction', summary: 'oops' }] },
      usage: { totalTokens: 12 },
    });
  });

  it('explicitly omits oversized source outcomes and validates persisted result metadata', async () => {
    const { cases } = await setup();
    const saved = await cases.save({ ...attempt, rawResponse: { text: 'x'.repeat(2_200_000) } });
    const original = await cases.get(saved.id);
    expect(original.sourceResult?.omitted).toMatch(/2 MiB/);
    expect(original.sourceResult?.rawNativeOutput).toBeNull();
    const archive = JSON.parse(await cases.exportPortable(saved.id));
    archive.manifest.sourceResult.stage = 'invented';
    await expect(cases.importPortable(JSON.stringify(archive))).rejects.toThrow(/source result/);
    expect((await cases.get(saved.id)).sourceResult).toEqual(original.sourceResult);
  });

  it('supports no-frame cases and deliberately excluding all frames for a new child', async () => {
    const { cases } = await setup();
    const saved = await cases.save(attempt);
    const original = await cases.get(saved.id);
    const prepared = await cases.prepareFork({
      caseId: saved.id,
      modelId: saved.modelId,
      rawRequestJson: JSON.stringify(original.request),
      frameIndices: [],
    });
    expect(prepared.input.frames).toEqual([]);
    expect((prepared.submitted as typeof originalRequest).messages[1].content).toBe(
      (originalRequest.messages[1].content as Array<{ type: string; text?: string }>)[0].text,
    );
    const noFrameInput = { ...input, frames: [] };
    const plain = await cases.save({
      ...attempt,
      input: noFrameInput,
      request: nativeChatRequest(noFrameInput),
    });
    expect((await cases.get(plain.id)).frames).toHaveLength(0);
  });

  it('preserves frame selection fidelity when excluding a frame from a multi-image request', async () => {
    const { cases } = await setup();
    const blue =
      'data:image/jpeg;base64,' +
      readFileSync(new URL('../../tests/fixtures/playground-blue.jpg', import.meta.url)).toString(
        'base64',
      );
    const nextFrame = {
      ...frame,
      sourceId: 'recorded:video:2',
      observedAt: frame.observedAt + 100,
      mediaTimeMs: 520,
      dataUrl: blue,
    };
    const twoFrames = { ...input, frames: [frame, nextFrame] };
    const saved = await cases.save({
      ...attempt,
      input: twoFrames,
      request: nativeChatRequest(twoFrames),
    });
    const detail = await cases.get(saved.id);
    const prepared = await cases.prepareFork({
      caseId: saved.id,
      modelId: saved.modelId,
      rawRequestJson: JSON.stringify(detail.request),
      frameIndices: [1],
    });
    expect(prepared.input.frames?.map((item) => item.sourceId)).toEqual(['recorded:video:2']);
    const request = prepared.submitted as typeof originalRequest;
    const content = request.messages[1].content as Array<{
      type: string;
      text?: string;
      image_url?: { url: string };
    }>;
    expect(content.filter((part) => part.type === 'image_url')).toEqual([
      { type: 'image_url', image_url: { url: blue } },
    ]);
    expect(JSON.stringify(content)).not.toContain(image.slice(25));
    expect(content.some((part) => part.text?.startsWith('Visual frame 1,'))).toBe(false);
    expect((await cases.get(saved.id)).frames).toHaveLength(2);
  });

  it('exports and imports frozen child experiment results without changing the immutable source', async () => {
    const { root, cases } = await setup();
    const original = await cases.save(attempt);
    const detail = await cases.get(original.id);
    const child = {
      id: randomUUID(),
      parentCaseId: original.id,
      createdAt: new Date().toISOString(),
      modelId: 'forked-model',
      seed: 42,
      errorStage: null,
      error: null,
      durationMs: 55,
      frameIndices: [0],
      outcome: {
        submittedRequest: detail.request,
        rawNativeOutput: { content: 'child response' },
        normalizedResult: { content: 'child response' },
        parsedResult: null,
        accepted: { chat: ['hello'] },
        usage: null,
      },
    };
    await writeFile(
      path.join(root, 'saved-inference-cases', original.id, 'child-' + child.id + '.json'),
      JSON.stringify(child),
    );
    const archive = await cases.exportPortable(original.id);
    const imported = await cases.importPortable(archive);
    const roundtrip = await cases.get(imported.id);
    expect(roundtrip.children).toHaveLength(1);
    expect(roundtrip.children[0]).toMatchObject({
      parentCaseId: imported.id,
      frameIndices: [0],
      outcome: child.outcome,
    });
    expect(roundtrip.children[0].id).not.toBe(child.id);
    expect((await cases.get(original.id)).children[0].id).toBe(child.id);
    const tampered = JSON.parse(archive);
    tampered.children[0].parentCaseId = '../other';
    await expect(cases.importPortable(JSON.stringify(tampered))).rejects.toThrow(
      /Corrupt imported case child/,
    );
    tampered.children[0].parentCaseId = original.id;
    delete tampered.children[0].outcome;
    await expect(cases.importPortable(JSON.stringify(tampered))).rejects.toThrow(
      /Corrupt imported case child|Invalid imported child/,
    );
    tampered.children[0].outcome = child.outcome;
    delete tampered.children[0].frameIndices;
    await expect(cases.importPortable(JSON.stringify(tampered))).rejects.toThrow(
      /Corrupt imported case child/,
    );
    tampered.children[0].frameIndices = [0];
    tampered.children[0].connectionSecret = 'private-token';
    await expect(cases.importPortable(JSON.stringify(tampered))).rejects.toThrow(
      /Corrupt imported case child/,
    );
    delete tampered.children[0].connectionSecret;
    tampered.children[0].errorStage = 'unknown';
    await expect(cases.importPortable(JSON.stringify(tampered))).rejects.toThrow(
      /Corrupt imported case child/,
    );
  });

  it('rejects incomplete/interrupted attempts and missing model, seed, or selected media instead of saving partial archives', async () => {
    const { cases } = await setup();
    await expect(cases.save({ ...attempt, mode: 'fake' })).rejects.toThrow(/native/);
    await expect(cases.save({ ...attempt, request: null, stage: 'cancelled' })).rejects.toThrow();
    await expect(cases.save({ ...attempt, modelId: null })).rejects.toThrow(/model identity/);
    await expect(
      cases.save({ ...attempt, request: { ...originalRequest, seed: undefined } }),
    ).rejects.toThrow(/seed/);
    await expect(
      cases.save({ ...attempt, input: { ...input, frames: [{ ...frame, dataUrl: undefined }] } }),
    ).rejects.toThrow();
    expect(await cases.list()).toEqual([]);
  });

  it('rejects malformed imports, tampered bytes, invalid schema and unsafe case IDs', async () => {
    const { root, cases } = await setup();
    const saved = await cases.save(attempt);
    const portable = JSON.parse(await cases.exportPortable(saved.id));
    const invalid = structuredClone(portable);
    const hash = Object.keys(invalid.images)[0];
    invalid.images[hash] = 'AAAA';
    await expect(cases.importPortable(JSON.stringify(invalid))).rejects.toThrow();
    const schema = structuredClone(portable);
    schema.manifest.request.response_format.schema = null;
    await expect(cases.importPortable(JSON.stringify(schema))).rejects.toThrow(/response schema/);
    await expect(cases.get('../secret')).rejects.toThrow(/ID/);
    const contents = await readFile(
      path.join(root, 'saved-inference-cases', saved.id, 'case.json'),
      'utf8',
    );
    const tampered = JSON.parse(contents);
    tampered.summary.modelId = '';
    await writeFile(
      path.join(root, 'saved-inference-cases', saved.id, 'case.json'),
      JSON.stringify(tampered),
    );
    await expect(cases.get(saved.id)).rejects.toThrow();
    expect(await cases.list()).toEqual([]);
  });

  it('serializes concurrent saves at the case limit rather than allowing quota races', async () => {
    const { cases } = await setup();
    const results = await Promise.allSettled(
      Array.from({ length: 101 }, () => cases.save(attempt)),
    );
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(100);
    expect(results.filter((item) => item.status === 'rejected')).toHaveLength(1);
    expect(await cases.list()).toHaveLength(100);
  });

  it('rejects oversized case evidence instead of silently truncating or evicting saved cases', async () => {
    const { cases } = await setup();
    const saved = await cases.save(attempt);
    await expect(
      cases.save({
        ...attempt,
        input: {
          ...input,
          frames: [{ ...frame, dataUrl: 'data:image/jpeg;base64,' + 'A'.repeat(3_000_000) }],
        },
      }),
    ).rejects.toThrow();
    expect((await cases.list()).map((item) => item.id)).toEqual([saved.id]);
  });
});
