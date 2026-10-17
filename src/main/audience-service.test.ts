import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AudienceService } from './audience-service';
import { FakeInference, type InferenceProvider } from './fake-inference';
import { AUTHOR_PLACEHOLDER } from '../shared/audience-contract';

const dirs: string[] = [];
const signal = new AbortController().signal;
async function roster(count: number) {
  const directory = await mkdtemp(path.join(tmpdir(), 'lonely-chat-audience-'));
  dirs.push(directory);
  const service = new AudienceService(directory, count);
  await service.open();
  return { service, directory };
}
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
const sample = (author: string) => ({ author, color: '#ffffff', text: 'hello', offsetMs: 0 });

describe('stable audience roster', () => {
  it('generates on first use, persists over restart, resizes without rewriting presented authors and regenerates', async () => {
    const { service, directory } = await roster(3);
    expect(service.snapshot()).toMatchObject({ phase: 'ready', members: [] });
    await service.ensure(new FakeInference(), signal);
    const first = service.snapshot().members;
    expect(first.map((item) => item.author)).toEqual(['pixelpilot', 'lunar_fox', 'nightowl']);
    const displayed = [{ author: first[2].author, text: 'already sent' }];
    const restarted = new AudienceService(directory, 3);
    await restarted.open();
    expect(restarted.snapshot().members).toEqual(first);
    await restarted.setTarget(2);
    expect(restarted.snapshot().members.map((item) => item.author)).toEqual([
      'pixelpilot',
      'lunar_fox',
    ]);
    expect(displayed[0].author).toBe('nightowl');
    const restored = new AudienceService(directory, 4);
    await restored.open();
    expect(restored.snapshot().members).toHaveLength(2);
    await restored.ensure(new FakeInference(), signal);
    expect(restored.snapshot().members.map((item) => item.author)).toEqual([
      'pixelpilot',
      'lunar_fox',
      'nightowl',
      'viewer_4',
    ]);
    await restored.ensure(new FakeInference(), signal, true);
    expect(restored.snapshot().members.map((item) => item.author)).toEqual([
      'viewer_5',
      'viewer_6',
      'viewer_7',
      'viewer_8',
    ]);
    expect(JSON.parse(await readFile(path.join(directory, 'audience.json'), 'utf8')).version).toBe(
      1,
    );
  });

  it('deduplicates generated names case-insensitively, retries collisions, and preserves roster on failure', async () => {
    const { service } = await roster(3);
    let calls = 0;
    const provider: InferenceProvider = {
      generate: async () => ({ messages: [] }),
      generateRoster: vi.fn(async () => {
        calls++;
        if (calls === 1) return ['BlueFox', 'bluefox', 'NiceCat'];
        return ['ThirdUser'];
      }),
    };
    await service.ensure(provider, signal);
    expect(service.snapshot().members.map((item) => item.author)).toEqual([
      'BlueFox',
      'NiceCat',
      'ThirdUser',
    ]);
    expect(provider.generateRoster).toHaveBeenCalledTimes(2);
    const failure: InferenceProvider = {
      generate: async () => ({ messages: [] }),
      generateRoster: async () => {
        throw new Error('model disconnected');
      },
    };
    await expect(service.ensure(failure, signal, true)).rejects.toThrow(/model disconnected/);
    expect(service.snapshot()).toMatchObject({ phase: 'error', error: 'model disconnected' });
    expect(service.snapshot().members).toHaveLength(3);
    await service.ensure(new FakeInference(), signal, true);
    expect(service.snapshot().phase).toBe('ready');
    expect(service.snapshot().error).toBeNull();
  });

  it('resolves placeholders to eligible non-recent viewers and refuses unknown identities', async () => {
    const { service } = await roster(3);
    await service.ensure(new FakeInference(), signal);
    const messages = service.resolve(
      [sample(AUTHOR_PLACEHOLDER), sample(AUTHOR_PLACEHOLDER), sample('pixelpilot')],
      [{ author: 'pixelpilot' }, { author: 'pixelpilot' }],
    );
    expect(messages.map((item) => item.author)).toEqual(['lunar_fox', 'nightowl', 'pixelpilot']);
    expect(messages.every((item) => item.color !== '#ffffff')).toBe(true);
    expect(() => service.resolve([sample('unlisted')], [])).toThrow(/outside the roster/);
  });

  it('does not replace corrupt saved rosters without explicit retry and rejects invalid names', async () => {
    const { directory } = await roster(2);
    await writeFile(
      path.join(directory, 'audience.json'),
      '{"version":1,"members":[{"author":"A", "color":"#ffffff"}]}',
    );
    const service = new AudienceService(directory, 2);
    await service.open();
    expect(service.snapshot().phase).toBe('error');
    const invalid: InferenceProvider = {
      generate: async () => ({}),
      generateRoster: async () => ['a b', 'valid_one'],
    };
    await expect(service.ensure(invalid, signal)).rejects.toThrow(/invalid username/);
    expect(service.snapshot().members).toEqual([]);
    await service.ensure(new FakeInference(), signal);
    expect(service.snapshot().members).toHaveLength(2);
  });

  it('generates large rosters in bounded batches rather than one huge model call', async () => {
    const { service } = await roster(26);
    const provider = new FakeInference();
    const generator = vi.spyOn(provider, 'generateRoster');
    await service.ensure(provider, signal);
    expect(service.snapshot().members).toHaveLength(26);
    expect(generator.mock.calls.map(([count]) => count)).toEqual([12, 12, 2]);
  });

  it('stops roster generation on abort rather than publishing partial output', async () => {
    const { service } = await roster(2);
    const abort = new AbortController();
    const generator: InferenceProvider = {
      generate: async () => ({}),
      generateRoster: async () => {
        abort.abort();
        return ['FirstOne', 'SecondOne'];
      },
    };
    await expect(service.ensure(generator, abort.signal)).rejects.toThrow(/cancelled/);
    expect(service.snapshot().members).toEqual([]);
    expect(service.snapshot().phase).toBe('ready');
  });
});
