import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, symlink, chmod } from 'node:fs/promises';
import { CredentialPolicy } from './credential-persistence';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InferenceCoordinator } from './inference-coordinator';
import { ChatService } from './chat-service';
import { SessionController } from './session-controller';
import { FakeClock, flushMicrotasks } from './test-support/fake-clock';
import { RemoteInferencePlayground } from './remote-inference-playground';
import { strictProviderSchema } from './remote-inference-adapter';
import { buildUnifiedInferenceRequest } from './unified-inference-request';
import { RemoteInferenceStore } from './remote-inference-store';
import {
  listRemoteModels,
  probeRemoteModel,
  remoteUnifiedAdapter,
  type RemoteSelection,
} from './remote-inference-adapter';
import {
  validateRemoteEndpoint,
  type RemoteConnection,
  type RemoteModelConfiguration,
} from '../shared/remote-inference-contract';
import type { InferenceInput } from './fake-inference';

const input: InferenceInput = {
  context: 'A reunion in a station',
  cycle: 1,
  playbackWindowMs: 3000,
  roster: [{ author: 'viewer', color: '#123456' }],
  recentTranscripts: [{ source: 'mic', text: 'Long time no see', observedAt: 10500 }],
  boundary: { fromSequence: 0, throughSequence: 1, fromMs: 10000, throughMs: 11000 },
  frames: [
    {
      sourceId: 'stream',
      observedAt: 10000,
      mediaTimeMs: 50,
      width: 2,
      height: 2,
      dataUrl: 'data:image/jpeg;base64,AAAA',
    },
    {
      sourceId: 'stream',
      observedAt: 10800,
      mediaTimeMs: 850,
      width: 2,
      height: 2,
      dataUrl: 'data:image/jpeg;base64,BBBB',
    },
  ],
};
const complete = {
  events: [{ kind: 'reaction', summary: 'a reunion', ageMs: 200 }],
  messages: [{ author: 'viewer', text: 'Welcome back!', offsetMs: 200 }],
};
const connection = (
  url: string,
  protocol: RemoteConnection['protocol'] = 'chat-completions',
): RemoteConnection => ({
  id: 'home',
  name: 'Home',
  baseUrl: url,
  protocol,
  credentialMode: 'managed',
  allowInsecureLan: false,
});
const model: RemoteModelConfiguration = {
  id: 'chat',
  name: 'Chat',
  connectionId: 'home',
  model: 'my-vlm',
  images: true,
  allowRemoteImages: true,
  outputFormat: 'json-schema',
};

