import { describe, expect, it, afterEach, vi } from 'vitest';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { CredentialPolicy } from './credential-persistence';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ChatGPTAuth, verifyChatGPTIdentity } from './chatgpt-auth';
import { chatGPTUnifiedAdapter, probeChatGPTModel } from './chatgpt-inference';
import { InferenceCoordinator } from './inference-coordinator';
import { ChatService } from './chat-service';
import { SessionController } from './session-controller';
import { FakeClock, flushMicrotasks } from './test-support/fake-clock';
import { RemoteInferencePlayground } from './remote-inference-playground';
import type { RemoteSelection } from './remote-inference-adapter';
import type { InferenceInput } from './fake-inference';

const privateDirs: string[] = [];
afterEach(async () => {
  await Promise.all(privateDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = {
  ...pair.publicKey.export({ format: 'jwk' }),
  kid: 'fixture-key',
  alg: 'RS256',
  use: 'sig',
};
const issuer = 'https://auth.openai.com';
const secret = 'private-subscription-access-token';
const requiredScopes =
  'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const now = 1792500000000;

function signedIdentity(
  audience: string | string[],
  nonce: string,
  subject = 'account-123',
  overrides: Record<string, unknown> = {},
) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture-key' })).toString(
    'base64url',
  );
  const payload = Buffer.from(
    JSON.stringify({
      iss: issuer,
      aud: audience,
      sub: subject,
      nonce,
      email: 'user@example.test',
      iat: now / 1000 - 10,
      exp: now / 1000 + 3600,
      ...overrides,
    }),
  ).toString('base64url');
  const signature = createSign('RSA-SHA256')
    .update(`${header}.${payload}`)
    .end()
    .sign(pair.privateKey)
    .toString('base64url');
  return `${header}.${payload}.${signature}`;
}

function fixture(
  options: {
    readonly scopes?: string;
    readonly subject?: string;
    readonly badState?: boolean;
    readonly badNonce?: boolean;
    readonly failingStream?: boolean;
    readonly partialStream?: boolean;
    readonly sparseOutput?:
      | 'delta'
      | 'done'
      | 'delta-done'
      | 'part'
      | 'item'
      | 'reasoning-only'
      | 'empty';
    readonly probeOutput?: boolean;
    readonly code?: string;
    readonly author?: string;
    readonly ageMs?: number;
  } = {},
) {
  const requests: { url: string; method: string; body?: unknown; headers?: Headers }[] = [];
  let refreshCount = 0;
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const method = init?.method ?? 'GET';
    const body =
      init?.body instanceof URLSearchParams
        ? Object.fromEntries(init.body)
        : typeof init?.body === 'string'
          ? (JSON.parse(init.body) as unknown)
          : undefined;
    requests.push({ url, method, body, headers });
    if (url.endsWith('/.well-known/openid-configuration'))
      return Response.json({
        issuer,
        jwks_uri: `${issuer}/.well-known/jwks.json`,
        revocation_endpoint: `${issuer}/api/accounts/oauth/revoke`,
      });
    if (url.endsWith('/.well-known/jwks.json')) return Response.json({ keys: [jwk] });
    if (url.endsWith('/api/accounts/oauth/revoke')) return new Response(null, { status: 200 });
    if (url.endsWith('/api/accounts/oauth/token')) {
      const form = body as Record<string, string>;
      if (form.grant_type === 'refresh_token') refreshCount++;
      const nonce = lastNonce;
      return Response.json({
        token_type: 'Bearer',
        expires_in: form.grant_type === 'refresh_token' ? 3600 : 1,
        access_token: refreshCount ? `${secret}-refreshed-${refreshCount}` : secret,
        refresh_token: `rotating-secret-${refreshCount}`,
        id_token: signedIdentity(
          'oaiapp_fixture',
          options.badNonce ? 'wrong-nonce' : nonce,
          options.subject,
        ),
        scope: options.scopes ?? requiredScopes,
      });
    }
    if (url.endsWith('/models'))
      return Response.json({
        models: [
          { slug: 'visual-plan-model', display_name: 'Visual Plan Model', visibility: 'list' },
          { slug: 'hidden-model', display_name: 'Hidden', visibility: 'hidden' },
        ],
      });
    if (url.endsWith('/responses')) {
      if (options.code)
        return Response.json(
          { error: { code: options.code, message: 'provider-private-content' } },
          { status: 429 },
        );
      const responseText = JSON.stringify(
        options.probeOutput
          ? { events: [], messages: [] }
          : {
              events: [{ kind: 'reaction', summary: 'a reunion', ageMs: options.ageMs ?? 100 }],
              messages: [
                { author: options.author ?? 'viewer', text: 'Good to see you!', offsetMs: 100 },
              ],
            },
      );
      const result = {
        id: 'resp-complete',
        status: 'completed',
        output: options.sparseOutput
          ? options.sparseOutput === 'reasoning-only'
            ? [{ type: 'reasoning', id: 'rs-1', summary: [] }]
            : []
          : [
              {
                type: 'message',
                role: 'assistant',
                status: 'completed',
                id: 'm1',
                content: [{ type: 'output_text', text: responseText, annotations: [] }],
              },
            ],
        usage: { input_tokens: 15, output_tokens: 7, total_tokens: 22 },
      };
      const deltas = [
        {
          type: 'response.output_text.delta',
          output_index: 0,
          content_index: 0,
          item_id: 'm1',
          delta: responseText.slice(0, 15),
        },
        {
          type: 'response.output_text.delta',
          output_index: 0,
          content_index: 0,
          item_id: 'm1',
          delta: responseText.slice(15),
        },
      ];
      const streamText =
        options.sparseOutput === 'delta'
          ? deltas
          : options.sparseOutput === 'delta-done'
            ? [
                ...deltas,
                {
                  type: 'response.output_text.done',
                  output_index: 0,
                  content_index: 0,
                  item_id: 'm1',
                  text: responseText,
                },
              ]
            : options.sparseOutput === 'done'
              ? [
                  {
                    type: 'response.output_text.done',
                    output_index: 0,
                    content_index: 0,
                    item_id: 'm1',
                    text: responseText,
                  },
                ]
              : options.sparseOutput === 'part'
                ? [
                    {
                      type: 'response.content_part.done',
                      output_index: 0,
                      content_index: 0,
                      item_id: 'm1',
                      part: { type: 'output_text', text: responseText },
                    },
                  ]
                : options.sparseOutput === 'item'
                  ? [
                      {
                        type: 'response.output_item.done',
                        output_index: 0,
                        item: {
                          type: 'message',
                          id: 'm1',
                          role: 'assistant',
                          status: 'completed',
                          content: [{ type: 'output_text', text: responseText }],
                        },
                      },
                    ]
                  : options.sparseOutput === 'reasoning-only' || options.sparseOutput === 'empty'
                    ? []
                    : [{ type: 'response.output_text.delta', delta: 'partial-but-not-accepted' }];
      const events = options.failingStream
        ? [{ type: 'response.failed', response: { status: 'failed' } }]
        : [
            ...streamText,
            ...(options.partialStream ? [] : [{ type: 'response.completed', response: result }]),
          ];
      return new Response(
        events.map((entry) => `data: ${JSON.stringify(entry)}\n\n`).join('') + 'data: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    }
    return new Response(null, { status: 404 });
  });
  let lastNonce = '';
  const browser = vi.fn(async (url: string) => {
    const params = new URL(url).searchParams;
    lastNonce = params.get('nonce')!;
    const callback = new URL(params.get('redirect_uri')!);
    callback.searchParams.set('state', options.badState ? 'forged-state' : params.get('state')!);
    callback.searchParams.set('client_id', 'oaiapp_fixture');
    callback.searchParams.set('code', 'some-code');
    const response = await fetch(callback);
    expect([200, 400]).toContain(response.status);
  });
  const protector = {
    available: () => true,
    encrypt: (value: string) =>
      Buffer.from(`not-plaintext:${Buffer.from(value).toString('base64')}`),
    decrypt: (value: Buffer) =>
      Buffer.from(value.toString().slice('not-plaintext:'.length), 'base64').toString(),
  };
  return {
    fetcher: fetcher as unknown as typeof fetch,
    browser,
    protector,
    requests,
    get refreshes() {
      return refreshCount;
    },
  };
}

async function service(f: ReturnType<typeof fixture>, protector = f.protector) {
  const directory = await mkdtemp(path.join(tmpdir(), 'lonely-chat-auth-'));
  privateDirs.push(directory);
  const auth = new ChatGPTAuth(directory, protector, {
    fetcher: f.fetcher,
    openBrowser: f.browser,
    now: () => now,
    issuer,
  });
  await auth.load();
  return { auth, directory };
}
const input: InferenceInput = {
  context: 'A reunion on stream',
  cycle: 1,
  playbackWindowMs: 3000,
  roster: [{ author: 'viewer', color: '#123456' }],
  recentTranscripts: [],
  recentChat: [],
  frames: [
    {
      sourceId: 'camera',
      observedAt: 10000,
      mediaTimeMs: 0,
      width: 2,
      height: 2,
      dataUrl: 'data:image/jpeg;base64,AAAA',
    },
    {
      sourceId: 'camera',
      observedAt: 11000,
      mediaTimeMs: 1000,
      width: 2,
      height: 2,
      dataUrl: 'data:image/jpeg;base64,BBBB',
    },
  ],
};
function selection(accountId: string): RemoteSelection {
  return {
    credential: null,
    connection: {
      id: 'plan',
      name: 'Plan',
      credentialMode: 'chatgpt',
      baseUrl: 'https://api.openai.com/v1',
      protocol: 'responses',
      allowInsecureLan: false,
      chatgptAccountId: accountId,
    },
    model: {
      id: 'cfg',
      name: 'Vision',
      connectionId: 'plan',
      model: 'visual-plan-model',
      images: true,
      allowRemoteImages: true,
      outputFormat: 'prompt-json',
    },
  };
}

describe('ChatGPT OAuth and subscription inference', () => {
  it('binds dynamic registration, browser state/PKCE, JWKS identity, scopes and encrypted credentials', async () => {
    const f = fixture();
    const { auth, directory } = await service(f);
    const status = await auth.signIn();
    expect(status.secureStorageAvailable).toBe(true);
    const account = status.accounts[0];
    expect(status.activeAccountId).toBe(account.id);
    expect(account).toMatchObject({
      label: 'user@example.test',
      authorized: true,
      storage: 'protected',
    });
    const browser = new URL(f.browser.mock.calls[0][0]);
    expect(browser.origin).toBe(issuer);
    expect(browser.searchParams.get('client_id')).toBe('dynamic_agent_client');
    expect(browser.searchParams.get('ext_agent_host_id')).toMatch(/^urn:uuid:/);
    expect(browser.searchParams.get('code_challenge_method')).toBe('S256');
    expect(browser.searchParams.get('scope')).toContain('chatgpt.tokens.use.direct');
    expect(JSON.stringify(status)).not.toContain(secret);
    const persisted = await readFile(path.join(directory, 'chatgpt-credentials.enc.json'), 'utf8');
    expect(persisted).not.toContain(secret);
    const catalog = await readFile(path.join(directory, 'chatgpt-accounts.json'), 'utf8');
    expect(catalog).not.toContain(secret);
    const previousHost = browser.searchParams.get('ext_agent_host_id');
    const tokenRequest = f.requests.find((entry) => entry.url.endsWith('/oauth/token'))!;
    expect(tokenRequest.body).toMatchObject({
      client_id: 'oaiapp_fixture',
      resource: 'https://api.openai.com/v1',
      grant_type: 'authorization_code',
    });
    await auth.signIn(account.id);
    const second = new URL(f.browser.mock.calls[1][0]);
    expect(second.searchParams.get('client_id')).toBe('oaiapp_fixture');
    expect(second.searchParams.get('ext_agent_host_id')).toBe(previousHost);
    expect(second.searchParams.get('agent_name_hint')).toBeNull();
    const reopen = new ChatGPTAuth(directory, f.protector, { fetcher: f.fetcher, now: () => now });
    await reopen.load();
    expect(reopen.status().accounts[0]).toMatchObject({ authorized: true, storage: 'protected' });
  });

  it('keeps the OAuth callback alive if automatic browser launch fails and allows manual retry', async () => {
    const f = fixture();
    const browser = vi
      .fn()
      .mockRejectedValueOnce(new Error('xdg-open unavailable'))
      .mockImplementation((url: string) => f.browser(url));
    const notifications: (string | null)[] = [];
    const { directory } = await service(f);
    const manual = new ChatGPTAuth(directory, f.protector, {
      fetcher: f.fetcher,
      openBrowser: browser,
      now: () => now,
      issuer,
      onAuthorizationLink: (url) => notifications.push(url),
    });
    await manual.load();
    const pending = manual.signIn();
    await vi.waitFor(() => {
      expect(notifications[0]).toContain('/api/accounts/authorize?');
      expect(browser).toHaveBeenCalledTimes(1);
    });
    const url = notifications[0]!;
    expect(manual.authorizationUrl()).toBe(url);
    expect(manual.status().accounts).toHaveLength(0);
    await manual.openAuthorizationLink();
    const status = await pending;
    expect(status.accounts).toHaveLength(1);
    expect(browser).toHaveBeenCalledTimes(2);
    expect(browser.mock.calls[1][0]).toBe(url);
    expect(manual.authorizationUrl()).toBeNull();
    expect(notifications.at(-1)).toBeNull();
    await expect(manual.openAuthorizationLink()).rejects.toThrow(/not active/);
  });

  it('allows manual copy-and-paste when the system has no browser launcher', async () => {
    const f = fixture();
    const directory = await mkdtemp(path.join(tmpdir(), 'lonely-chat-no-browser-'));
    privateDirs.push(directory);
    const notifications: (string | null)[] = [];
    const auth = new ChatGPTAuth(directory, f.protector, {
      fetcher: f.fetcher,
      now: () => now,
      issuer,
      onAuthorizationLink: (url) => notifications.push(url),
    });
    await auth.load();
    const pending = auth.signIn();
    await vi.waitFor(() => expect(auth.authorizationUrl()).toContain('/api/accounts/authorize?'));
    const url = auth.authorizationUrl()!;
    await f.browser(url); // pasted into an external browser that reaches the loopback listener
    expect((await pending).accounts).toHaveLength(1);
    expect(notifications).toEqual([url, null]);
  });

  it('accepts OIDC array audiences without relaxing issuer, client, nonce or signature validation', async () => {
    const f = fixture();
    const verify = (token: string) =>
      verifyChatGPTIdentity(token, 'oaiapp_fixture', 'expected-nonce', f.fetcher, issuer, now);
    const singleAudience = signedIdentity(['oaiapp_fixture'], 'expected-nonce');
    expect(await verify(singleAudience)).toMatchObject({ subject: 'account-123' });

    const authorizedParty = signedIdentity(
      ['oaiapp_fixture', 'other-resource'],
      'expected-nonce',
      'account-123',
      { azp: 'oaiapp_fixture' },
    );
    expect(await verify(authorizedParty)).toMatchObject({ subject: 'account-123' });

    await expect(
      verify(signedIdentity(['oaiapp_fixture', 'other-resource'], 'expected-nonce')),
    ).rejects.toThrow(/authorized party/i);
    await expect(
      verify(
        signedIdentity(['oaiapp_fixture', 'other-resource'], 'expected-nonce', 'account-123', {
          azp: 'other-resource',
        }),
      ),
    ).rejects.toThrow(/authorized party/i);
    await expect(verify(signedIdentity(['different-client'], 'expected-nonce'))).rejects.toThrow(
      /audience/i,
    );
    await expect(verify(signedIdentity(['oaiapp_fixture'], 'wrong-nonce'))).rejects.toThrow(
      /nonce/i,
    );
    await expect(
      verify(
        signedIdentity(['oaiapp_fixture'], 'expected-nonce', 'account-123', {
          iss: 'https://other-issuer.example',
        }),
      ),
    ).rejects.toThrow(/issuer/i);
    await expect(
      verify(
        signedIdentity(['oaiapp_fixture'], 'expected-nonce', 'account-123', {
          exp: now / 1000 - 10,
        }),
      ),
    ).rejects.toThrow(/expired/i);
  });

  it('denies forged state, wrong nonce/signatures, and missing plan scope', async () => {
    const forged = await service(fixture({ badState: true }));
    await expect(forged.auth.signIn()).rejects.toThrow(/state mismatch/);
    expect(forged.auth.status().accounts).toHaveLength(0);
    const nonce = await service(fixture({ badNonce: true }));
    await expect(nonce.auth.signIn()).rejects.toThrow(/identity verification/);
    expect(nonce.auth.status().accounts).toHaveLength(0);
    const permission = await service(fixture({ scopes: 'openid email profile resource.invoke' }));
    const status = await permission.auth.signIn();
    expect(status.accounts[0].authorized).toBe(false);
    await expect(permission.auth.accessToken(status.activeAccountId!)).rejects.toThrow(
      /permission/,
    );
    const f = fixture();
    await expect(
      verifyChatGPTIdentity(
        signedIdentity('oaiapp_fixture', 'nonce') + 'tamper',
        'oaiapp_fixture',
        'nonce',
        f.fetcher,
        issuer,
        now,
      ),
    ).rejects.toThrow(/signature/);
  });

  it('refreshes only once across concurrent requests, rotates refresh token, and revokes on sign-out', async () => {
    const f = fixture();
    const { auth } = await service(f);
    const account = (await auth.signIn()).activeAccountId!;
    const [first, second] = await Promise.all([
      auth.accessToken(account),
      auth.accessToken(account),
    ]);
    expect(first).toBe(`${secret}-refreshed-1`);
    expect(second).toBe(first);
    expect(f.refreshes).toBe(1);
    const result = await auth.signOut(account);
    expect(result.revoked).toBe(true);
    expect(result.status.accounts[0].authorized).toBe(false);
    const revoke = f.requests.find((entry) => entry.url.endsWith('/oauth/revoke'))!;
    expect(revoke.body).toMatchObject({ token: 'rotating-secret-1', client_id: 'oaiapp_fixture' });
    await expect(auth.accessToken(account)).rejects.toThrow(/needs sign-in/);
  });

  it('persists ChatGPT refresh tokens in a user-only file when the keyring is absent', async () => {
    const f = fixture();
    const insecure = { ...f.protector, available: () => false };
    const { auth, directory } = await service(f, insecure);
    const status = await auth.signIn();
    expect(status.secureStorageAvailable).toBe(false);
    expect(status.accounts[0].storage).toBe('file');
    await expect(
      readFile(path.join(directory, 'chatgpt-credentials.enc.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    const localPath = path.join(directory, 'private-credentials', 'chatgpt.json');
    expect(await readFile(localPath, 'utf8')).toContain(secret);
    if (process.platform !== 'win32') expect((await stat(localPath)).mode & 0o777).toBe(0o600);
    const restarted = new ChatGPTAuth(directory, insecure, { fetcher: f.fetcher, now: () => now });
    await restarted.load();
    expect(restarted.status().accounts[0].storage).toBe('file');
    expect(await restarted.accessToken(status.activeAccountId!)).toContain(secret);
  });

  it('supports session-only ChatGPT OAuth without retaining tokens on disk after restart', async () => {
    const f = fixture();
    const directory = await mkdtemp(path.join(tmpdir(), 'lonely-chat-session-only-'));
    privateDirs.push(directory);
    const policy = new CredentialPolicy(directory);
    const insecure = { ...f.protector, available: () => false };
    const auth = new ChatGPTAuth(
      directory,
      insecure,
      {
        fetcher: f.fetcher,
        openBrowser: f.browser,
        now: () => now,
        issuer,
      },
      policy,
    );
    await auth.load();
    const signed = await auth.signIn();
    const id = signed.activeAccountId!;
    const localFile = path.join(directory, 'private-credentials', 'chatgpt.json');
    expect(await readFile(localFile, 'utf8')).toContain(secret);
    await policy.setPersist(false);
    await auth.applyCredentialPolicy();
    expect(auth.status().accounts[0].storage).toBe('session');
    expect(auth.status().persistCredentials).toBe(false);
    expect(await auth.accessToken(id)).toContain(secret);
    await expect(readFile(localFile)).rejects.toMatchObject({ code: 'ENOENT' });
    const reopenedPolicy = new CredentialPolicy(directory);
    await reopenedPolicy.load();
    expect(reopenedPolicy.persist).toBe(false);
    const reopened = new ChatGPTAuth(
      directory,
      insecure,
      {
        fetcher: f.fetcher,
        now: () => now,
      },
      reopenedPolicy,
    );
    await reopened.load();
    expect(reopened.status().accounts[0].storage).toBe('missing');
    await reopenedPolicy.setPersist(true);
    await reopened.applyCredentialPolicy();
    expect(reopened.status().accounts[0].storage).toBe('missing');
    expect(reopened.status().persistCredentials).toBe(true);
  });

  it('clears a fallback OAuth credential after sign-out', async () => {
    const f = fixture();
    const insecure = { ...f.protector, available: () => false };
    const { auth, directory } = await service(f, insecure);
    const id = (await auth.signIn()).activeAccountId!;
    const localFile = path.join(directory, 'private-credentials', 'chatgpt.json');
    expect(await readFile(localFile, 'utf8')).toContain(secret);
    await auth.signOut(id);
    expect(await readFile(localFile, 'utf8')).not.toContain(secret);
    const reopened = new ChatGPTAuth(directory, insecure, { fetcher: f.fetcher, now: () => now });
    await reopened.load();
    expect(reopened.status().accounts[0].storage).toBe('missing');
  });

  it('does not restore a signed-out ChatGPT account after the keyring returns', async () => {
    const f = fixture();
    let available = true;
    const protector = { ...f.protector, available: () => available };
    const { auth, directory } = await service(f, protector);
    const id = (await auth.signIn()).activeAccountId!;
    available = false;
    await auth.signOut(id);
    const fallback = await readFile(
      path.join(directory, 'private-credentials', 'chatgpt.json'),
      'utf8',
    );
    expect(fallback).toContain('$deleted');
    available = true;
    const reopened = new ChatGPTAuth(directory, protector, { fetcher: f.fetcher, now: () => now });
    await reopened.load();
    expect(reopened.status().accounts[0].authorized).toBe(false);
    await expect(reopened.accessToken(id)).rejects.toThrow(/needs sign-in/);
  });

  it('lists account-visible models and streams timestamped images to a complete validated batch', async () => {
    const f = fixture();
    const { auth } = await service(f);
    const id = (await auth.signIn()).activeAccountId!;
    expect(await auth.models(id)).toEqual([{ id: 'visual-plan-model', name: 'Visual Plan Model' }]);
    const result = await new InferenceCoordinator().execute(
      input,
      chatGPTUnifiedAdapter(selection(id), auth, { roster: input.roster!, fetcher: f.fetcher }),
      { signal: new AbortController().signal },
    );
    expect(result.accepted.messages).toEqual([
      {
        author: 'viewer',
        text: 'Good to see you!',
        offsetMs: 100,
        color: '#123456',
      },
    ]);
    const post = f.requests.find((entry) => entry.url.endsWith('/responses'))!;
    const body = post.body as {
      store: boolean;
      stream: boolean;
      instructions: string;
      input: { content: { type: string }[] }[];
      max_output_tokens?: unknown;
      temperature?: unknown;
      text?: unknown;
    };
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(body.input[0].content.map((part) => part.type)).toEqual([
      'input_text',
      'input_text',
      'input_image',
      'input_text',
      'input_image',
    ]);
    expect(JSON.stringify(body)).toContain('observedAt=11000');
    expect(body).not.toHaveProperty('max_output_tokens');
    expect(body).not.toHaveProperty('temperature');
    expect(post.headers?.get('authorization')).toContain(secret);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(auth.status())).not.toContain(secret);
  });

  it.each(['delta', 'done', 'delta-done', 'part', 'item'] as const)(
    'accepts complete ChatGPT streams whose text is provided by %s events rather than the terminal payload',
    async (kind) => {
      const f = fixture({ sparseOutput: kind });
      const { auth } = await service(f);
      const id = (await auth.signIn()).activeAccountId!;
      const result = await new InferenceCoordinator().execute(
        input,
        chatGPTUnifiedAdapter(selection(id), auth, { roster: input.roster!, fetcher: f.fetcher }),
        { signal: new AbortController().signal },
      );
      expect(result.accepted.messages).toHaveLength(1);
      expect(result.accepted.messages[0].text).toBe('Good to see you!');
    },
  );

  it('probes a sparse completed ChatGPT response with minimal JSON', async () => {
    const f = fixture({ sparseOutput: 'done', probeOutput: true });
    const { auth } = await service(f);
    const id = (await auth.signIn()).activeAccountId!;
    const probe = await probeChatGPTModel(
      selection(id),
      auth,
      AbortSignal.timeout(5000),
      f.fetcher,
    );
    expect(probe.compatible).toBe(true);
    const sent = f.requests.find((entry) => entry.url.endsWith('/responses'))!;
    const body = sent.body as {
      instructions: string;
      input: unknown[];
      store: boolean;
      stream: boolean;
    };
    expect(body.instructions.length).toBeLessThan(1200);
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(JSON.stringify(body)).not.toContain('private-subscription-access-token');
  });

  it('rejects completed ChatGPT streams with no assistant text instead of exposing raw JSON errors', async () => {
    for (const sparseOutput of ['empty', 'reasoning-only'] as const) {
      const f = fixture({ sparseOutput });
      const { auth } = await service(f);
      const id = (await auth.signIn()).activeAccountId!;
      await expect(
        new InferenceCoordinator().execute(
          input,
          chatGPTUnifiedAdapter(selection(id), auth, { roster: input.roster!, fetcher: f.fetcher }),
          { signal: new AbortController().signal },
        ),
      ).rejects.toThrow(/ChatGPT.*no assistant text/i);
    }
  });

  it('never accepts streamed text from an interrupted or failed ChatGPT response', async () => {
    const f = fixture({ sparseOutput: 'done', partialStream: true });
    const { auth } = await service(f);
    const id = (await auth.signIn()).activeAccountId!;
    await expect(
      new InferenceCoordinator().execute(
        input,
        chatGPTUnifiedAdapter(selection(id), auth, { roster: input.roster!, fetcher: f.fetcher }),
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow(/without response.completed/);
  });

  it('rejects partial streams and provider usage exhaustion without publishing a Chat batch', async () => {
    for (const variant of [
      { partialStream: true },
      { failingStream: true },
      { code: 'subscription_sharing_usage_limit_exceeded' },
    ]) {
      const f = fixture(variant);
      const { auth } = await service(f);
      const id = (await auth.signIn()).activeAccountId!;
      const onParsed = vi.fn();
      await expect(
        new InferenceCoordinator().execute(
          input,
          chatGPTUnifiedAdapter(selection(id), auth, { roster: input.roster!, fetcher: f.fetcher }),
          { signal: new AbortController().signal, onParsed },
        ),
      ).rejects.toThrow(/ChatGPT/);
      expect(onParsed).not.toHaveBeenCalled();
    }
  });

  it('runs a ChatGPT-plan Session through the production scheduler without early publication', async () => {
    const f = fixture({ author: 'pixelpilot', ageMs: 0 });
    const { auth } = await service(f);
    const id = (await auth.signIn()).activeAccountId!;
    const sel = selection(id);
    const clock = new FakeClock();
    const chat = new ChatService();
    const session = new SessionController(chat, undefined, clock);
    session.configureRemote((sample) =>
      chatGPTUnifiedAdapter(sel, auth, {
        roster: sample.roster ?? [],
        fetcher: f.fetcher,
      }),
    );
    session.start('A reunion on stream', 'remote', sel.model.id, {
      inputMode: 'recorded',
      publishToOverlay: true,
    });
    await vi.waitFor(async () => {
      await flushMicrotasks();
      expect(
        session.snapshot().latestInferenceMs,
        JSON.stringify(session.snapshot()),
      ).not.toBeNull();
    });
    expect(chat.snapshot().messages).toHaveLength(0);
    clock.advance(200);
    await flushMicrotasks();
    expect(chat.snapshot().messages.map((entry) => entry.text)).toContain('Good to see you!');
    session.stop();
  });

  it('runs an isolated ChatGPT-plan Playground experiment through the same coordinator', async () => {
    const f = fixture();
    const { auth } = await service(f);
    const id = (await auth.signIn()).activeAccountId!;
    const sel = selection(id);
    const playground = new RemoteInferencePlayground();
    const result = await playground.run(
      {
        modelId: sel.model.id,
        values: {
          context: 'A reunion',
          cycle: 1,
          playbackWindowMs: 3000,
          chatActivity: 'normal',
          roster: [{ author: 'viewer', color: '#123456' }],
          transcripts: [],
          recentChat: [],
          observations: [],
          events: [],
        },
      },
      sel,
      undefined,
      (roster) => chatGPTUnifiedAdapter(sel, auth, { roster, fetcher: f.fetcher }),
    );
    expect(result.error).toBeNull();
    expect(result.accepted?.messages).toHaveLength(1);
    expect(result.accepted?.messages[0].author).toBe('viewer');
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(playground.busy).toBe(false);
  });

  it('blocks unsupported models, unapproved screenshots, and API-key substitution', async () => {
    const f = fixture();
    const { auth } = await service(f);
    const id = (await auth.signIn()).activeAccountId!;
    const sel = selection(id);
    const check = (value: RemoteSelection) =>
      new InferenceCoordinator().execute(
        input,
        chatGPTUnifiedAdapter(value, auth, { roster: input.roster!, fetcher: f.fetcher }),
        { signal: new AbortController().signal },
      );
    await expect(check({ ...sel, model: { ...sel.model, model: 'hidden-model' } })).rejects.toThrow(
      /not available/,
    );
    await expect(
      check({ ...sel, model: { ...sel.model, allowRemoteImages: false } }),
    ).rejects.toThrow(/does not accept image/);
    expect(() =>
      chatGPTUnifiedAdapter({ ...sel, credential: 'API-KEY-MUST-NOT-FALLBACK' }, auth, {
        roster: input.roster!,
      }),
    ).toThrow(/No API-key fallback/);
  });
});
