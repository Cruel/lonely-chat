import assert from 'node:assert/strict';
import { app, dialog, type BrowserWindow } from 'electron';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import type { ChatService } from './chat-service';
import type { SessionController } from './session-controller';
import type { CompactInferenceRecorder } from './compact-inference-recorder';
import type { SavedInferenceCases } from './saved-inference-cases';
import type { RecordedScenarioStore } from './recorded-scenarios';
import type { OperationalLogger } from './operational-logger';
import { AUDIENCE, type InferenceInput } from './fake-inference';
import { DEFAULT_PREFERENCES } from '../shared/session-contract';
import { openArchive } from './portable-archive';

interface Services {
  chat: ChatService;
  session: SessionController;
  compact: CompactInferenceRecorder;
  cases: SavedInferenceCases;
  scenarios: RecordedScenarioStore;
  logger: OperationalLogger;
}

/** All execution occurs inside the real *packaged* Electron main/renderer/preload.
 * The runner must supply an isolated profile and generated local media files.
 */
export function installPackagedE2E(window: BrowserWindow, services: Services): void {
  window.webContents.once('did-finish-load', () => {
    void certify(window, services).then(
      () => {
        console.info(
          'PASS: packaged end-to-end Playground, recorded media, diagnostics, archives, overlay isolation',
        );
        app.quit();
      },
      (error: unknown) => {
        console.error('FAIL: packaged end-to-end certification', error);
        process.exitCode = 1;
        app.quit();
      },
    );
  });
}

async function until<T>(
  name: string,
  check: () => Promise<T | null | undefined | false>,
  timeout = 15000,
): Promise<T> {
  const start = performance.now();
  let lastError: unknown;
  while (performance.now() - start < timeout) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(125);
  }
  throw new Error(name + ' timed out' + (lastError ? ': ' + String(lastError) : ''));
}

async function publicSnapshot(url: string): Promise<unknown> {
  const ws = new WebSocket(url.replace(/^http/, 'ws').replace(/\/overlay$/, '/overlay/live'));
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Overlay socket timed out')), 4000);
      ws.once('error', reject);
      ws.once('message', (bytes) => {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(String(bytes)));
        } catch (error) {
          reject(error);
        }
      });
    });
  } finally {
    ws.terminate();
  }
}

/** Only the certification process overrides dialogs. The production IPC handler still
 * chooses the archive format, performs validation, and reads/writes the actual path.
 */
async function withArchiveDialog<T>(
  method: 'save' | 'open',
  expectedTitle: string,
  selectedPath: string,
  action: () => Promise<T>,
): Promise<T> {
  const oldSave = dialog.showSaveDialog;
  const oldOpen = dialog.showOpenDialog;
  if (method === 'save') {
    dialog.showSaveDialog = (async (...args: unknown[]) => {
      const options = args.at(-1) as { title: string };
      assert.equal(options.title, expectedTitle);
      return { canceled: false, filePath: selectedPath };
    }) as typeof dialog.showSaveDialog;
  } else {
    dialog.showOpenDialog = (async (...args: unknown[]) => {
      const options = args.at(-1) as { title: string };
      assert.equal(options.title, expectedTitle);
      return { canceled: false, filePaths: [selectedPath] };
    }) as typeof dialog.showOpenDialog;
  }
  try {
    return await action();
  } finally {
    dialog.showSaveDialog = oldSave;
    dialog.showOpenDialog = oldOpen;
  }
}

