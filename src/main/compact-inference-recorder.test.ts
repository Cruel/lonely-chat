import { afterEach, describe, expect, it } from 'vitest';
import { appendFile, mkdtemp, readFile, readdir, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { CompactInferenceRecorder } from './compact-inference-recorder';
import { InferenceTrace } from './inference-trace';
import { InferenceHistory } from './inference-history';
import { SavedInferenceCases } from './saved-inference-cases';
import { nativeChatRequest } from './native-inference';
import type { InferenceInput } from './fake-inference';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'lonely-compact-'));
  roots.push(root);
  const recorder = new CompactInferenceRecorder(root);
  const trace = new InferenceTrace(24 * 1024 * 1024, 1);
  trace.attachRecorder(recorder);
  return { root, recorder, trace };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const jpeg = 'data:image/jpeg;base64,/9j/2Q==';
function start(trace: InferenceTrace, cycle = 1, inputOverride: Record<string, unknown> = {}) {
  return trace.begin({
    runId: 3,
    cycle,
    attempt: 1,
    seed: 42 + cycle,
    rosterSeed: 22,
    mode: 'native',
    modelId: 'model',
    startedAt: 1000,
    input: {
      context: 'gameplay',
      cycle,
      seed: 42 + cycle,
      boundary: { fromSequence: 0, throughSequence: 2, fromMs: 500, throughMs: 1000 },
      captureSelection: {
        observations: [2],
        transcripts: [1],
        events: ['event-1', 'event-2'],
        chat: ['chat-1'],
        frames: ['screen:1000:0'],
      },
      observations: [{ source: 'screen', kind: 'visual', description: 'boom', observedAt: 1000 }],
      recentTranscripts: [{ sourceId: 'mic', source: 'Mic', text: 'go!', observedAt: 900 }],
      recentEvents: [
        { kind: 'context', summary: 'first', observedAt: 800 },
        { kind: 'reaction', summary: 'second', observedAt: 800 },
      ],
      recentChat: [{ author: 'viewer', text: 'hi', presentedAt: 850 }],
      frames: [{ sourceId: 'screen', observedAt: 1000, width: 1, height: 1, dataUrl: jpeg }],
      roster: [{ author: 'viewer', color: '#abcdef' }],
      ...inputOverride,
    },
    settings: { historyMaxCount: 20 },
    promptPreset: { id: 'test', revision: 2 },
    adaptation: { frameLimit: 1 },
  });
}

