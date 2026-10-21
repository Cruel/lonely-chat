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
  it('allocates globally distinct attempt identities across trace instances', () => {
    const one = start(new InferenceTrace());
    const two = start(new InferenceTrace());
    expect(one).toMatch(/^attempt-[0-9a-f-]{36}$/);
    expect(two).not.toBe(one);
  });

  it('restores Exact outcome, later publication events, and closure into saved cases after restart', async () => {
    const { root, recorder, trace } = await fixture();
    await recorder.configure(true, 'exact', false, { retainMedia: true, retainContent: true });
    const id = start(trace);
    const request = nativeChatRequest(trace.get(id)!.input as InferenceInput);
    trace.update(id, {
      stage: 'scheduled',
      request,
      rawResponse: { choices: [{ message: { content: '{"events":[],"messages":[]}' } }] },
      normalized: { events: [], messages: [{ author: 'viewer', text: 'Hi', offsetMs: 100 }] },
      accepted: { events: [], messages: [{ author: 'viewer', text: 'Hi', offsetMs: 100 }] },
      scheduled: {
        messages: [{ author: 'viewer', text: 'Hi', offsetMs: 100 }],
        events: [],
        windowMs: 3000,
      },
    });
    await recorder.flush();
    trace.present(
      id,
      { id: 'message-1', author: 'viewer', text: 'Hi', presentedAt: 1500, timelineAt: 1350 },
      0,
    );
    trace.closePresentation(3);
    await recorder.flush();
    const recordingId = recorder.status().recordingId!;
    const reopened = new CompactInferenceRecorder(root);
    const disk = await reopened.reconstruct(id, recordingId);
    expect(disk?.outcome).toMatchObject({
      stage: 'scheduled',
      accepted: { messages: [{ text: 'Hi' }] },
      presented: [{ id: 'message-1', presentedAt: 1500, timelineAt: 1350, scheduledIndex: 0 }],
      presentationClosed: true,
    });
    const restored = await reopened.restoreExactAttempt(id, recordingId);
    expect(restored.presented).toHaveLength(1);
    expect(restored.presentationClosed).toBe(true);
    const cases = new SavedInferenceCases(root);
    const caseSummary = await cases.save(restored, 'exact-recorded-request');
    expect((await cases.get(caseSummary.id)).sourceResult).toMatchObject({
      presented: [{ id: 'message-1' }],
      presentationClosed: true,
      accepted: { messages: [{ text: 'Hi' }] },
      requestProvenance: 'exact-recorded-request',
    });
  });

  it('freezes a Compact reconstruction as an immutable case with an explicit provenance warning', async () => {
    const { root, recorder, trace } = await fixture();
    await recorder.configure(true, 'compact', false, { retainMedia: true, retainContent: true });
    const id = start(trace);
    trace.update(id, { stage: 'scheduled', accepted: { events: [], messages: [] } });
    await recorder.flush();
    const recordingId = recorder.status().recordingId!;
    const reopened = new CompactInferenceRecorder(root);
    const restored = await reopened.restoreRecordedAttempt(id, recordingId);
    expect(restored.request).toMatchObject({ seed: 43 });
    const cases = new SavedInferenceCases(root);
    const saved = await cases.save(restored, 'current-builder-reconstruction');
    expect((await cases.get(saved.id)).sourceResult).toMatchObject({
      requestProvenance: 'current-builder-reconstruction',
      accepted: { events: [], messages: [] },
    });
  });

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
    await recorder.configure(true, 'compact', false, { retainMedia: true, retainContent: true });
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
    expect(recorder.status()).toMatchObject({ attempts: 2, chunks: 5 });
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
    await recorder.configure(true, 'compact', false, { retainMedia: true, retainContent: true });
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
    const first = index
      .map((row) => JSON.parse(row) as { type: string; chunk: string })
      .find((row) => row.type === 'attempt')!;
    await unlink(path.join(dir, 'chunks', first.chunk));
    await expect(recorder.reconstruct(newer, recorder.status().recordingId!)).rejects.toThrow(
      /missing selected frame/,
    );
  });

  it('disabling preserves already-started attempts but excludes subsequent attempts', async () => {
    const { recorder, trace } = await fixture();
    await recorder.configure(true, 'compact', false, { retainMedia: true, retainContent: true });
    const first = start(trace);
    await recorder.configure(false);
    const excluded = start(trace, 2);
    trace.update(first, { stage: 'cancelled', errorStage: 'transport' });
    trace.update(excluded, { stage: 'scheduled' });
    await recorder.flush();
    expect((await recorder.list()).map((item) => item.id)).toEqual([first]);
    await expect(
      recorder.configure(true, 'compact', false, { retainMedia: true, retainContent: true }),
    ).resolves.toMatchObject({ enabled: true });
  });

  it('reopens private recordings after restart, with disambiguated IDs and a torn index tail', async () => {
    const { root, recorder, trace } = await fixture();
    await recorder.configure(true, 'compact', false, { retainMedia: true, retainContent: true });
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
    await reopened.configure(true, 'compact', false, { retainMedia: true, retainContent: true });
    const secondTrace = new InferenceTrace();
    secondTrace.attachRecorder(reopened);
    const another = start(secondTrace);
    expect(another).not.toBe(first); // IDs remain distinct across application restarts.
    secondTrace.update(another, { stage: 'failed', error: 'failure' });
    await reopened.flush();
    expect((await reopened.list()).map((item) => item.recordingId)).toEqual([
      oldRecording,
      reopened.status().recordingId!,
    ]);
  });

  it('sends a late chat presentation to the original recording after a new recording starts', async () => {
    const { root, recorder, trace } = await fixture();
    await recorder.configure(true, 'compact', false, { retainMedia: true, retainContent: true });
    const first = start(trace);
    trace.update(first, { stage: 'scheduled' });
    await recorder.flush();
    const originalId = recorder.status().recordingId!;
    await recorder.configure(false);
    await recorder.configure(true, 'compact', false, { retainMedia: true, retainContent: true });
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

  it('retains presentations admitted before Run close while attempt writes are still queued', async () => {
    const { root, recorder, trace } = await fixture();
    await recorder.configure(true, 'compact', false, { retainMedia: true, retainContent: true });
    const recordingId = recorder.status().recordingId!;
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    // Simulate slow storage: the attempt, presentation and close are all enqueued
    // while the recorder has not yet written the terminal attempt chunk.
    (recorder as unknown as { chain: Promise<void> }).chain = gate;
    const id = start(trace);
    trace.update(id, { stage: 'scheduled' });
    trace.present(
      id,
      { id: 'chat-before-close', author: 'viewer', text: 'retained', presentedAt: 1250 },
      0,
    );
    trace.closePresentation(3);
    // The synchronous Run-close boundary must reject later publications.
    trace.present(
      id,
      { id: 'chat-after-close', author: 'viewer', text: 'excluded', presentedAt: 1350 },
      1,
    );
    unblock();
    await recorder.flush();
    const dir = path.join(root, 'compact-inference', recordingId);
    const index = (await readFile(path.join(dir, 'index.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; chunk: string });
    expect(index.map((entry) => entry.type)).toEqual([
      'attempt-start',
      'attempt',
      'presentation',
      'presentation-closed',
    ]);
    const chunks = await Promise.all(
      index.map(async (entry) =>
        gunzipSync(await readFile(path.join(dir, 'chunks', entry.chunk))).toString('utf8'),
      ),
    );
    expect(chunks.join('\n')).toContain('chat-before-close');
    expect(chunks.join('\n')).not.toContain('chat-after-close');
    expect(chunks.at(-1)).toContain('presentation-closed');
    expect(recorder.status().memoryBytes).toBeLessThan(4000);
  });

  it('captures each constructed Exact transport request, including retries and missing replies, without duplicating JPEG blobs', async () => {
    const { root, recorder, trace } = await fixture();
    await recorder.configure(true, 'exact', false, { retainMedia: true, retainContent: true });
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
    const archive = (
      await Promise.all(
        chunks.map(async (chunk) =>
          gunzipSync(await readFile(path.join(dir, 'chunks', chunk))).toString('utf8'),
        ),
      )
    ).join('\n');
    expect(archive).not.toContain(jpeg);
    expect(archive).toContain('Original prompt');
  });

  it('finishes already-started Exact attempts after recording is disabled', async () => {
    const { recorder, trace } = await fixture();
    await recorder.configure(true, 'exact', false, { retainMedia: true, retainContent: true });
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
    await recorder.configure(true, 'exact', false, { retainMedia: true, retainContent: true });
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

  it('begins a partial recording with the next complete attempt and finalizes in-flight attempts after stop', async () => {
    const { root, recorder, trace } = await fixture();
    const beforeEnabled = start(trace);
    await recorder.configure(true, 'compact', true, { retainMedia: true, retainContent: true });
    const captured = start(trace, 2);
    await recorder.configure(false);
    expect(recorder.status()).toMatchObject({ enabled: false, partial: true, finalizing: 1 });
    const excluded = start(trace, 3);
    trace.update(beforeEnabled, { stage: 'scheduled' });
    trace.update(excluded, { stage: 'scheduled' });
    trace.update(captured, { stage: 'failed', errorStage: 'transport', error: 'worker failed' });
    await recorder.flush();
    const recordingId = recorder.status().recordingId!;
    expect(
      await readFile(path.join(root, 'compact-inference', recordingId, 'complete.json'), 'utf8'),
    ).toContain('finalizedAt');
    const reopened = new CompactInferenceRecorder(root);
    expect(await reopened.list()).toMatchObject([
      {
        id: captured,
        stage: 'failed',
        archiveStatus: 'complete',
        partial: true,
      },
    ]);
  });

  it('labels interrupted attempts and recovers complete orphan chunks behind a torn index', async () => {
    const { root, recorder, trace } = await fixture();
    await recorder.configure(true, 'compact', false, { retainMedia: true, retainContent: true });
    const interrupted = start(trace);
    await recorder.flush(); // Durable checkpoint without a completed response.
    const recordingId = recorder.status().recordingId!;
    const dir = path.join(root, 'compact-inference', recordingId);
    const reopened = new CompactInferenceRecorder(root);
    expect(await reopened.list()).toMatchObject([
      {
        id: interrupted,
        stage: 'interrupted',
        interrupted: true,
        archiveStatus: 'incomplete',
      },
    ]);
    expect((await reopened.reconstruct(interrupted, recordingId))?.warning).toMatch(/interrupted/i);

    trace.update(interrupted, { stage: 'failed', error: 'transport died' });
    await recorder.flush();
    const lines = (await readFile(path.join(dir, 'index.jsonl'), 'utf8')).trim().split('\n');
    const onlyCheckpoint = lines.find((line) => JSON.parse(line).type === 'attempt-start')!;
    await import('node:fs/promises').then(({ writeFile }) =>
      writeFile(path.join(dir, 'index.jsonl'), onlyCheckpoint + '\n{"truncated":\n'),
    );
    const recovered = new CompactInferenceRecorder(root);
    expect(await recovered.list()).toMatchObject([
      {
        id: interrupted,
        stage: 'failed',
        archiveStatus: 'incomplete',
      },
    ]);
    expect((await recovered.reconstruct(interrupted, recordingId))?.input).toMatchObject({
      context: 'gameplay',
    });
  });

  it('isolates corrupt chunks so an unrelated complete attempt remains readable', async () => {
    const { root, recorder, trace } = await fixture();
    await recorder.configure(true, 'compact', false, { retainMedia: true, retainContent: true });
    const first = start(trace);
    trace.update(first, { stage: 'scheduled' });
    const second = start(trace, 2, {
      frames: [{ sourceId: 'screen', observedAt: 1100, width: 1, height: 1, dataUrl: jpeg }],
      captureSelection: {
        observations: [20],
        transcripts: [21],
        events: ['event-20', 'event-21'],
        chat: ['chat-20'],
        frames: ['frame-20'],
      },
    });
    trace.update(second, { stage: 'scheduled' });
    await recorder.flush();
    const recordingId = recorder.status().recordingId!;
    const dir = path.join(root, 'compact-inference', recordingId);
    const index = (await readFile(path.join(dir, 'index.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; chunk: string });
    const firstFile = path.join(
      dir,
      'chunks',
      index.find((item) => item.type === 'attempt')!.chunk,
    );
    await import('node:fs/promises').then(({ writeFile }) => writeFile(firstFile, 'broken gzip'));
    const reopened = new CompactInferenceRecorder(root);
    expect(await reopened.list()).toHaveLength(2);
    await expect(reopened.reconstruct(first, recordingId)).rejects.toThrow();
    expect((await reopened.reconstruct(second, recordingId))?.attempt.id).toBe(second);
  });

  it('persists configurable limits, preserves old chunks, and disables capture without affecting tracing', async () => {
    const { root, recorder, trace } = await fixture();
    await recorder.configure(true, 'compact', false, { retainMedia: true, retainContent: true });
    const first = start(trace);
    trace.update(first, { stage: 'scheduled' });
    await recorder.flush();
    const previousBytes = recorder.status().bytes;
    await recorder.setLimits({ diskBytes: previousBytes, memoryBytes: 1024 * 1024 });
    expect(recorder.status()).toMatchObject({ enabled: false, bytes: previousBytes });
    expect(recorder.status().warning).toMatch(/limit/i);
    const next = start(trace, 2);
    trace.update(next, { stage: 'scheduled' });
    await recorder.flush();
    expect(trace.get(next)).not.toBeNull();
    expect((await recorder.list()).map((entry) => entry.id)).toEqual([first]);
    const reopened = new CompactInferenceRecorder(root);
    await reopened.loadLimits();
    expect(reopened.status().limits).toEqual({
      diskBytes: previousBytes,
      memoryBytes: 1024 * 1024,
      maxAgeDays: 30,
    });
    await expect(
      reopened.configure(true, 'compact', false, { retainMedia: true, retainContent: true }),
    ).rejects.toThrow(/disk limit/i);
    await reopened.setLimits({ diskBytes: 1024 * 1024, memoryBytes: 1024 * 1024 });
    await reopened.configure(true, 'compact', false, { retainMedia: true, retainContent: true });
    // The new archive refuses storage once its memory budget is too small to snapshot a request.
    await reopened.setLimits({ diskBytes: 1024 * 1024, memoryBytes: 1024 });
    const newTrace = new InferenceTrace();
    newTrace.attachRecorder(reopened);
    const oversized = start(newTrace, 4, { context: 'x'.repeat(4096) });
    newTrace.update(oversized, { stage: 'scheduled' });
    await reopened.flush();
    expect(reopened.status().enabled).toBe(false);
    expect(reopened.status().warning).toMatch(/memory limit/i);
  });

  it('accounts for late presentations written to an older recording and enforces aggregate disk limits', async () => {
    const { recorder, trace } = await fixture();
    await recorder.configure(true, 'compact', false, { retainMedia: true, retainContent: true });
    const old = start(trace);
    trace.update(old, { stage: 'scheduled' });
    await recorder.flush();
    const oldRecording = recorder.status().recordingId!;
    await recorder.configure(false);
    await recorder.flush();
    await recorder.configure(true, 'compact', false, { retainMedia: true, retainContent: true });
    const currentBytes = recorder.status().bytes;
    const totalBefore = recorder.status().totalBytes!;
    trace.present(old, { id: 'late-1', author: 'viewer', text: 'first', presentedAt: 1300 }, 0);
    await recorder.flush();
    expect(recorder.status().totalBytes).toBeGreaterThan(totalBefore);
    expect(recorder.status().bytes).toBe(currentBytes);
    expect((await recorder.reconstruct(old, oldRecording))?.attempt.id).toBe(old);
    const totalAfter = recorder.status().totalBytes!;
    await recorder.setLimits({ diskBytes: totalAfter + 1, memoryBytes: 1024 * 1024 });
    trace.present(
      old,
      { id: 'late-2', author: 'viewer', text: 'must not fit', presentedAt: 1350 },
      1,
    );
    await recorder.flush();
    expect(recorder.status()).toMatchObject({
      enabled: false,
      totalBytes: totalAfter,
      bytes: currentBytes,
    });
    expect(recorder.status().warning).toMatch(/disk recording limit/i);
    expect((await recorder.reconstruct(old, oldRecording))?.attempt.id).toBe(old);
  });

  it('retains terminal attempt memory reservations while disk writes are queued', async () => {
    const { recorder, trace } = await fixture();
    await recorder.configure(true, 'exact', false, { retainMedia: true, retainContent: true });
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    // Simulate a stalled disk operation without relying on wall-clock sleeps.
    (recorder as unknown as { chain: Promise<void> }).chain = gate;
    const first = start(trace);
    trace.update(first, { stage: 'transport', request: { prompt: 'z'.repeat(5000) } });
    trace.update(first, { stage: 'scheduled' });
    const heldBytes = recorder.status().memoryBytes!;
    expect(heldBytes).toBeGreaterThan(10_000);
    expect(recorder.status().enabled).toBe(true);
    await recorder.setLimits({
      diskBytes: 1024 * 1024,
      memoryBytes: heldBytes + 1000,
    });
    const excluded = start(trace, 2, { context: 'y'.repeat(3000) });
    trace.update(excluded, { stage: 'scheduled' });
    expect(recorder.status().enabled).toBe(false);
    expect(recorder.status().warning).toMatch(/memory limit/i);
    expect(recorder.status().memoryBytes).toBeGreaterThanOrEqual(heldBytes);
    unblock();
    await recorder.flush();
    expect((await recorder.list()).map((item) => item.id)).toEqual([first]);
    expect(recorder.status().memoryBytes).toBeLessThan(heldBytes);
  });

  it('releases publication bookkeeping when a run closes and keeps deduplication caches bounded', async () => {
    const { recorder, trace } = await fixture();
    await recorder.configure(true, 'compact', false, { retainMedia: true, retainContent: true });
    for (let cycle = 1; cycle <= 20; cycle++) {
      const id = start(trace, cycle, {
        captureSelection: {
          observations: [cycle],
          transcripts: [cycle],
          events: [`event-${cycle}`],
          chat: [`chat-${cycle}`],
          frames: [`frame-${cycle}`],
        },
        recentEvents: [{ kind: 'context', summary: 'event', observedAt: cycle }],
      });
      trace.update(id, { stage: 'scheduled' });
    }
    await recorder.flush();
    const before = recorder.status().memoryBytes!;
    expect(before).toBeGreaterThan(2000);
    trace.closePresentation(3);
    await recorder.flush();
    expect(recorder.status().memoryBytes).toBeLessThan(before);
  });

  it('stops accumulating per-attempt index and deduplication state at the memory budget', async () => {
    const { recorder, trace } = await fixture();
    await recorder.configure(true, 'compact', false, { retainMedia: true, retainContent: true });
    await recorder.setLimits({ diskBytes: 8 * 1024 * 1024, memoryBytes: 22 * 1024 });
    let last = '';
    for (let cycle = 1; cycle <= 60 && recorder.status().enabled; cycle++) {
      last = start(trace, cycle, {
        captureSelection: {
          observations: [cycle],
          transcripts: [cycle],
          events: [`event-${cycle}`],
          chat: [`chat-${cycle}`],
          frames: [`frame-${cycle}`],
        },
        recentEvents: [{ kind: 'context', summary: `unique-${cycle}`, observedAt: cycle }],
      });
      trace.update(last, { stage: 'scheduled' });
      await recorder.flush();
    }
    expect(recorder.status().enabled).toBe(false);
    expect(recorder.status().warning).toMatch(/memory limit/i);
    expect(recorder.status().attempts).toBeLessThan(60);
    const remaining = start(trace, 61);
    trace.update(remaining, { stage: 'scheduled' });
    expect(trace.get(remaining)).not.toBeNull();
    await recorder.flush();
    expect((await recorder.list()).some((item) => item.id === remaining)).toBe(false);
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
