/** Public configuration contains references only. Secrets are never returned by IPC. */
export type RemoteProtocol = 'responses' | 'chat-completions';
export type RemoteOutputFormat = 'json-schema' | 'json-object' | 'prompt-json';
export type RemoteCredentialMode = 'none' | 'environment' | 'managed' | 'chatgpt';

export const REMOTE_CAPABILITIES = [
  'text',
  'images',
  'nativeVideo',
  'jsonSchema',
  'jsonObject',
  'seed',
  'sampling',
] as const;
export type RemoteCapability = (typeof REMOTE_CAPABILITIES)[number];
export type RemoteCapabilityFlags = Partial<Record<RemoteCapability, boolean>>;

/** Evidence is tied to a particular endpoint, account, protocol and model ID. */
export interface RemoteCapabilityEvidence {
  readonly connectionKey: string;
  readonly model: string;
  readonly checkedAt: number;
  readonly source: 'metadata' | 'probe';
  readonly support: RemoteCapabilityFlags;
  /** Per-flag provenance is retained when metadata and probes are merged. */
  readonly sources?: Partial<Record<RemoteCapability, 'metadata' | 'probe'>>;
  readonly checkedAtByCapability?: Partial<Record<RemoteCapability, number>>;
}

export function remoteConnectionKey(connection: RemoteConnection): string {
  return JSON.stringify([
    connection.id,
    connection.baseUrl,
    connection.protocol,
    connection.credentialMode,
    connection.environmentVariable ?? null,
    connection.chatgptAccountId ?? null,
  ]);
}

export function currentCapabilityEvidence(
  connection: RemoteConnection,
  model: RemoteModelConfiguration,
  now = Date.now(),
): RemoteCapabilityEvidence | null {
  const evidence = model.capabilityEvidence;
  return evidence &&
    evidence.connectionKey === remoteConnectionKey(connection) &&
    evidence.model === model.model &&
    evidence.checkedAt <= now &&
    now - evidence.checkedAt < 24 * 60 * 60 * 1000
    ? evidence
    : null;
}

/** Unverified endpoint claims are not proof; manual overrides remain explicit. */
export function effectiveRemoteCapabilities(
  connection: RemoteConnection,
  model: RemoteModelConfiguration,
  now = Date.now(),
): Record<RemoteCapability, boolean> {
  const chatgpt = connection.credentialMode === 'chatgpt';
  const verified = currentCapabilityEvidence(connection, model, now);
  const evidence = verified?.support;
  const defaults: Record<RemoteCapability, boolean> = {
    text: true,
    images: model.images,
    nativeVideo: false,
    jsonSchema: !chatgpt && model.outputFormat === 'json-schema',
    jsonObject: !chatgpt && model.outputFormat === 'json-object',
    seed: !chatgpt && connection.protocol === 'chat-completions',
    sampling: !chatgpt && connection.protocol === 'chat-completions',
  };
  for (const capability of REMOTE_CAPABILITIES) {
    const checkedAt = verified?.checkedAtByCapability?.[capability] ?? verified?.checkedAt;
    if (
      evidence?.[capability] !== undefined &&
      checkedAt !== undefined &&
      checkedAt <= now &&
      now - checkedAt < 24 * 60 * 60 * 1000
    )
      defaults[capability] = evidence[capability];
    if (model.capabilityOverrides?.[capability] !== undefined)
      defaults[capability] = model.capabilityOverrides[capability];
  }
  // Endpoint claims cannot enable a transport format our adapter cannot serialize.
  defaults.nativeVideo = false;
  // Neither the standard Responses request builder nor the plan route sends seed.
  if (connection.protocol === 'responses') defaults.seed = false;
  if (chatgpt) {
    defaults.jsonSchema = false;
    defaults.jsonObject = false;
    defaults.seed = false;
    defaults.sampling = false;
  }
  return defaults;
}

function validateCapabilityTimestamps(
  value: unknown,
): NonNullable<RemoteCapabilityEvidence['checkedAtByCapability']> {
  const v = object(value);
  exact(v, [...REMOTE_CAPABILITIES]);
  if (
    Object.values(v).some(
      (entry) => typeof entry !== 'number' || !Number.isSafeInteger(entry) || entry < 0,
    )
  )
    throw new Error('Invalid capability check timestamp.');
  return v as NonNullable<RemoteCapabilityEvidence['checkedAtByCapability']>;
}

