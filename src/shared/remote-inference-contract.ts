/** Public configuration contains references only. Secrets are never returned by IPC. */
export type RemoteProtocol = 'responses' | 'chat-completions';
export type RemoteOutputFormat = 'json-schema' | 'json-object' | 'prompt-json';
export type RemoteCredentialMode = 'none' | 'environment' | 'managed';

export interface RemoteConnection {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly protocol: RemoteProtocol;
  readonly credentialMode: RemoteCredentialMode;
  readonly environmentVariable?: string;
  /** A deliberate, connection-specific approval, never a global TLS bypass. */
  readonly allowInsecureLan: boolean;
  readonly credentialStatus?: 'missing' | 'session' | 'protected';
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
    'allowInsecureLan',
    'credentialStatus',
  ]);
  const id = remoteId(v.id);
  const label = name(v.name, 'connection name', 100);
  if (v.protocol !== 'responses' && v.protocol !== 'chat-completions')
    throw new Error('Invalid API protocol.');
  if (!['none', 'environment', 'managed'].includes(v.credentialMode as string))
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
    allowInsecureLan: v.allowInsecureLan as boolean,
  };
}

export function validateRemoteModel(value: unknown): RemoteModelConfiguration {
  const v = object(value);
  exact(v, ['id', 'name', 'connectionId', 'model', 'images', 'outputFormat', 'allowRemoteImages']);
  if (typeof v.images !== 'boolean' || typeof v.allowRemoteImages !== 'boolean')
    throw new Error('Invalid model image capabilities/permission.');
  if (!['json-schema', 'json-object', 'prompt-json'].includes(v.outputFormat as string))
    throw new Error('Invalid remote output format.');
  if (v.allowRemoteImages && !v.images)
    throw new Error('Image permission requires an image-capable model.');
  return {
    id: remoteId(v.id),
    name: name(v.name, 'model configuration name', 100),
    connectionId: remoteId(v.connectionId),
    model: name(v.model, 'model identifier', 200),
    images: v.images,
    outputFormat: v.outputFormat as RemoteOutputFormat,
    allowRemoteImages: v.allowRemoteImages,
  };
}
