import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiagnosticCapture } from './diagnostic-capture';
import { NativeWorkerLog } from './native-worker-log';
import { OperationalLogger } from './operational-logger';
import { NativeInference } from './native-inference';
import { NativeSpeech } from './native-speech';

const roots: string[] = [];
const servers: NativeInference[] = [];
const loggers: OperationalLogger[] = [];
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lonely-native-logs-'));
  roots.push(root);
  const logger = new OperationalLogger(root);
  loggers.push(logger);
  await logger.open();
  return { root, logger };
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  await Promise.all(loggers.splice(0).map((logger) => logger.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('native worker diagnostic streams', () => {
  it('frames split stdout/stderr lines, retains ordered safe diagnostics, and never persists secrets', async () => {
    const { root, logger } = await setup();
    const capture = new DiagnosticCapture();
    const worker = new NativeWorkerLog(
      'llama.cpp',
      logger,
      { backend: 'cuda', pid: 1234 },
      (id, stream, line) => capture.recordWorkerLine(id, stream, line),
    );
    worker.start();
    const secret = 'PRIVATE_TRANSCRIPT_CONTENT_5151';
    worker.write('stderr', Buffer.from('ggml_cuda_init: failed to initial'));
    worker.write('stderr', Buffer.from('ize CUDA\r\n'));
    worker.write('stdout', Buffer.from('not logged: ' + secret + '\n'));
    worker.write('stderr', Buffer.from('cudaMalloc failed: out of memory\n'));
    worker.finish(42, null, false);
    const entries = logger.snapshot().entries;
    expect(entries.map((entry) => entry.text)).toEqual([
      'Native worker started',
      'stderr: CUDA: initialization failed',
      expect.stringContaining('Native stdout contains private/unclassified output'),
      'stderr: CUDA: memory allocation failed',
      'Native worker exited unexpectedly',
    ]);
    expect(entries.every((entry) => entry.context?.worker === worker.id)).toBe(true);
    expect(entries.at(-1)?.context).toMatchObject({
      exitCode: 42,
      backend: 'cuda',
      pid: 1234,
      phase: 'failed',
    });
    await logger.flush();
    const logsDir = path.join(root, 'operational-logs');
    const stored = (
      await Promise.all(
        (await readdir(logsDir))
          .filter((name) => name.endsWith('.jsonl'))
          .map((name) => readFile(path.join(logsDir, name), 'utf8')),
      )
    ).join('');
    expect(stored).not.toContain(secret);
    expect(capture.status().workerLines).toBe(0);

    capture.configure(true);
    const second = new NativeWorkerLog(
      'llama.cpp',
      logger,
      { backend: 'cpu' },
      (id, stream, line) => capture.recordWorkerLine(id, stream, line),
    );
    second.start();
    second.write('stdout', Buffer.from('model output: ' + secret + '\n'));
    second.finish(0, 'SIGTERM', true);
    expect(JSON.parse(capture.export()).workerOutput).toEqual([
      { worker: second.id, stream: 'stdout', line: 'model output: ' + secret },
    ]);
    expect(second.id).not.toBe(worker.id);
    capture.configure(false);
    expect(capture.status().workerLines).toBe(0);
  });

  it('bounds high-throughput and incomplete lines, reporting discarded output without leaking it', async () => {
    const { logger } = await setup();
    const worker = new NativeWorkerLog('whisper', logger, { backend: 'cpu' });
    worker.start();
    worker.write('stderr', Buffer.from('PRIVATE_SPEECH_SECRET'.repeat(8000)));
    for (let i = 0; i < 2000; i++)
      worker.write('stderr', Buffer.from('CUDA error: failed to allocate\n'));
    worker.finish(null, 'SIGKILL', false);
    const entries = logger.snapshot().entries;
    expect(entries.length).toBeLessThanOrEqual(403);
    expect(entries.some((entry) => entry.context?.code === 'OUTPUT_LIMIT')).toBe(true);
    expect(entries.at(-1)?.context).toMatchObject({ signal: 'SIGKILL' });
    expect(JSON.stringify(entries)).not.toContain('PRIVATE_SPEECH_SECRET');
  });

  it('retains stderr and crash identity after a fake llama worker restart', async () => {
    const { logger } = await setup();
    let starts = 0;
    const provider = new NativeInference({
      executable: process.execPath,
      resolveModel: async () => ({ modelPath: '/managed/fixture.gguf', projectorPath: null }),
      log: logger,
      launch: (_file, args, options) => {
        starts++;
        if (starts === 1)
          return spawn(
            process.execPath,
            [
              '-e',
              `
            process.stderr.write('ggml_cuda_init: failed to initialize CUDA\\n');
            process.stdout.write('PRIVATE_PROMPT_BODY_007\\n');
            process.exit(11);
          `,
            ],
            options,
          );
        const port = args[args.indexOf('--port') + 1];
        return spawn(
          process.execPath,
          [
            '-e',
            `
          const http = require('node:http');
          const server = http.createServer((request, response) => {
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({status:'ok'}));
          });
          server.listen(${JSON.stringify(port)}, '127.0.0.1');
          process.on('SIGTERM', () => server.close(() => process.exit()));
        `,
          ],
          options,
        );
      },
    });
    servers.push(provider);
    await expect(provider.prepare(new AbortController().signal)).rejects.toThrow(/exited/);
    await vi.waitFor(() =>
      expect(logger.snapshot().entries.some((entry) => entry.context?.exitCode === 11)).toBe(true),
    );
    const old = logger.snapshot().entries.find((entry) => entry.context?.exitCode === 11)!;
    expect(old.context).toMatchObject({ backend: 'cpu', exitCode: 11 });
    expect(
      logger.snapshot().entries.some((entry) => entry.text.includes('initialization failed')),
    ).toBe(true);
    expect(JSON.stringify(logger.snapshot())).not.toContain('PRIVATE_PROMPT_BODY_007');
    await provider.stop();
    await provider.prepare(new AbortController().signal);
    expect(provider.snapshot().phase).toBe('ready');
    const launches = logger
      .snapshot()
      .entries.filter((entry) => entry.text === 'Native worker started');
    expect(launches).toHaveLength(2);
    expect(launches[0].context?.worker).not.toBe(launches[1].context?.worker);
    expect(old.context?.worker).toBe(launches[0].context?.worker);
  });

  it('records fake Whisper stderr/crash while keeping framed stdout private', async () => {
    const { logger } = await setup();
    const capture = new DiagnosticCapture();
    capture.configure(true);
    const speech = new NativeSpeech({
      executable: process.execPath,
      resolveModel: async () => '/managed/whisper.bin',
      log: logger,
      privateWorkerLine: (worker, stream, line) => capture.recordWorkerLine(worker, stream, line),
      launch: (_binary, _args, options) =>
        spawn(
          process.execPath,
          [
            '-e',
            `
          process.stderr.write('whisper_init: failed to load model\\n');
          process.stderr.write('PRIVATE_TRANSCRIPT_DO_NOT_PERSIST\\n');
          process.exit(17);
        `,
          ],
          options,
        ),
    });
    await expect(speech.start()).rejects.toThrow();
    await vi.waitFor(() =>
      expect(logger.snapshot().entries.some((entry) => entry.context?.exitCode === 17)).toBe(true),
    );
    expect(
      logger.snapshot().entries.some((entry) => entry.text.includes('model loading failed')),
    ).toBe(true);
    expect(JSON.stringify(logger.snapshot())).not.toContain('PRIVATE_TRANSCRIPT_DO_NOT_PERSIST');
    expect(JSON.parse(capture.export()).workerOutput).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stream: 'stderr', line: 'PRIVATE_TRANSCRIPT_DO_NOT_PERSIST' }),
      ]),
    );
    await speech.shutdown();
  });

  it('logs only protocol metadata for successful binary Whisper stdout responses', async () => {
    const { logger } = await setup();
    const secret = 'PRIVATE_WHISPER_TRANSCRIPT_8451';
    const speech = new NativeSpeech({
      executable: process.execPath,
      resolveModel: async () => '/managed/whisper.bin',
      log: logger,
      launch: (_binary, _args, options) =>
        spawn(
          process.execPath,
          [
            '-e',
            `
            process.stdin.on('data', (chunk) => {
              const opcode = chunk[4];
              const text = opcode === 1 ? '' : '${secret}';
              const data = Buffer.from(text);
              const frame = Buffer.alloc(5 + data.length);
              frame.writeUInt32LE(1 + data.length, 0);
              frame[4] = opcode === 1 ? 0x81 : 0x82;
              data.copy(frame, 5);
              process.stdout.write(frame);
            });
          `,
          ],
          options,
        ),
    });
    await speech.start();
    expect(await speech.transcribe(new Float32Array(1600))).toBe(secret);
    const entries = logger.snapshot().entries.filter((entry) => entry.context?.stream === 'stdout');
    expect(entries.map((entry) => entry.context?.operation)).toEqual(['ready', 'transcribed']);
    expect(JSON.stringify(logger.snapshot())).not.toContain(secret);
    await speech.shutdown();
  });
});