function validateCapabilitySources(
  value: unknown,
): NonNullable<RemoteCapabilityEvidence['sources']> {
  const v = object(value);
  exact(v, [...REMOTE_CAPABILITIES]);
  if (Object.values(v).some((entry) => entry !== 'metadata' && entry !== 'probe'))
    throw new Error('Invalid capability provenance.');
  return v as NonNullable<RemoteCapabilityEvidence['sources']>;
}

function validateCapabilityFlags(value: unknown): RemoteCapabilityFlags {
  const v = object(value);
  exact(v, [...REMOTE_CAPABILITIES]);
  if (Object.values(v).some((entry) => typeof entry !== 'boolean'))
    throw new Error('Capability values must be booleans.');
  return v as RemoteCapabilityFlags;
}

export interface RemoteConnection {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly protocol: RemoteProtocol;
  readonly credentialMode: RemoteCredentialMode;
  readonly environmentVariable?: string;
  /** Exact ChatGPT registration, never an API key or implicit paid fallback. */
  readonly chatgptAccountId?: string;
  /** A deliberate, connection-specific approval, never a global TLS bypass. */
  readonly allowInsecureLan: boolean;
  readonly credentialStatus?: 'missing' | 'session' | 'protected' | 'file';
}

export interface RemoteModelConfiguration {
  readonly id: string;
  readonly name: string;
  readonly connectionId: string;
  readonly model: string;
  readonly images: boolean;
  readonly outputFormat: RemoteOutputFormat;
  /** Requires explicit permission to transmit screenshots over this Connection. */
  readonly allowRemoteImages: boolean;
  /** Manual compatibility overrides, distinct from the model's chosen output format. */
  readonly capabilityOverrides?: RemoteCapabilityFlags;
  readonly capabilityEvidence?: RemoteCapabilityEvidence;
}

export interface RemoteCatalog {
  readonly connections: readonly RemoteConnection[];
  readonly models: readonly RemoteModelConfiguration[];
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid remote inference configuration.');
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error('Unexpected remote configuration fields.');
}
function name(value: unknown, label: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error(`Invalid ${label}.`);
  return value.trim();
}
export function validRemoteId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id);
}
function remoteId(value: unknown): string {
  if (!validRemoteId(value)) throw new Error('Invalid connection/model ID.');
  return value;
}

/** Validate both location and approval on every save AND before each request. */
export function validateRemoteEndpoint(baseUrl: string, allowInsecureLan: boolean): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('Invalid remote endpoint URL.');
  }
  if (url.username || url.password || url.search || url.hash)
    throw new Error('Endpoint URLs cannot contain credentials, query parameters or fragments.');
  if (url.protocol === 'https:') return url.toString().replace(/\/$/, '');
  if (url.protocol !== 'http:') throw new Error('Remote endpoints must use HTTPS.');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host))
    return url.toString().replace(/\/$/, '');
  const segments = host.split('.').map(Number);
  const privateIp =
    segments.length === 4 &&
    segments.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) &&
    (segments[0] === 10 ||
      (segments[0] === 172 && segments[1] >= 16 && segments[1] <= 31) ||
      (segments[0] === 192 && segments[1] === 168));
  const lan =
    privateIp ||
    host.endsWith('.local') ||
    host.startsWith('fc') ||
    host.startsWith('fd') ||
    host.startsWith('fe80:');
  if (!lan || !allowInsecureLan)
    throw new Error(
      'HTTP is allowed only for loopback or explicitly acknowledged private LAN endpoints.',
    );
  return url.toString().replace(/\/$/, '');
}

