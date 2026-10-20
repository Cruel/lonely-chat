import { createHash, createPublicKey, createVerify, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SecretProtector } from './remote-inference-store';
import type { ChatGPTAccount, ChatGPTStatus, ChatGPTModel } from '../shared/chatgpt-contract';

const RESOURCE = 'https://api.openai.com/v1';
const ISSUER = 'https://auth.openai.com';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const REQUIRED = ['openid', 'resource.invoke', 'chatgpt.tokens.use.direct'];
const CALLBACK_PATH = '/auth/callback';

interface AccountRecord extends ChatGPTAccount {
  readonly subject: string;
  readonly clientId: string;
}

interface Tokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly idToken: string;
  readonly scopes: string[];
  readonly expiresAt: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

export interface ChatGPTAuthOptions {
  readonly fetcher?: typeof fetch;
  readonly openBrowser?: (url: string) => Promise<void>;
  /** Emitted only while a live loopback OAuth callback is accepting a sign-in. */
  readonly onAuthorizationLink?: (url: string | null) => void;
  readonly issuer?: string; // for local HTTP fixtures only; production is pinned
  readonly resource?: string; // for local HTTP fixtures only; production is pinned
  readonly now?: () => number;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid ChatGPT authorization response.');
  return value as Record<string, unknown>;
}
function requiredString(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 8192)
    throw new Error('Invalid ChatGPT authorization response.');
  return value;
}
function scopes(value: unknown): string[] {
  return requiredString(value).split(/\s+/).filter(Boolean);
}
function safeId(value: unknown): string {
  const id = requiredString(value);
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('Invalid ChatGPT account ID.');
  return id;
}
function b64url(value: Buffer): string {
  return value.toString('base64url');
}
function tokenResponse(raw: unknown, existing?: Tokens): Tokens {
  const r = record(raw);
  if (
    r.token_type !== 'Bearer' ||
    !Number.isFinite(r.expires_in) ||
    (r.expires_in as number) < 1 ||
    (r.expires_in as number) > 86400
  )
    throw new Error('Invalid ChatGPT token response.');
  return {
    accessToken: requiredString(r.access_token),
    refreshToken: requiredString(r.refresh_token),
    // Refresh may provide an ID token, but without an OIDC nonce challenge it is not
    // authorization to replace the previously verified account identity or login hint.
    idToken: existing ? existing.idToken : requiredString(r.id_token),
    scopes: scopes(r.scope),
    expiresAt: 0, // set at receive time, not before the network request
  };
}