const servers: Server[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(
  handler: (
    body: unknown,
    headers: Record<string, string | string[] | undefined>,
    url: string,
  ) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>,
): Promise<string> {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const json: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    const result = await handler(json, req.headers, req.url ?? '');
    res.writeHead(result.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const port = (server.address() as { port: number }).port;
  return `http://127.0.0.1:${port}/v1`;
}

async function run(
  selection: RemoteSelection,
  sample: InferenceInput = input,
  observe?: (stage: 'request' | 'response' | 'normalized', value: unknown) => void,
) {
  return new InferenceCoordinator().execute(
    sample,
    remoteUnifiedAdapter(selection, { roster: sample.roster }),
    {
      signal: new AbortController().signal,
      observe,
    },
  );
}

describe('remote Connection security and persistence', () => {
  it('enforces HTTPS except loopback and explicitly approved private LAN', () => {
    expect(validateRemoteEndpoint('http://localhost:1337/v1', false)).toBe(
      'http://localhost:1337/v1',
    );
    expect(() => validateRemoteEndpoint('http://192.168.1.8:8080/v1', false)).toThrow(
      /acknowledged/,
    );
    expect(validateRemoteEndpoint('http://192.168.1.8:8080/v1', true)).toBe(
      'http://192.168.1.8:8080/v1',
    );
    expect(() => validateRemoteEndpoint('http://example.org/v1', true)).toThrow(/private LAN/);
    expect(() => validateRemoteEndpoint('http://user:pass@localhost:3000/v1', false)).toThrow(
      /credentials/,
    );
    expect(() => validateRemoteEndpoint('file:///tmp/model', false)).toThrow(/HTTPS/);
  });

  it('persists managed keys in a restricted private file when OS protection is unavailable', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lc-remote-'));
    directories.push(dir);
    const protector = { available: () => false, encrypt: () => Buffer.from(''), decrypt: () => '' };
    const store = new RemoteInferenceStore(dir, protector);
    await store.load();
    await store.putConnection(connection('https://example.test/v1'));
    await store.putModel(model);
    expect(await store.setCredential('home', 'shhh-secret')).toBe('file');
    expect(store.selected('chat').credential).toBe('shhh-secret');
    await store.putConnection({ ...connection('https://different.example.test/v1') });
    expect(() => store.selected('chat')).toThrow(/requires a configured credential/);
    await store.putConnection(connection('https://example.test/v1'));
    await store.setCredential('home', 'shhh-secret');
    const exposed = JSON.stringify(store.list());
    const serialized = await readFile(path.join(dir, 'remote-inference.json'), 'utf8');
    expect(exposed + serialized).not.toContain('shhh-secret');
    expect(exposed).toContain('"file"');
    await expect(readFile(path.join(dir, 'remote-secrets.bin.json'), 'utf8')).rejects.toMatchObject(
      { code: 'ENOENT' },
    );
    const localPath = path.join(dir, 'private-credentials', 'remote.json');
    expect(await readFile(localPath, 'utf8')).toContain('shhh-secret');
    if (process.platform !== 'win32') {
      expect((await stat(localPath)).mode & 0o777).toBe(0o600);
      expect((await stat(path.dirname(localPath))).mode & 0o777).toBe(0o700);
    }
    const restarted = new RemoteInferenceStore(dir, protector);
    await restarted.load();
    expect(restarted.list().connections[0].credentialStatus).toBe('file');
    expect(restarted.selected('chat').credential).toBe('shhh-secret');
    await restarted.removeConnection('home');
    expect(restarted.list().models).toEqual([]);
    expect(await readFile(localPath, 'utf8')).not.toContain('shhh-secret');
  });

  it('moves private credentials to protected storage when a secure keyring becomes available', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lc-upgrade-'));
    directories.push(dir);
    let available = false;
    const protector = {
      available: () => available,
      encrypt: (text: string) => Buffer.from('encrypted:' + text),
      decrypt: (data: Buffer) => data.toString().replace(/^encrypted:/, ''),
    };
    const first = new RemoteInferenceStore(dir, protector);
    await first.load();
    await first.putConnection(connection('https://example.test/v1'));
    expect(await first.setCredential('home', 'private-key')).toBe('file');
    const localFile = path.join(dir, 'private-credentials', 'remote.json');
    expect(await readFile(localFile, 'utf8')).toContain('private-key');

    available = true;
    const upgraded = new RemoteInferenceStore(dir, protector);
    await upgraded.load();
    expect(upgraded.list().connections[0].credentialStatus).toBe('protected');
    expect(upgraded.resolve('home').credential).toBe('private-key');
    expect(await readFile(path.join(dir, 'remote-secrets.bin.json'), 'utf8')).not.toContain(
      'private-key',
    );
    await expect(readFile(localFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains encrypted records during a temporary keyring outage', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lc-keyring-outage-'));
    directories.push(dir);
    let available = true;
    const protector = {
      available: () => available,
      encrypt: (text: string) => Buffer.from('encrypted:' + text),
      decrypt: (data: Buffer) => data.toString().replace(/^encrypted:/, ''),
    };
    const first = new RemoteInferenceStore(dir, protector);
    await first.load();
    await first.putConnection(connection('https://example.test/v1'));
    await first.setCredential('home', 'original-token');
    const previous = await readFile(path.join(dir, 'remote-secrets.bin.json'), 'utf8');

    available = false;
    const fallback = new RemoteInferenceStore(dir, protector);
    await fallback.load();
    await fallback.setCredential('home', 'replacement-token');
    expect(await readFile(path.join(dir, 'remote-secrets.bin.json'), 'utf8')).toBe(previous);
    available = true;
    const reopened = new RemoteInferenceStore(dir, protector);
    await reopened.load();
    expect(reopened.resolve('home').credential).toBe('replacement-token');
    expect(reopened.list().connections[0].credentialStatus).toBe('protected');
  });

  it('does not resurrect a credential redirected to a new endpoint during a keyring outage', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lc-rebinding-'));
    directories.push(dir);
    let available = true;
    const protector = {
      available: () => available,
      encrypt: (text: string) => Buffer.from('encrypted:' + text),
      decrypt: (data: Buffer) => data.toString().replace(/^encrypted:/, ''),
    };
    const original = new RemoteInferenceStore(dir, protector);
    await original.load();
    await original.putConnection(connection('https://original.example.test/v1'));
    await original.setCredential('home', 'first-key');
    available = false;
    const offline = new RemoteInferenceStore(dir, protector);
    await offline.load();
    await offline.putConnection(connection('https://new.example.test/v1'));
    available = true;
    const restored = new RemoteInferenceStore(dir, protector);
    await restored.load();
    expect(restored.list().connections[0].credentialStatus).toBe('missing');
    expect(() => restored.resolve('home')).toThrow(/requires a configured credential/);
  });

  it('honors a persistent session-only preference and deletes saved managed credentials', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lc-session-'));
    directories.push(dir);
    const policy = new CredentialPolicy(dir);
    const protector = { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' };
    const store = new RemoteInferenceStore(dir, protector, {}, policy);
    await store.load();
    await store.putConnection(connection('https://example.test/v1'));
    await store.setCredential('home', 'unprotected-token');
    const localFile = path.join(dir, 'private-credentials', 'remote.json');
    expect(await readFile(localFile, 'utf8')).toContain('unprotected-token');
    await policy.setPersist(false);
    await store.applyCredentialPolicy();
    expect(store.resolve('home').credential).toBe('unprotected-token');
    expect(store.list().connections[0].credentialStatus).toBe('session');
    await expect(readFile(localFile)).rejects.toMatchObject({ code: 'ENOENT' });
    const restoredPolicy = new CredentialPolicy(dir);
    await restoredPolicy.load();
    expect(restoredPolicy.persist).toBe(false);
    const reopened = new RemoteInferenceStore(dir, protector, {}, restoredPolicy);
    await reopened.load();
    expect(reopened.list().connections[0].credentialStatus).toBe('missing');
    await restoredPolicy.setPersist(true);
    await reopened.applyCredentialPolicy();
    expect(reopened.list().connections[0].credentialStatus).toBe('missing');
  });

  it('rejects weak private credential file permissions and symlinked directories', async () => {
    if (process.platform === 'win32') return;
    const dir = await mkdtemp(path.join(tmpdir(), 'lc-perms-'));
    directories.push(dir);
    const protector = { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' };
    const first = new RemoteInferenceStore(dir, protector);
    await first.load();
    await first.putConnection(connection('https://example.test/v1'));
    await first.setCredential('home', 'private-key');
    const localFile = path.join(dir, 'private-credentials', 'remote.json');
    await chmod(localFile, 0o644);
    await expect(new RemoteInferenceStore(dir, protector).load()).rejects.toThrow(/inaccessible/);
    await chmod(localFile, 0o600);
    await rm(path.join(dir, 'private-credentials'), { recursive: true });
    await symlink(dir, path.join(dir, 'private-credentials'));
    await expect(new RemoteInferenceStore(dir, protector).load()).rejects.toThrow(/directory/);
  });

  it('uses protected storage when the OS protector is reliable and exposes only status', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lc-remote-'));
    directories.push(dir);
    const protector = {
      available: () => true,
      encrypt: (value: string) => Buffer.from(`encrypted-${value}`, 'utf8'),
      decrypt: (value: Buffer) => value.toString('utf8').replace(/^encrypted-/, ''),
    };
    const store = new RemoteInferenceStore(dir, protector);
    await store.load();
    await store.putConnection(connection('https://example.test/v1'));
    expect(await store.setCredential('home', 'dont-log-me')).toBe('protected');
    const disk = await readFile(path.join(dir, 'remote-secrets.bin.json'), 'utf8');
    expect(disk).not.toContain('dont-log-me');
    const reopened = new RemoteInferenceStore(dir, protector);
    await reopened.load();
    expect(reopened.list().connections[0].credentialStatus).toBe('protected');
    expect(reopened.resolve('home').credential).toBe('dont-log-me');
  });

  it('resolves environment credential references only in main and supports truly key-free endpoints', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lc-remote-'));
    directories.push(dir);
    const store = new RemoteInferenceStore(
      dir,
      { available: () => false, encrypt: () => Buffer.from(''), decrypt: () => '' },
      { CUSTOM_TOKEN: 'env-secret' },
    );
    await store.load();
    await store.putConnection({
      ...connection('http://localhost:3210/v1'),
      credentialMode: 'environment',
      environmentVariable: 'CUSTOM_TOKEN',
    });
    expect(store.resolve('home').credential).toBe('env-secret');
    expect(JSON.stringify(store.list())).not.toContain('env-secret');
    await store.putConnection({
      ...connection('http://localhost:3210/v1'),
      credentialMode: 'none',
    });
    expect(store.resolve('home').credential).toBeNull();
  });
});

