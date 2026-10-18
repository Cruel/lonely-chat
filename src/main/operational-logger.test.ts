import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrivateInferenceError } from './private-inference-error';
import { OperationalLogger } from './operational-logger';

const roots: string[] = [];
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lonely-logs-'));
  roots.push(root);
  return { root, logger: new OperationalLogger(root) };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('operational logger', () => {
  it('persists early startup entries without an active session and reloads after restart', async () => {
    const { root, logger } = await setup();
    logger.info('application', 'Starting');
    logger.error('desktop', 'Unable to start', new Error('startup failed'));
    await logger.open();
    expect(logger.snapshot().entries.map((entry) => entry.text)).toEqual([
      'Starting',
      'Unable to start',
    ]);
    await logger.close();
    const next = new OperationalLogger(root);
    await next.open();
    expect(next.snapshot().entries.map((entry) => entry.text)).toEqual([
      'Starting',
      'Unable to start',
      'Logging session finished',
    ]);
    expect(next.snapshot().entries[1].error?.stack).toContain('startup failed');
    await next.close();
  });

  it('redacts known credentials and excludes arbitrary structured context and private fields', async () => {
    const { logger } = await setup();
    logger.error(
      'native',
      'Bearer secret-token Authorization: Bearer abc123',
      new Error('token=verysecret'),
      {
        backend: 'cuda',
        cycle: 2,
        prompt: 'sensitive',
        apiKey: 'secret',
      },
    );
    await logger.open();
    const entry = logger.snapshot().entries[0];
    expect(JSON.stringify(entry)).not.toMatch(/verysecret|abc123|secret-token|sensitive/);
    expect(entry.context).toEqual({ backend: 'cuda', cycle: 2 });
    await logger.close();
  });

  it('sanitizes IPC operation failures even when errors echo private renderer content', async () => {
    const { root, logger } = await setup();
    const secret = 'PRIVATE_PROMPT_124523';
    logger.error('ipc', 'Desktop operation failed', new Error('Rejected message ' + secret), {
      operation: 'playground:run',
      prompt: secret,
    });
    await logger.open();
    await logger.flush();
    expect(JSON.stringify(logger.snapshot())).not.toContain(secret);
    expect(logger.snapshot().entries[0]).toMatchObject({
      source: 'ipc',
      context: { operation: 'playground:run' },
    });
    const files = (await readdir(path.join(root, 'operational-logs'))).filter((name) =>
      name.endsWith('.jsonl'),
    );
    for (const file of files) {
      expect(await readFile(path.join(root, 'operational-logs', file), 'utf8')).not.toContain(
        secret,
      );
    }
    await logger.close();
  });

  it('never persists model responses, echoed prompts or untrusted field names in provider errors', async () => {
    const { root, logger } = await setup();
    const secret = 'PRIVATE_TRANSCRIPT_DO_NOT_PERSIST_3490';
    logger.error(
      'session',
      'Inference attempt failed',
      new Error(`Inference returned unexpected fields: ["${secret}"]`),
    );
    logger.error(
      'llama.cpp',
      'Inference worker failed',
      new PrivateInferenceError('llama.cpp inference failed (HTTP 422).', { raw: secret }),
    );
    logger.error('whisper', 'Speech worker failed', new Error(`Worker failed: ${secret}`));
    await logger.open();
    await logger.flush();
    const entries = logger.snapshot().entries;
    expect(entries[0].error?.message).toContain('validation');
    expect(entries[1].error?.message).toContain('HTTP 422');
    expect(JSON.stringify(entries)).not.toContain(secret);
    const directory = path.join(root, 'operational-logs');
    const contents = await Promise.all(
      (await readdir(directory))
        .filter((name) => name.endsWith('.jsonl'))
        .map((name) => readFile(path.join(directory, name), 'utf8')),
    );
    expect(contents.join('')).not.toContain(secret);
    await logger.close();
  });

  it('expires a quiet live session without another log write, keeping memory and disk capped', async () => {
    vi.useFakeTimers();
    try {
      const start = new Date('2026-10-01T00:00:00.000Z');
      vi.setSystemTime(start);
      const { root, logger } = await setup();
      await logger.open();
      await logger.configure({ ageDays: 1, maxMiB: 5 });
      logger.info('application', 'low volume entry');
      await logger.flush();
      const directory = path.join(root, 'operational-logs');
      expect((await readdir(directory)).some((name) => name.endsWith('.jsonl'))).toBe(true);
      await vi.advanceTimersByTimeAsync(2 * 86400_000);
      await logger.flush();
      expect(logger.snapshot().entries).toEqual([]);
      expect((await readdir(directory)).filter((name) => name.endsWith('.jsonl'))).toEqual([]);
      await logger.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rotates with configured size caps, discards old files and validates limits', async () => {
    const { root, logger } = await setup();
    await logger.open();
    await expect(logger.configure({ ageDays: 0, maxMiB: 1 })).rejects.toThrow();
    await logger.configure({ ageDays: 1, maxMiB: 1 });
    for (let i = 0; i < 1800; i++) {
      logger.info('shell', 'event ' + i + ' x'.repeat(800));
    }
    await logger.flush();
    const dir = path.join(root, 'operational-logs');
    const files = (await readdir(dir)).filter((file) => file.endsWith('.jsonl'));
    const total = (
      await Promise.all(
        files.map(async (file) => (await readFile(path.join(dir, file))).byteLength),
      )
    ).reduce((sum, size) => sum + size, 0);
    expect(files.length).toBeGreaterThan(1);
    expect(total).toBeLessThanOrEqual(1024 * 1024);
    await logger.close();
  });

  it('removes files past the configured age on next startup', async () => {
    const { root, logger } = await setup();
    await logger.open();
    await logger.configure({ ageDays: 1, maxMiB: 5 });
    logger.info('app', 'now expired');
    await logger.close();
    const directory = path.join(root, 'operational-logs');
    const files = (await readdir(directory)).filter((file) => file.endsWith('.jsonl'));
    const twoDaysAgo = new Date(Date.now() - 2 * 86400_000);
    for (const file of files) await utimes(path.join(directory, file), twoDaysAgo, twoDaysAgo);
    const restarted = new OperationalLogger(root);
    await restarted.open();
    expect(restarted.snapshot().entries).toEqual([]);
    await restarted.close();
  });

  it('identifies an unclean previous app termination and tolerates a damaged last line', async () => {
    const { root, logger } = await setup();
    await logger.open();
    logger.info('shell', 'before crash');
    await logger.flush();
    const files = (await readdir(path.join(root, 'operational-logs'))).filter((file) =>
      file.endsWith('.jsonl'),
    );
    await writeFile(path.join(root, 'operational-logs', files[0]), '{not json}\n', { flag: 'a' });
    const reopened = new OperationalLogger(root);
    await reopened.open();
    expect(
      reopened.snapshot().entries.some((entry) => entry.text.includes('previous session')),
    ).toBe(true);
    await reopened.close();
  });
});