/** Verify the signed OIDC ID token: discovery JWKS, alg, issuer, audience, nonce and age. */
export async function verifyChatGPTIdentity(
  jwt: string,
  clientId: string,
  nonce: string | null,
  fetcher: typeof fetch,
  issuer = ISSUER,
  now = Date.now(),
): Promise<{ subject: string; email: string | null }> {
  const parts = jwt.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length > 100_000))
    throw new Error('Invalid ChatGPT identity token.');
  let header: Record<string, unknown>, claims: Record<string, unknown>;
  try {
    header = record(JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')));
    claims = record(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')));
  } catch {
    throw new Error('Invalid ChatGPT identity token.');
  }
  // Report only the failing verification category, never untrusted claim values,
  // signed payloads, account identifiers, nonces or token material.
  const reject = (reason: string): never => {
    throw new Error(`ChatGPT identity verification failed: ${reason}.`);
  };
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid)
    reject('unsupported signing algorithm or key identifier');
  if (claims.iss !== issuer) reject('issuer mismatch');
  // RFC 7519 / OpenID Connect allow aud to be either a string or an array.
  const audiences =
    typeof claims.aud === 'string'
      ? [claims.aud]
      : Array.isArray(claims.aud) && claims.aud.every((value) => typeof value === 'string')
        ? (claims.aud as string[])
        : [];
  if (!audiences.includes(clientId)) reject('audience mismatch');
  // With multiple audiences the authorized party must identify this client.
  // Also reject a conflicting azp even with a single audience.
  if (
    (audiences.length > 1 && claims.azp !== clientId) ||
    (claims.azp !== undefined && claims.azp !== clientId)
  )
    reject('authorized party mismatch');
  if (typeof claims.sub !== 'string' || !claims.sub) reject('missing subject');
  if (!Number.isFinite(claims.exp) || (claims.exp as number) * 1000 <= now - 5_000)
    reject('token expired or missing expiry');
  if (!Number.isFinite(claims.iat) || (claims.iat as number) * 1000 > now + 5_000)
    reject('invalid issued-at time');
  if (nonce !== null && claims.nonce !== nonce) reject('nonce mismatch');
  const metadataResponse = await fetcher(`${issuer}/.well-known/openid-configuration`, {
    redirect: 'error',
  });
  if (!metadataResponse.ok) throw new Error('ChatGPT identity keys are unavailable.');
  const metadata = record(await metadataResponse.json());
  if (
    metadata.issuer !== issuer ||
    typeof metadata.jwks_uri !== 'string' ||
    !metadata.jwks_uri.startsWith(`${issuer}/`)
  )
    throw new Error('Unexpected ChatGPT identity key source.');
  const jwksResponse = await fetcher(metadata.jwks_uri, { redirect: 'error' });
  if (!jwksResponse.ok) throw new Error('ChatGPT identity keys are unavailable.');
  const keys = record(await jwksResponse.json()).keys;
  if (!Array.isArray(keys)) throw new Error('Invalid ChatGPT identity keys.');
  const jwk = keys.find((value: unknown) => {
    const k = record(value);
    return (
      k.kid === header.kid &&
      k.kty === 'RSA' &&
      (!k.alg || k.alg === 'RS256') &&
      (!k.use || k.use === 'sig')
    );
  });
  if (!jwk) throw new Error('ChatGPT identity signing key not found.');
  try {
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${parts[0]}.${parts[1]}`);
    verifier.end();
    if (
      !verifier.verify(
        createPublicKey({ key: jwk, format: 'jwk' }),
        Buffer.from(parts[2], 'base64url'),
      )
    )
      throw new Error('ChatGPT identity signature invalid.');
  } catch {
    throw new Error('ChatGPT identity signature invalid.');
  }
  return {
    subject: claims.sub as string,
    email: typeof claims.email === 'string' && claims.email.length <= 320 ? claims.email : null,
  };
}

export class ChatGPTAuth {
  private hostId = '';
  private accounts: AccountRecord[] = [];
  private selectedId: string | null = null;
  private tokens = new Map<string, Tokens>();
  private renewals = new Map<string, Promise<string>>();
  private readonly catalogCache = new Map<string, { expiresAt: number; models: ChatGPTModel[] }>();
  private signingIn = false;
  private pendingAuthorizationUrl: string | null = null;
  private requests = new Map<string, Set<AbortController>>();
  private loaded = false;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly issuer: string;
  private readonly resource: string;

  constructor(
    private readonly directory: string,
    private readonly protector: SecretProtector,
    private readonly options: ChatGPTAuthOptions = {},
  ) {
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
    this.issuer = options.issuer ?? ISSUER;
    this.resource = options.resource ?? RESOURCE;
  }

  private publicFile(): string {
    return path.join(this.directory, 'chatgpt-accounts.json');
  }
  private privateFile(): string {
    return path.join(this.directory, 'chatgpt-credentials.enc.json');
  }
  private async atomic(file: string, value: unknown): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(value) + '\n', { mode: 0o600 });
      await rename(temp, file);
    } finally {
      await rm(temp, { force: true });
    }
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    let value: unknown = null;
    try {
      value = JSON.parse(await readFile(this.publicFile(), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (value) {
      const data = record(value);
      this.hostId = requiredString(data.hostId);
      if (
        !/^urn:uuid:[0-9a-f-]{36}$/.test(this.hostId) ||
        !Array.isArray(data.accounts) ||
        data.accounts.length > 50
      )
        throw new Error('Invalid ChatGPT account catalog.');
      this.accounts = data.accounts.map((entry: unknown) => {
        const r = record(entry);
        return {
          id: safeId(r.id),
          label: requiredString(r.label),
          clientId: requiredString(r.clientId),
          subject: requiredString(r.subject),
          email: typeof r.email === 'string' ? r.email : null,
        };
      });
      this.selectedId =
        typeof data.selectedId === 'string' &&
        this.accounts.some((account) => account.id === data.selectedId)
          ? data.selectedId
          : null;
    } else {
      this.hostId = `urn:uuid:${randomUUID()}`;
      await this.savePublic();
    }
    if (this.protector.available()) {
      try {
        const stored = record(JSON.parse(await readFile(this.privateFile(), 'utf8')));
        for (const account of this.accounts) {
          if (typeof stored[account.id] !== 'string') continue;
          try {
            const data = record(
              JSON.parse(
                this.protector.decrypt(Buffer.from(stored[account.id] as string, 'base64')),
              ),
            );
            if (
              typeof data.accessToken !== 'string' ||
              typeof data.refreshToken !== 'string' ||
              typeof data.idToken !== 'string' ||
              !Array.isArray(data.scopes) ||
              !Number.isFinite(data.expiresAt)
            )
              continue;
            this.tokens.set(account.id, data as unknown as Tokens);
          } catch {
            /* keyring changed: reauthorization is required */
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    this.loaded = true;
  }

  private async savePublic(): Promise<void> {
    await this.atomic(this.publicFile(), {
      version: 1,
      hostId: this.hostId,
      accounts: this.accounts,
      selectedId: this.selectedId,
    });
  }
  private async saveCredentials(): Promise<void> {
    if (!this.protector.available()) return;
    const data: Record<string, string> = {};
    for (const [id, tokens] of this.tokens) {
      data[id] = this.protector.encrypt(JSON.stringify(tokens)).toString('base64');
    }
    await this.atomic(this.privateFile(), data);
  }

  status(): ChatGPTStatus {
    if (!this.loaded) throw new Error('ChatGPT accounts have not loaded.');
    return {
      activeAccountId: this.selectedId,
      accounts: this.accounts.map(({ id, label, email }) => ({
        id,
        label,
        email,
        authorized: REQUIRED.every((scope) => this.tokens.get(id)?.scopes.includes(scope) ?? false),
        storage: this.tokens.has(id)
          ? this.protector.available()
            ? 'protected'
            : 'session'
          : 'missing',
      })),
    };
  }

  private account(id: string): AccountRecord {
    const found = this.accounts.find((account) => account.id === safeId(id));
    if (!found) throw new Error('ChatGPT account not found. Sign in first.');
    return found;
  }
  async select(id: string): Promise<ChatGPTStatus> {
    this.account(id);
    this.selectedId = id;
    await this.savePublic();
    return this.status();
  }

  /** The URL is short-lived and may contain a private ID-token hint. Do not log or persist it. */
  authorizationUrl(): string | null {
    return this.pendingAuthorizationUrl;
  }

  /** Retry opening the exact same pending authorization request without rotating its state. */
  async openAuthorizationLink(): Promise<void> {
    const url = this.pendingAuthorizationUrl;
    if (!url) throw new Error('ChatGPT authorization is not active.');
    if (!this.options.openBrowser)
      throw new Error('System browser is unavailable; copy the link instead.');
    try {
      await this.options.openBrowser(url);
    } catch {
      throw new Error('Could not open the browser. Copy the sign-in link instead.');
    }
  }

  async signIn(accountId?: string): Promise<ChatGPTStatus> {
    if (!this.loaded) throw new Error('ChatGPT accounts have not loaded.');
    if (this.signingIn) throw new Error('A ChatGPT sign-in is already in progress.');
    const previous = accountId ? this.account(accountId) : null;
    this.signingIn = true;
    const state = b64url(randomBytes(32)),
      nonce = b64url(randomBytes(32));
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    let resolveCallback!: (url: URL) => void, rejectCallback!: (reason: Error) => void;
    const callback = new Promise<URL>((resolve, reject) => {
      resolveCallback = resolve;
      rejectCallback = reject;
    });
    // A callback can reject while system-browser open is still being awaited.
    void callback.catch(() => {});
    let used = false;
    const server = createServer((req, res) => {
      if (used) {
        res.writeHead(410).end();
        return;
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (
        req.method !== 'GET' ||
        url.pathname !== CALLBACK_PATH ||
        req.headers.host !== `127.0.0.1:${(server.address() as { port: number }).port}`
      ) {
        res.writeHead(404).end();
        return;
      }
      used = true;
      if (url.searchParams.get('state') !== state) {
        res.writeHead(400).end('Authorization state mismatch.');
        rejectCallback(new Error('ChatGPT authorization state mismatch.'));
        return;
      }
      res
        .writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        .end('Return to Lonely Chat to finish authorization.');
      resolveCallback(url);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
      });
    } catch {
      this.signingIn = false;
      throw new Error('Unable to start the local ChatGPT authorization callback listener.');
    }
    const redirectUri = `http://127.0.0.1:${(server.address() as { port: number }).port}${CALLBACK_PATH}`;
    const params = new URLSearchParams({
      client_id: previous?.clientId ?? 'dynamic_agent_client',
      ext_agent_host_id: this.hostId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: SCOPES,
      resource: this.resource,
      state,
      nonce,
      code_challenge_method: 'S256',
      code_challenge: challenge,
    });
    if (previous) {
      const hint = this.tokens.get(previous.id)?.idToken;
      if (hint) params.set('id_token_hint', hint);
      if (previous.email) params.set('login_hint', previous.email);
    } else params.set('agent_name_hint', 'Lonely Chat');
    const timeout = setTimeout(
      () => rejectCallback(new Error('ChatGPT sign-in timed out.')),
      180_000,
    );
    try {
      this.pendingAuthorizationUrl = `${this.issuer}/api/accounts/authorize?${params}`;
      this.options.onAuthorizationLink?.(this.pendingAuthorizationUrl);
      // A failed or unresponsive xdg-open must not invalidate PKCE or close the
      // loopback listener; the user can use the identical URL in another browser.
      if (this.options.openBrowser) void this.openAuthorizationLink().catch(() => {});
      const response = await callback;
      if (response.searchParams.has('error'))
        throw new Error('ChatGPT sign-in or plan consent was declined.');
      const issued = response.searchParams.get('client_id') ?? previous?.clientId;
      if (
        !issued ||
        issued === 'dynamic_agent_client' ||
        (previous && issued !== previous.clientId)
      )
        throw new Error('ChatGPT registration did not match the chosen account.');
      const code = response.searchParams.get('code');
      if (!code) throw new Error('ChatGPT authorization code missing.');
      const received = await this.postTokens({
        grant_type: 'authorization_code',
        client_id: issued,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        resource: this.resource,
      });
      const tokens = tokenResponse(received);
      const identity = await verifyChatGPTIdentity(
        tokens.idToken,
        issued,
        nonce,
        this.fetcher,
        this.issuer,
        this.now(),
      );
      if (previous && (previous.subject !== identity.subject || previous.clientId !== issued))
        throw new Error('ChatGPT account identity changed; original authorization preserved.');
      const id = previous?.id ?? randomUUID();
      const account: AccountRecord = {
        id,
        clientId: issued,
        subject: identity.subject,
        email: identity.email,
        label: identity.email ?? `ChatGPT account ${this.accounts.length + 1}`,
      };
      const updated = { ...tokens, expiresAt: this.now() + (received.expires_in as number) * 1000 };
      // Do not replace a valid previous account until a new ID token has been verified.
      this.accounts = [...this.accounts.filter((entry) => entry.id !== id), account];
      this.tokens.set(id, updated);
      this.catalogCache.delete(id);
      this.selectedId = id;
      await this.savePublic();
      await this.saveCredentials();
      return this.status();
    } finally {
      clearTimeout(timeout);
      server.close();
      this.pendingAuthorizationUrl = null;
      this.signingIn = false;
      this.options.onAuthorizationLink?.(null);
      // Avoid a dangling rejection after a browser-open error.
      void callback.catch(() => {});
    }
  }

  private async postTokens(values: Record<string, string>): Promise<TokenResponse> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.issuer}/api/accounts/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(values),
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new Error('ChatGPT token service unavailable. Sign in again later.');
    }
    if (!response.ok)
      throw new Error(`ChatGPT authorization rejected (HTTP ${response.status}). Sign in again.`);
    return record(await response.json()) as unknown as TokenResponse;
  }

  async accessToken(id: string): Promise<string> {
    this.account(id);
    const value = this.tokens.get(id);
    if (!value) throw new Error('ChatGPT account needs sign-in.');
    if (!REQUIRED.every((scope) => value.scopes.includes(scope)))
      throw new Error('ChatGPT plan usage permission was not granted. Reauthorize in Settings.');
    if (value.expiresAt > this.now() + 60_000) return value.accessToken;
    const inFlight = this.renewals.get(id);
    if (inFlight) return inFlight;
    const pending = (async () => {
      const received = await this.postTokens({
        grant_type: 'refresh_token',
        client_id: this.account(id).clientId,
        refresh_token: value.refreshToken,
        resource: this.resource,
      });
      const next = tokenResponse(received, value);
      if (!REQUIRED.every((scope) => next.scopes.includes(scope)))
        throw new Error('ChatGPT plan usage permission expired. Sign in again.');
      if (this.tokens.get(id) !== value) throw new Error('ChatGPT account session changed.');
      this.tokens.set(id, { ...next, expiresAt: this.now() + received.expires_in * 1000 });
      this.catalogCache.delete(id);
      await this.saveCredentials();
      return next.accessToken;
    })().finally(() => {
      this.renewals.delete(id);
    });
    this.renewals.set(id, pending);
    return pending;
  }

  /** Active requests are cancelled on sign-out, even when an HTTP stream is in flight. */
  requestSignal(id: string, signal: AbortSignal): { signal: AbortSignal; release: () => void } {
    this.account(id);
    const controller = new AbortController();
    const set = this.requests.get(id) ?? new Set<AbortController>();
    set.add(controller);
    this.requests.set(id, set);
    return {
      signal: AbortSignal.any([signal, controller.signal]),
      release: () => {
        set.delete(controller);
        if (!set.size) this.requests.delete(id);
      },
    };
  }

  async models(
    id: string,
    signal: AbortSignal = AbortSignal.timeout(20_000),
  ): Promise<ChatGPTModel[]> {
    const credential = await this.accessToken(id);
    const cached = this.catalogCache.get(id);
    if (cached && cached.expiresAt > this.now()) return [...cached.models];
    let response: Response;
    try {
      response = await this.fetcher(`${this.resource}/models`, {
        headers: { authorization: `Bearer ${credential}` },
        redirect: 'error',
        signal,
      });
    } catch {
      throw new Error(
        'ChatGPT account model discovery failed. Check connectivity or sign in again.',
      );
    }
    if (!response.ok)
      throw new Error(
        response.status === 401 || response.status === 403
          ? `ChatGPT account model discovery was denied (HTTP ${response.status}). Reauthorize or check plan eligibility.`
          : `ChatGPT model discovery failed (HTTP ${response.status}).`,
      );
    const data = record(await response.json()).models;
    if (!Array.isArray(data)) throw new Error('Invalid ChatGPT account model catalog.');
    const models = data
      .filter((v: unknown) => {
        const model = record(v);
        return (
          model.visibility === 'list' &&
          typeof model.slug === 'string' &&
          typeof model.display_name === 'string'
        );
      })
      .slice(0, 200)
      .map((v: unknown) => {
        const model = record(v);
        return { id: model.slug as string, name: model.display_name as string };
      });
    this.catalogCache.set(id, { expiresAt: this.now() + 60_000, models });
    return [...models];
  }

  async signOut(id: string): Promise<{ status: ChatGPTStatus; revoked: boolean }> {
    const account = this.account(id);
    for (const controller of this.requests.get(id) ?? []) controller.abort();
    const credential = this.tokens.get(id);
    // Immediately prevent new requests/refresh while remote revocation is pending.
    this.tokens.delete(id);
    this.catalogCache.delete(id);
    let revoked = !credential;
    if (credential) {
      try {
        const metadata = record(
          await (
            await this.fetcher(`${this.issuer}/.well-known/openid-configuration`, {
              redirect: 'error',
            })
          ).json(),
        );
        const endpoint = metadata.revocation_endpoint;
        if (typeof endpoint === 'string' && endpoint.startsWith(`${this.issuer}/`)) {
          const response = await this.fetcher(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              token: credential.refreshToken,
              token_type_hint: 'refresh_token',
              client_id: account.clientId,
            }),
            redirect: 'error',
            signal: AbortSignal.timeout(10_000),
          });
          revoked = response.ok;
        }
      } catch {
        /* user must be told revocation was not confirmed */
      }
    }
    await this.saveCredentials();
    return { status: this.status(), revoked };
  }
}