describe('remote OpenAI SDK Unified protocol contracts', () => {
  it('strips only unsupported strict-schema constraints, retaining app validation boundaries', () => {
    const original = buildUnifiedInferenceRequest(input).response.schema;
    const transport = strictProviderSchema(original);
    expect(JSON.stringify(transport)).not.toMatch(/maxItems|maxLength|minimum|maximum/);
    expect(JSON.stringify(transport)).toContain('additionalProperties');
    expect(original.properties.messages.maxItems).toBeGreaterThan(0);
  });

  it('Chat Completions sends ordered frame/timestamp content, authenticates and accepts an atomic batch', async () => {
    const received: unknown[] = [];
    const url = await fixture((body, headers, pathname) => {
      received.push({ body, headers, pathname });
      return {
        body: {
          id: 'chat-1',
          choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(complete) } }],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        },
      };
    });
    const secret = 'my-very-private-api-key';
    const trace: unknown[] = [];
    const result = await run(
      { connection: connection(url), model, credential: secret },
      input,
      (_stage, value) => trace.push(value),
    );
    expect(result.accepted.messages).toEqual([
      { author: 'viewer', color: '#123456', text: 'Welcome back!', offsetMs: 200 },
    ]);
    expect(result.usage).toEqual({ promptTokens: 20, completionTokens: 10, totalTokens: 30 });
    const first = received[0] as {
      body: { messages: { content: unknown }[]; model: string; response_format: unknown };
      headers: { authorization: string };
      pathname: string;
    };
    expect(first.pathname).toBe('/v1/chat/completions');
    expect(first.headers.authorization).toBe(`Bearer ${secret}`);
    expect(first.body.model).toBe('my-vlm');
    expect(first.body.response_format).toMatchObject({ type: 'json_schema' });
    const schema = (
      first.body.response_format as {
        json_schema: {
          schema: { properties: { messages: { items: { properties: { text: unknown } } } } };
        };
      }
    ).json_schema.schema;
    expect(JSON.stringify(schema)).not.toMatch(/maxItems|maxLength|minimum|maximum/);
    expect(schema.properties.messages.items.properties.text).toMatchObject({ type: 'string' });
    expect(JSON.stringify(first.body.messages)).toContain('Long time no see');
    expect(
      (
        first.body.messages[1].content as {
          type: string;
          text?: string;
          image_url?: { url: string };
        }[]
      ).map((part) => part.type),
    ).toEqual(['text', 'text', 'image_url', 'text', 'image_url']);
    expect(JSON.stringify(first.body.messages)).toContain('observedAt=10800');
    expect(JSON.stringify({ trace, result })).not.toContain(secret);
  });

  it('Responses sends ordered multimodal input without a fabricated Authorization header', async () => {
    const seen: { body: unknown; headers: Record<string, unknown> }[] = [];
    const url = await fixture((body, headers) => {
      seen.push({ body, headers });
      return {
        body: {
          id: 'resp-1',
          status: 'completed',
          output: [
            {
              type: 'message',
              id: 'm',
              status: 'completed',
              role: 'assistant',
              content: [{ type: 'output_text', text: JSON.stringify(complete), annotations: [] }],
            },
          ],
          usage: { input_tokens: 8, output_tokens: 7, total_tokens: 15 },
        },
      };
    });
    const result = await run({
      connection: { ...connection(url, 'responses'), credentialMode: 'none' },
      model: { ...model, outputFormat: 'prompt-json' },
      credential: null,
    });
    const body = seen[0].body as {
      input: { content: { type: string; image_url?: string }[] }[];
      store: boolean;
    };
    expect(body.store).toBe(false);
    expect(body.input[0].content.map((part) => part.type)).toEqual([
      'input_text',
      'input_text',
      'input_image',
      'input_text',
      'input_image',
    ]);
    expect(body.input[0].content[4].image_url).toBe('data:image/jpeg;base64,BBBB');
    expect(seen[0].headers).not.toHaveProperty('authorization');
    expect(result.accepted.events).toHaveLength(1);
  });

  it('probes actual JSON behavior, rather than trusting a claimed protocol', async () => {
    const url = await fixture((_body, _headers, pathname) =>
      pathname.endsWith('/models')
        ? { body: { object: 'list', data: [{ id: 'remote-vision' }, { id: 'remote-chat' }] } }
        : {
            body: {
              id: 'sample',
              choices: [
                {
                  finish_reason: 'stop',
                  message: { content: JSON.stringify({ events: [], messages: [] }) },
                },
              ],
            },
          },
    );
    const selection: RemoteSelection = {
      connection: { ...connection(url), credentialMode: 'none' },
      model,
      credential: null,
    };
    expect((await probeRemoteModel(selection, new AbortController().signal)).compatible).toBe(true);
    expect(await listRemoteModels(selection, new AbortController().signal)).toEqual([
      'remote-vision',
      'remote-chat',
    ]);
    const invalidUrl = await fixture(() => ({
      body: { choices: [{ finish_reason: 'stop', message: { content: 'broken' } }] },
    }));
    await expect(
      probeRemoteModel(
        { ...selection, connection: connection(invalidUrl) },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/invalid JSON/);
  });

  it('never treats truncated completions, provider errors or aborted requests as Chat batches', async () => {
    const secret = 'dont-print-this-secret';
    const url = await fixture(() => ({
      body: {
        choices: [{ finish_reason: 'length', message: { content: JSON.stringify(complete) } }],
      },
    }));
    await expect(run({ connection: connection(url), model, credential: secret })).rejects.toThrow(
      /did not finish/,
    );
    const failing = await fixture(() => ({ status: 401, body: { error: { message: secret } } }));
    const reject = run({ connection: connection(failing), model, credential: secret });
    const error = await reject.catch((failure: unknown) => failure);
    expect((error as Error).message).toContain('HTTP 401');
    expect((error as Error).message).not.toContain(secret);
    const slow = await fixture(
      async () =>
        new Promise<{ body: unknown }>((resolve) =>
          setTimeout(
            () =>
              resolve({
                body: {
                  choices: [
                    { finish_reason: 'stop', message: { content: JSON.stringify(complete) } },
                  ],
                },
              }),
            500,
          ),
        ),
    );
    const coordinator = new InferenceCoordinator();
    const accepted = vi.fn();
    const pending = coordinator.execute(
      input,
      remoteUnifiedAdapter({ connection: connection(slow), model, credential: null }),
      {
        signal: new AbortController().signal,
        onParsed: accepted,
      },
    );
    coordinator.cancelActive();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(accepted).not.toHaveBeenCalled();
  });

  it('runs remote recorded Simulation through one coordinator and publishes accepted Chat only', async () => {
    const sessionOutput = {
      ...complete,
      events: [],
      messages: [{ author: 'pixelpilot', text: 'Welcome back!', offsetMs: 200 }],
    };
    const url = await fixture(() => ({
      body: {
        id: 'chat-session',
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(sessionOutput) } }],
      },
    }));
    const selection: RemoteSelection = {
      connection: connection(url),
      model,
      credential: 'session-secret',
    };
    const clock = new FakeClock();
    const chat = new ChatService();
    const session = new SessionController(chat, undefined, clock);
    session.configureRemote((sample) => remoteUnifiedAdapter(selection, { roster: sample.roster }));
    const started = session.start('Remote run', 'remote', 'chat', {
      inputMode: 'recorded',
      publishToOverlay: true,
    });
    expect(started).toMatchObject({ mode: 'remote', modelId: 'chat', phase: 'starting' });
    await vi.waitFor(async () => {
      await flushMicrotasks();
      expect(session.snapshot().phase).toBe('running');
      expect(
        session.snapshot().latestInferenceMs,
        JSON.stringify(session.snapshot()),
      ).not.toBeNull();
    });
    expect(chat.snapshot().messages).toHaveLength(0);
    clock.advance(250);
    await flushMicrotasks();
    expect(chat.snapshot().messages.map((entry) => entry.text)).toContain('Welcome back!');
    session.stop();
  });

  it('runs remote Playground without publishing Chat and with redacted request imagery', async () => {
    const url = await fixture(() => ({
      body: {
        id: 'chat-playground',
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(complete) } }],
      },
    }));
    const playground = new RemoteInferencePlayground();
    const jpeg =
      'data:image/jpeg;base64,' +
      readFileSync(new URL('../../tests/fixtures/playground-red.jpg', import.meta.url)).toString(
        'base64',
      );
    const result = await playground.run(
      {
        modelId: 'chat',
        seed: 11,
        values: {
          context: 'A reunion',
          cycle: 1,
          playbackWindowMs: 3000,
          chatActivity: 'normal',
          roster: [{ author: 'viewer', color: '#123456' }],
          transcripts: [],
          observations: [],
          recentChat: [],
          events: [],
        },
        frames: [
          {
            sourceId: 'stream',
            mediaTimeMs: 100,
            width: 4,
            height: 4,
            dataUrl: jpeg,
          },
        ],
      },
      { connection: connection(url), model, credential: 'private-key' },
    );
    expect(result.error).toBeNull();
    expect(result.accepted?.messages[0].author).toBe('viewer');
    expect(JSON.stringify(result.constructedRequest)).not.toContain(jpeg);
    expect(JSON.stringify(result)).not.toContain('private-key');
    expect(playground.busy).toBe(false);
  });

  it('refuses images without explicit remote permission, even when model claims image support', async () => {
    const url = await fixture(() => ({ body: {} }));
    const adapter = remoteUnifiedAdapter({
      connection: connection(url),
      model: { ...model, allowRemoteImages: false },
      credential: null,
    });
    await expect(
      new InferenceCoordinator().execute(input, adapter, { signal: new AbortController().signal }),
    ).rejects.toThrow(/does not accept image/);
  });
});