describe('opt-in compact inference evidence', () => {
  it('is off by default and remains independent of the ephemeral inspector', async () => {
    const { root, recorder, trace } = await fixture();
    const id = start(trace);
    trace.update(id, { stage: 'scheduled' });
    await recorder.flush();
    expect(recorder.status()).toMatchObject({ enabled: false, recordingId: null, attempts: 0 });
    await expect(readdir(root)).resolves.toEqual([]);
    expect(trace.get(id)).not.toBeNull();
  });

  it('compresses evidence, shares exact JPEG bytes, reconstructs current request with explicit caveat', async () => {
    const { root, recorder, trace } = await fixture();
    await recorder.configure(true);
    const first = start(trace);
    trace.update(first, {
      request: { private: 'historical transport request must not be persisted' },
      stage: 'scheduled',
      scheduled: {
        messages: [{ author: 'viewer', text: 'reply', offsetMs: 100 }],
        events: [],
        windowMs: 1000,
        enqueuedAt: 1050,
      },
    });
    trace.present(first, { id: 'chat-2', author: 'viewer', text: 'reply', presentedAt: 1150 }, 0);
    const second = start(trace, 2, {
      boundary: { fromSequence: 2, throughSequence: 2, fromMs: 1000, throughMs: 1200 },
    });
    trace.update(second, { stage: 'failed', errorStage: 'transport', error: 'native failure' });
    await recorder.flush();

    const directory = path.join(root, 'compact-inference', recorder.status().recordingId!);
    expect(await readdir(path.join(directory, 'frames'))).toHaveLength(1);
    expect(
      await readFile(
        path.join(
          directory,
          'frames',
          await readdir(path.join(directory, 'frames')).then((x) => x[0]),
        ),
      ),
    ).toEqual(Buffer.from('/9j/2Q==', 'base64'));
    expect(recorder.status()).toMatchObject({ attempts: 2, chunks: 3 });
    const summaries = await recorder.list();
    expect(summaries.map((item) => [item.id, item.seed, item.stage])).toEqual([
      [first, 43, 'scheduled'],
      [second, 44, 'failed'],
    ]);
    const compact = await recorder.reconstruct(first, recorder.status().recordingId!);
    expect(compact).toMatchObject({
      provenance: 'current-builder-reconstruction',
      input: {
        captureSelection: {
          observations: [2],
          transcripts: [1],
          events: ['event-1', 'event-2'],
          chat: ['chat-1'],
          frames: ['screen:1000:0'],
        },
        recentEvents: [
          { kind: 'context', summary: 'first', observedAt: 800 },
          { kind: 'reaction', summary: 'second', observedAt: 800 },
        ],
        frames: [{ dataUrl: jpeg }],
      },
    });
    expect(compact?.warning).toMatch(/not the byte-exact historical request/);
    expect(JSON.stringify(compact?.request)).toContain('gameplay');
    const all = (
      await Promise.all(
        (await readdir(path.join(directory, 'chunks'))).map(async (filename) =>
          gunzipSync(await readFile(path.join(directory, 'chunks', filename))).toString('utf8'),
        ),
      )
    ).join('\n');
    expect(all).not.toContain('historical transport request must not be persisted');
    expect(all).not.toContain(jpeg);
    expect(all).toContain('presentation');
    await expect(
      recorder.reconstruct('attempt-9999', recorder.status().recordingId!),
    ).resolves.toBeNull();
  });

  it('survives volatile trace eviction and fails closed if a selected evidence chunk is missing', async () => {
    const { root, recorder, trace } = await fixture();
    await recorder.configure(true);
    const old = start(trace);
    const newer = start(trace, 2);
    expect(trace.get(old)).toBeNull();
    trace.update(old, { stage: 'scheduled' });
    trace.update(newer, { stage: 'scheduled' });
    await recorder.flush();
    expect(recorder.status().attempts).toBe(2);
    const reconstructed = await recorder.reconstruct(old, recorder.status().recordingId!);
    expect(reconstructed?.attempt.id).toBe(old);

    const dir = path.join(root, 'compact-inference', recorder.status().recordingId!);
    const index = (await readFile(path.join(dir, 'index.jsonl'), 'utf8')).trim().split('\n');
    const first = JSON.parse(index[0]) as { chunk: string };
    await unlink(path.join(dir, 'chunks', first.chunk));
    await expect(recorder.reconstruct(newer, recorder.status().recordingId!)).rejects.toThrow(
      /ENOENT/,
    );
  });

  it('disabling preserves already-started attempts but excludes subsequent attempts', async () => {
    const { recorder, trace } = await fixture();
    await recorder.configure(true);
    const first = start(trace);
    await recorder.configure(false);
    const excluded = start(trace, 2);
    trace.update(first, { stage: 'cancelled', errorStage: 'transport' });
    trace.update(excluded, { stage: 'scheduled' });
    await recorder.flush();
    expect((await recorder.list()).map((item) => item.id)).toEqual([first]);
    await expect(recorder.configure(true)).resolves.toMatchObject({ enabled: true });
  });

  it('reopens private recordings after restart, with disambiguated IDs and a torn index tail', async () => {
    const { root, recorder, trace } = await fixture();
    await recorder.configure(true);
    const first = start(trace);
    trace.update(first, { stage: 'scheduled' });
    await recorder.flush();
    const oldRecording = recorder.status().recordingId!;
    const oldDirectory = path.join(root, 'compact-inference', oldRecording);
    await appendFile(path.join(oldDirectory, 'index.jsonl'), '{"type":"attempt","incomplete":');
    const reopened = new CompactInferenceRecorder(root);
    expect(reopened.status().enabled).toBe(false);
    expect(await reopened.list()).toMatchObject([{ id: first, recordingId: oldRecording }]);
    expect((await reopened.reconstruct(first, oldRecording))?.input).toMatchObject({
      context: 'gameplay',
    });
    await reopened.configure(true);
    const secondTrace = new InferenceTrace();
    secondTrace.attachRecorder(reopened);
    const another = start(secondTrace);
    expect(another).toBe(first); // IDs are unique only within a recording.
    secondTrace.update(another, { stage: 'failed', error: 'failure' });
    await reopened.flush();
    expect((await reopened.list()).map((item) => item.recordingId)).toEqual([
      oldRecording,
      reopened.status().recordingId!,
    ]);
  });

  it('sends a late chat presentation to the original recording after a new recording starts', async () => {
    const { root, recorder, trace } = await fixture();
    await recorder.configure(true);
    const first = start(trace);
    trace.update(first, { stage: 'scheduled' });
    await recorder.flush();
    const originalId = recorder.status().recordingId!;
    await recorder.configure(false);
    await recorder.configure(true);
    const newer = start(trace, 2);
    trace.update(newer, { stage: 'scheduled' });
    trace.present(first, { id: 'chat-2', author: 'viewer', text: 'arrived', presentedAt: 1250 }, 0);
    trace.closePresentation(3);
    await recorder.flush();
    const oldDir = path.join(root, 'compact-inference', originalId);
    const oldIndex = await readFile(path.join(oldDir, 'index.jsonl'), 'utf8');
    expect(oldIndex).toContain('presentation');
    expect(oldIndex).toContain('presentation-closed');
    expect(await recorder.list()).toHaveLength(2);
  });

  it('captures each constructed Exact transport request, including retries and missing replies, without duplicating JPEG blobs', async () => {
    const { root, recorder, trace } = await fixture();
    await recorder.configure(true, 'exact');
    const one = start(trace);
    const built = nativeChatRequest(trace.get(one)!.input as InferenceInput);
    const nativeRequest = {
      ...built,
      temperature: 0.33,
      messages: [
        { role: 'system', content: 'Original prompt, even after a builder update' },
        built.messages[1],
      ],
    };
    trace.update(one, { stage: 'transport', request: nativeRequest });
    trace.update(one, {
      stage: 'failed',
      errorStage: 'transport',
      error: 'No response',
      rawResponse: null,
    });
    const two = start(trace, 2);
    trace.update(two, { stage: 'transport', request: { ...nativeRequest, seed: 44 } });
    trace.update(two, { stage: 'scheduled' });
    await recorder.flush();
    const recordingId = recorder.status().recordingId!;
    const dir = path.join(root, 'compact-inference', recordingId);
    expect(await readdir(path.join(dir, 'frames'))).toHaveLength(1);
    expect((await recorder.list()).map((entry) => entry.mode)).toEqual(['exact', 'exact']);
    const first = await recorder.reconstruct(one, recordingId);
    expect(first?.provenance).toBe('exact-recorded-request');
    expect(first?.request).toEqual(nativeRequest);
    expect(first?.warning).toMatch(/original native request/i);
    expect(first?.request).toMatchObject({
      temperature: 0.33,
      response_format: nativeRequest.response_format,
    });
    expect((await recorder.reconstruct(two, recordingId))?.request).toEqual({
      ...nativeRequest,
      seed: 44,
    });
    // Reopening on a future version must never invoke that version's prompt builder.
    const reopened = new CompactInferenceRecorder(root);
    expect((await reopened.reconstruct(one, recordingId))?.request).toEqual(nativeRequest);
    const cases = new SavedInferenceCases(root);
    const saved = await cases.save(await reopened.restoreExactAttempt(one, recordingId));
    const savedCase = await cases.get(saved.id);
    expect(JSON.stringify(savedCase.request)).toContain('saved-frame:');
    const rerun = await cases.prepareFork({
      caseId: saved.id,
      modelId: 'model',
      rawRequestJson: JSON.stringify(savedCase.request),
      frameIndices: [0],
    });
    expect(rerun.submitted).toEqual(nativeRequest);
    const chunks = (await readdir(path.join(dir, 'chunks'))).sort();
    const archive = gunzipSync(await readFile(path.join(dir, 'chunks', chunks[0]))).toString(
      'utf8',
    );
    expect(archive).not.toContain(jpeg);
    expect(archive).toContain('Original prompt');
  });

  it('finishes already-started Exact attempts after recording is disabled', async () => {
    const { recorder, trace } = await fixture();
    await recorder.configure(true, 'exact');
    const id = start(trace);
    await recorder.configure(false);
    trace.update(id, { stage: 'transport', request: { seed: 43, messages: [] } });
    trace.update(id, { stage: 'failed', errorStage: 'transport' });
    await recorder.flush();
    const recordingId = recorder.status().recordingId!;
    expect((await recorder.reconstruct(id, recordingId))?.request).toEqual({
      seed: 43,
      messages: [],
    });
  });

  it('marks pre-request failures explicitly and verifies Exact request and archive integrity', async () => {
    const { root, recorder, trace } = await fixture();
    await recorder.configure(true, 'exact');
    const noRequest = start(trace);
    trace.update(noRequest, {
      stage: 'failed',
      errorStage: 'preparing',
      error: 'model unavailable',
    });
    const captured = start(trace, 2);
    trace.update(captured, {
      stage: 'transport',
      request: { seed: 44, messages: [{ image_url: { url: jpeg } }] },
    });
    trace.update(captured, { stage: 'failed', errorStage: 'transport' });
    await recorder.flush();
    const recordingId = recorder.status().recordingId!;
    expect((await recorder.reconstruct(noRequest, recordingId))?.warning).toMatch(
      /before.*constructed/i,
    );
    await expect(recorder.restoreExactAttempt(noRequest, recordingId)).rejects.toThrow(
      /no constructed/i,
    );
    const dir = path.join(root, 'compact-inference', recordingId);
    const index = (await readFile(path.join(dir, 'index.jsonl'), 'utf8')).trim().split('\n');
    const last = JSON.parse(index.at(-1)!) as { chunk: string };
    const file = path.join(dir, 'chunks', last.chunk);
    const corrupt = Buffer.from(await readFile(file));
    corrupt[corrupt.length - 1] ^= 0xff;
    await import('node:fs/promises').then(({ writeFile }) => writeFile(file, corrupt));
    await expect(recorder.reconstruct(captured, recordingId)).rejects.toThrow(
      /integrity|checksum/i,
    );
  });

  it('keeps stable event identities under timestamp ties and history pruning', () => {
    const history = new InferenceHistory({ historyMaxCount: 2, historyMaxAgeMs: 1000 });
    history.reset(100);
    history.commitEvents(
      [
        { kind: 'context', summary: 'one', observedAt: 200 },
        { kind: 'reaction', summary: 'two', observedAt: 200 },
      ],
      200,
    );
    const selection = () => history.snapshot('scene', 1, 210, 1000, []).captureSelection!.events;
    expect(selection()).toEqual(['event-1', 'event-2']);
    history.commitEvents([{ kind: 'context', summary: 'three', observedAt: 250 }], 250);
    expect(selection()).toEqual(['event-2', 'event-3']);
  });
});