async function certify(window: BrowserWindow, s: Services): Promise<void> {
  if (!app.isPackaged)
    throw new Error('End-to-end package certification must run a packaged application.');
  const fixtureRoot = process.env.LONELY_CHAT_CERT_MEDIA_DIR;
  if (!fixtureRoot || !path.isAbsolute(fixtureRoot))
    throw new Error('Missing isolated package-certification media directory.');
  const media = {
    video: path.join(fixtureRoot, 'scene.webm'),
    mic: path.join(fixtureRoot, 'microphone.wav'),
    game: path.join(fixtureRoot, 'gameplay.wav'),
  };
  for (const file of Object.values(media))
    assert.ok((await readFile(file)).length > 100, 'Missing fixture: ' + path.basename(file));
  const api = async <T>(expression: string): Promise<T> =>
    window.webContents.executeJavaScript(expression) as Promise<T>;
  await until(
    'desktop renderer and trusted preload',
    async () =>
      await api<boolean>(
        'Boolean(window.lonelyChat?.runFreeform && document.querySelector(\'nav[aria-label="Main navigation"]\'))',
      ),
  );
  const before = s.chat.snapshot().sequence;
  const freeform = await api<{ content: string; effectiveSeed: number }>(
    `window.lonelyChat.runFreeform(${JSON.stringify({
      modelId: 'cert-worker',
      systemPrompt: 'fixture',
      userPrompt: 'private playground payload',
      temperature: 0,
      topP: 1,
      topK: 1,
      maxTokens: 32,
      seed: 17,
    })})`,
  );
  assert.equal(freeform.content, 'fixture-freeform:private playground payload');
  assert.equal(freeform.effectiveSeed, 17);
  const values = {
    context: 'certified prompt',
    cycle: 1,
    playbackWindowMs: 2000,
    chatActivity: 'normal' as const,
    roster: AUDIENCE,
    events: [],
    transcripts: [{ source: 'mic', text: 'test speech', ageMs: 50 }],
    observations: [],
    recentChat: [],
  };
  const structured = await api<{
    errorStage: string | null;
    accepted: { events: unknown[]; messages: unknown[] };
    usage: unknown;
  }>(
    `window.lonelyChat.runSimulationExperiment(${JSON.stringify({ modelId: 'cert-worker', values })})`,
  );
  assert.equal(structured.errorStage, null, 'Structured Playground inference must validate');
  assert.equal(structured.accepted.events.length, 1);
  assert.equal(structured.accepted.messages.length, 1);
  assert.ok(structured.usage, 'Structured Playground must expose usage');
  assert.equal(s.chat.snapshot().sequence, before, 'Playground must not publish Chat');
  const failed = await api<{ errorStage: string; error: string }>(
    `window.lonelyChat.runSimulationExperiment(${JSON.stringify({
      modelId: 'cert-failure',
      values: { ...values, context: 'cert-failure' },
    })})`,
  );
  assert.equal(failed.errorStage, 'transport');
  assert.match(failed.error, /failed intentionally/);
  const logResult = await api<{ entries: { text: string }[] }>(
    'window.lonelyChat.getOperationalLogs()',
  );
  assert.ok(
    logResult.entries.some((entry) =>
      entry.text.includes('Structured Simulation experiment failed'),
    ),
    'Private diagnostics must remain accessible from Logs after worker failure',
  );
  console.info(
    'PASS: packaged Playground freeform, structured validation, isolated replies and recoverable worker-failure Logs',
  );

  const config = {
    context: 'CERT_PRIVATE_SCENE_PROMPT',
    mode: 'fake' as const,
    video: { path: media.video },
    audio: [
      {
        id: 'microphone',
        kind: 'file' as const,
        path: media.mic,
        label: 'Microphone',
        enabled: true,
        offsetMs: 0,
        embeddedTrackIndex: null,
      },
      {
        id: 'gameplay',
        kind: 'file' as const,
        path: media.game,
        label: 'Gameplay',
        enabled: true,
        offsetMs: 0,
        embeddedTrackIndex: null,
      },
    ],
    segment: { startMs: 0, endMs: null },
    transcriptMode: 'transcribe' as const,
    publishToOverlay: false,
    seed: 42,
    presetId: null,
    presetRevision: null,
    modelId: null,
    settingsSnapshot: {
      ...DEFAULT_PREFERENCES,
      cycleIntervalMs: 1000,
      videoCaptureIntervalMs: 250,
      videoMinFrames: 1,
      videoMaxFrames: 4,
      videoCoverageMs: 3000,
    },
    settingsPolicy: 'saved' as const,
  };
  await api(`window.lonelyChat.setPreferences(${JSON.stringify(config.settingsSnapshot)})`);
  const scenario = await s.scenarios.save('Packaged fixture Scenario', config);
  const metaFile = path.join(fixtureRoot, 'metadata.lcscenario');
  const mediaFile = path.join(fixtureRoot, 'with-media.lcscenario');
  const scenarioExportTitle =
    'Export private Scenario (prompts, settings and optional original media)';
  assert.equal(
    await withArchiveDialog('save', scenarioExportTitle, metaFile, () =>
      api(`window.lonelyChat.exportRecordedScenario(${JSON.stringify(scenario.id)}, false)`),
    ),
    true,
  );
  const metadataArchive = await readFile(metaFile, 'utf8');
  assert.equal(openArchive(metadataArchive, 'scenario').files.size, 0);
  assert.ok(!metadataArchive.includes(fixtureRoot), 'Scenario export leaked source directory');
  assert.equal(
    await withArchiveDialog('save', scenarioExportTitle, mediaFile, () =>
      api(`window.lonelyChat.exportRecordedScenario(${JSON.stringify(scenario.id)}, true)`),
    ),
    true,
  );
  const withMedia = await readFile(mediaFile, 'utf8');
  assert.equal(openArchive(withMedia, 'scenario').files.size, 3);

  // Drive React and production file authorization/decoders, not a directly constructed
  // SessionController. The saved Scenario UI restores the two real audio URLs and video.
  const nav = await api<boolean>(`(async () => {
    const button = [...document.querySelectorAll('nav[aria-label="Main navigation"] button')]
      .find(item => item.getAttribute('aria-label') === 'Simulation');
    button?.click(); return !!button;
  })()`);
  assert.ok(nav, 'Simulation navigation is missing in packaged renderer');
  await until(
    'recorded media input selection',
    async () => {
      const result = await api<boolean>(`(async () => {
      const trigger = document.querySelector('#simulation-input-mode');
      if (!trigger) return false;
      if (document.querySelector('select[aria-label="Choose recorded Scenario"]')) return true;
      if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click();
      const option = [...document.querySelectorAll('[role="option"]')]
        .find(item => item.textContent?.includes('Recorded video'));
      if (option) option.click();
      return Boolean(document.querySelector('select[aria-label="Choose recorded Scenario"]'));
    })()`);
      return result;
    },
    8000,
  );
  await until('saved Scenario option', async () => {
    const exists = await api<boolean>(`Boolean(document.querySelector(
      'select[aria-label="Choose recorded Scenario"] option[value="${scenario.id}"]'))`);
    return exists;
  });
  await api<void>(`(() => {
    const element = document.querySelector('select[aria-label="Choose recorded Scenario"]');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(element, ${JSON.stringify(scenario.id)});
    element.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  const readiness = await until(
    'Chromium file decode',
    async () => {
      const state = await api<{
        video: boolean;
        audio: number;
        enabled: boolean;
        errors: string[];
      }>(`(() => {
      const video = document.querySelector('video[src]');
      const start = [...document.querySelectorAll('button')].find(button => /Start simulation/i.test(button.textContent || ''));
      return {
        video: Boolean(video?.videoWidth && video?.videoHeight && video?.readyState >= 2),
        audio: [...document.querySelectorAll('audio[src]')].filter(audio => audio.readyState >= 1).length,
        enabled: Boolean(start && !start.disabled),
        errors: [...document.querySelectorAll('[role="alert"]')].map(item => item.textContent || ''),
      };
    })()`);
      if (state.errors.some((message) => /codec|unsupported|decoder/i.test(message)))
        throw new Error('UNSUPPORTED_CODEC: ' + state.errors.join(' '));
      return state.video && state.audio >= 2 && state.enabled ? state : null;
    },
    20000,
  );
  assert.equal(readiness.audio, 2, 'Audio-from-video must remain opt-in');
  const beforePublic = s.chat.publicSnapshot().sequence;
  const recorded = await api<{ enabled: boolean }>(
    'window.lonelyChat.configureCompactRecording(true, "compact")',
  );
  assert.equal(recorded.enabled, true);
  await api(`([...document.querySelectorAll('button')].find(button =>
    /Start simulation/i.test(button.textContent || ''))).click()`);
  try {
    await until(
      'real recorded playback and sampled frames',
      async () => {
        const traces = s.session.trace.list().attempts;
        return traces.some((attempt) => {
          const trace = s.session.trace.get(attempt.id);
          return (trace?.input as InferenceInput | null)?.frames?.length;
        });
      },
      14000,
    );
  } catch (error) {
    console.error(
      'CERT-MEDIA-DIAGNOSTIC',
      JSON.stringify({
        session: s.session.snapshot(),
        traces: s.session.trace.list(),
        runs: await s.scenarios.runs(),
        renderer: await api(`({
        video: [...document.querySelectorAll('video')].map(v => ({
          readyState: v.readyState, currentTime: v.currentTime, paused: v.paused, ended: v.ended, error: v.error?.message
        })),
        alerts: [...document.querySelectorAll('[role="alert"]')].map(e => e.textContent),
        status: [...document.querySelectorAll('[role="status"]')].map(e => e.textContent),
      })`),
        logs: (
          await api<{ entries: { source: string; text: string }[] }>(
            'window.lonelyChat.getOperationalLogs()',
          )
        ).entries.slice(-12),
      }),
    );
    throw error;
  }
  await until(
    'two real decoded PCM sources reaching speech bridge',
    async () => {
      const sources = s.session.trace
        .list()
        .attempts.flatMap(
          (attempt) =>
            (s.session.trace.get(attempt.id)?.input as InferenceInput | null)?.recentTranscripts ??
            [],
        );
      const labels = new Set(sources.map((source) => source.source));
      return labels.has('Microphone') && labels.has('Gameplay');
    },
    15000,
  );
  await until(
    'recorded Run finished',
    async () =>
      (await s.scenarios.runs()).some(
        (run) => run.scenarioId === scenario.id && run.status !== 'running',
      ),
    15000,
  );
  await s.compact.flush();
  const runs = await s.scenarios.runs();
  const run = runs.find((item) => item.scenarioId === scenario.id)!;
  assert.ok(run, 'Run metadata missing');
  const attempts = s.session.trace.list().attempts;
  assert.ok(attempts.some((item) => item.stage === 'scheduled'));
  assert.ok(s.session.snapshot().events.length >= 1, 'Fake inference Events not retained');
  assert.ok(s.chat.snapshot().sequence > before, 'Desktop Chat was not presented');
  assert.equal(s.chat.publicSnapshot().sequence, beforePublic, 'Recorded Chat leaked into overlay');
  assert.equal(
    JSON.stringify(
      await publicSnapshot((await api<string>('window.lonelyChat.getOverlayUrl()'))!),
    ).includes('CERT_PRIVATE_SCENE_PROMPT'),
    false,
  );
  const request = await fetch(
    (await api<string>('window.lonelyChat.getOverlayUrl()')).replace(/\/overlay$/, '/api/logs'),
  );
  assert.equal(request.status, 404, 'Public overlay must not expose diagnostics');

  const list = await s.compact.list();
  assert.ok(list.length >= 1, 'Compact recording must retain attempts');
  const reconstructedAttempts = await Promise.all(
    list
      .filter((item) => item.stage === 'scheduled')
      .map((item) => s.compact.reconstruct(item.id, item.recordingId)),
  );
  const reconstructed = reconstructedAttempts.find(
    (item) => (item?.input as InferenceInput | null)?.frames?.length,
  );
  assert.ok(reconstructed, 'Run reconstruction lost selected images');
  assert.equal(reconstructed.provenance, 'current-builder-reconstruction');
  await s.compact.configure(false);
  const runFile = path.join(fixtureRoot, 'exported.lcrun');
  assert.equal(
    await withArchiveDialog(
      'save',
      'Export private Run (prompts, transcripts, JPEGs, retries, responses)',
      runFile,
      () => api(`window.lonelyChat.exportRecordedRun(${JSON.stringify(run.id)})`),
    ),
    true,
  );
  assert.ok(openArchive(await readFile(runFile, 'utf8'), 'run').files.size > 0);
  const importedRun = await withArchiveDialog(
    'open',
    'Import private recorded Run (never publishes to overlay)',
    runFile,
    () =>
      api<import('../shared/recorded-scenario-contract').RecordedRun>(
        'window.lonelyChat.importRecordedRun()',
      ),
  );
  assert.notEqual(importedRun.id, run.id);
  assert.equal(importedRun.effective.publishToOverlay, false);
  const scenarioImported = await withArchiveDialog(
    'open',
    'Import portable Scenario (review and relink media before Start)',
    metaFile,
    () => api<{ missing: string[] }>('window.lonelyChat.importRecordedScenario()'),
  );
  assert.equal(scenarioImported.missing.length, 3, 'Metadata-only Scenario must require relinking');
  const mediaImported = await withArchiveDialog(
    'open',
    'Import portable Scenario (review and relink media before Start)',
    mediaFile,
    () => api<{ missing: string[] }>('window.lonelyChat.importRecordedScenario()'),
  );
  assert.deepEqual(mediaImported.missing, [], 'Media-inclusive Scenario must import through IPC');
  console.info(
    'PASS: Chromium WebM frames, independent WAV/PCM tracks, source-labeled speech, Events, desktop-only Chat',
  );
  console.info(
    'PASS: Run Inspector inputs, Compact recording and case/Run/Scenario archive round trips',
  );

  // Exact coverage must execute SessionController -> native provider -> trace -> recorder,
  // not manually invent request/response updates.
  const selectedFrame = attempts
    .map((item) => s.session.trace.get(item.id))
    .flatMap((item) => (item?.input as InferenceInput | null)?.frames ?? [])[0];
  assert.ok(selectedFrame, 'Missing decoded JPEG fixture for Exact production inference');
  s.session.selectVideoSource('cert-exact:video');
  await api(
    `window.lonelyChat.setPreferences(${JSON.stringify({
      ...config.settingsSnapshot,
      baselineMs: 400,
    })})`,
  );
  const exactStatus = await api<{ recordingId: string }>(
    'window.lonelyChat.configureCompactRecording(true, "exact")',
  );
  const exactRun = await api<{ runId: number }>(
    `window.lonelyChat.startSession("CERT_EXACT_NATIVE", "native", ${JSON.stringify({
      inputMode: 'live',
      publishToOverlay: true,
      seed: 23,
    })})`,
  );
  await api(
    `window.lonelyChat.submitVideoFrame(${JSON.stringify({
      ...selectedFrame,
      sourceId: 'cert-exact:video',
      observedAt: Date.now(),
    })})`,
  );
  const nativeAttempt = await until('real native SessionController Exact attempt', async () => {
    const attempt = s.session.trace
      .list()
      .attempts.find((item) => item.runId === exactRun.runId && item.mode === 'native');
    if (attempt?.stage === 'failed')
      throw new Error('Native cycle failed: ' + JSON.stringify(s.session.trace.get(attempt.id)));
    return attempt?.stage === 'scheduled' ? attempt : null;
  });
  const nativeTrace = s.session.trace.get(nativeAttempt.id)!;
  assert.ok(nativeTrace.request, 'Real provider did not emit transport request');
  assert.ok(nativeTrace.rawResponse, 'Real provider did not emit model response');
  const saved = await api<{ id: string }>(
    `window.lonelyChat.saveInferenceCase(${JSON.stringify(nativeAttempt.id)})`,
  );
  const caseFile = path.join(fixtureRoot, 'exported-case.json');
  assert.equal(
    await withArchiveDialog(
      'save',
      'Export exact inference case (includes private prompts and images)',
      caseFile,
      () => api(`window.lonelyChat.exportSavedCase(${JSON.stringify(saved.id)})`),
    ),
    true,
  );
  const importedCase = await withArchiveDialog(
    'open',
    'Import exact inference case',
    caseFile,
    () => api<{ id: string }>('window.lonelyChat.importSavedCase()'),
  );
  assert.notEqual(importedCase.id, saved.id);
  const caseData = await api<{ frames: { dataUrl: string }[] }>(
    `window.lonelyChat.getSavedCase(${JSON.stringify(importedCase.id)})`,
  );
  assert.ok(caseData.frames[0]?.dataUrl.startsWith('data:image/jpeg;base64,'));
  await api('window.lonelyChat.stopSession()');
  await s.compact.flush();
  const restoredExact = await s.compact.restoreExactAttempt(
    nativeAttempt.id,
    exactStatus.recordingId,
  );
  assert.deepEqual(restoredExact.request, nativeTrace.request);
  assert.deepEqual(restoredExact.rawResponse, nativeTrace.rawResponse);
  await api('window.lonelyChat.configureCompactRecording(false, "exact")');
  console.info(
    'PASS: Exact mode immutable request/output recovery, worker failure logging, public overlay privacy',
  );
}