export function validateRemoteConnection(value: unknown): RemoteConnection {
  const v = object(value);
  exact(v, [
    'id',
    'name',
    'baseUrl',
    'protocol',
    'credentialMode',
    'environmentVariable',
    'chatgptAccountId',
    'allowInsecureLan',
    'credentialStatus',
  ]);
  const id = remoteId(v.id);
  const label = name(v.name, 'connection name', 100);
  if (v.protocol !== 'responses' && v.protocol !== 'chat-completions')
    throw new Error('Invalid API protocol.');
  if (!['none', 'environment', 'managed', 'chatgpt'].includes(v.credentialMode as string))
    throw new Error('Invalid credential mode.');
  if (typeof v.allowInsecureLan !== 'boolean') throw new Error('Invalid LAN approval.');
  const env =
    v.credentialMode === 'environment'
      ? name(v.environmentVariable, 'environment variable', 100)
      : undefined;
  if (env && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(env))
    throw new Error('Invalid environment variable name.');
  if (v.credentialMode !== 'environment' && v.environmentVariable !== undefined)
    throw new Error('Unexpected environment credential reference.');
  const accountId = v.credentialMode === 'chatgpt' ? remoteId(v.chatgptAccountId) : undefined;
  if (v.credentialMode !== 'chatgpt' && v.chatgptAccountId !== undefined)
    throw new Error('Unexpected ChatGPT account reference.');
  if (
    accountId &&
    (v.protocol !== 'responses' || v.baseUrl !== 'https://api.openai.com/v1' || v.allowInsecureLan)
  )
    throw new Error('ChatGPT plan Connections require the official HTTPS Responses endpoint.');
  return {
    id,
    name: label,
    baseUrl: validateRemoteEndpoint(
      name(v.baseUrl, 'base URL', 2048),
      v.allowInsecureLan as boolean,
    ),
    protocol: v.protocol,
    credentialMode: v.credentialMode as RemoteCredentialMode,
    ...(env ? { environmentVariable: env } : {}),
    ...(accountId ? { chatgptAccountId: accountId } : {}),
    allowInsecureLan: v.allowInsecureLan as boolean,
  };
}

export function validateRemoteModel(value: unknown): RemoteModelConfiguration {
  const v = object(value);
  exact(v, [
    'id',
    'name',
    'connectionId',
    'model',
    'images',
    'outputFormat',
    'allowRemoteImages',
    'capabilityOverrides',
    'capabilityEvidence',
  ]);
  if (typeof v.images !== 'boolean' || typeof v.allowRemoteImages !== 'boolean')
    throw new Error('Invalid model image capabilities/permission.');
  if (!['json-schema', 'json-object', 'prompt-json'].includes(v.outputFormat as string))
    throw new Error('Invalid remote output format.');
  if (v.allowRemoteImages && !v.images)
    throw new Error('Image permission requires an image-capable model.');
  let evidence: RemoteCapabilityEvidence | undefined;
  if (v.capabilityEvidence !== undefined) {
    const e = object(v.capabilityEvidence);
    exact(e, [
      'connectionKey',
      'model',
      'checkedAt',
      'source',
      'support',
      'sources',
      'checkedAtByCapability',
    ]);
    if (
      typeof e.connectionKey !== 'string' ||
      e.connectionKey.length > 4096 ||
      typeof e.model !== 'string' ||
      e.model.length > 200 ||
      typeof e.checkedAt !== 'number' ||
      !Number.isSafeInteger(e.checkedAt) ||
      e.checkedAt < 0 ||
      (e.source !== 'metadata' && e.source !== 'probe')
    )
      throw new Error('Invalid capability evidence.');
    evidence = {
      connectionKey: e.connectionKey,
      model: e.model,
      checkedAt: e.checkedAt,
      source: e.source,
      support: validateCapabilityFlags(e.support),
      ...(e.sources === undefined ? {} : { sources: validateCapabilitySources(e.sources) }),
      ...(e.checkedAtByCapability === undefined
        ? {}
        : { checkedAtByCapability: validateCapabilityTimestamps(e.checkedAtByCapability) }),
    };
  }
  return {
    id: remoteId(v.id),
    name: name(v.name, 'model configuration name', 100),
    connectionId: remoteId(v.connectionId),
    model: name(v.model, 'model identifier', 200),
    images: v.images,
    outputFormat: v.outputFormat as RemoteOutputFormat,
    allowRemoteImages: v.allowRemoteImages,
    ...(v.capabilityOverrides === undefined
      ? {}
      : { capabilityOverrides: validateCapabilityFlags(v.capabilityOverrides) }),
    ...(evidence ? { capabilityEvidence: evidence } : {}),
  };
}
