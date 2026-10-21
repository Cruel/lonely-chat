import {
  effectiveRemoteCapabilities,
  validateRemoteEndpoint,
  validateRemoteModel,
  type RemoteCapability,
  type RemoteConnection,
  type RemoteModelConfiguration,
} from '../shared/remote-inference-contract';
import type { RecordedRemoteRoleEvidence } from '../shared/recorded-scenario-contract';

const modelFields = [
  'id', 'name', 'connectionId', 'model', 'images', 'outputFormat', 'allowRemoteImages',
  'maxRequestsPerMinute', 'maxRequestsPerRun', 'maxTokensPerRun',
  'inputUsdPerMillion', 'outputUsdPerMillion', 'capabilityOverrides',
] as const;
const connectionFields = ['id', 'name', 'baseUrl', 'protocol', 'credentialMode', 'allowInsecureLan'] as const;
const capabilityFields = ['text', 'images', 'nativeVideo', 'jsonSchema', 'jsonObject', 'seed', 'sampling'] as const;

export function snapshotRemoteRole(
  selected: { connection: RemoteConnection; model: RemoteModelConfiguration },
): RecordedRemoteRoleEvidence {
  const { connection, model } = selected;
  return {
    connection: Object.fromEntries(connectionFields.map((key) => [key, connection[key]])),
    model: Object.fromEntries(modelFields
      .filter((key) => model[key] !== undefined)
      .map((key) => [key, model[key]])),
    capabilities: effectiveRemoteCapabilities(connection, model),
  } as unknown as RecordedRemoteRoleEvidence;
}

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid resolved remote role evidence.');
  return value as Record<string, unknown>;
};
const exact = (value: Record<string, unknown>, fields: readonly string[]): void => {
  if (Object.keys(value).some((key) => !fields.includes(key)))
    throw new Error('Resolved role evidence contains a disallowed or secret field.');
};

/** Revalidate imported and persisted evidence; credentials/account identifiers are forbidden. */
export function validateRecordedRemoteRoles(value: unknown): Record<string, RecordedRemoteRoleEvidence> {
  const roles = object(value);
  exact(roles, ['unified', 'observer', 'chat', 'memory']);
  const result: Record<string, RecordedRemoteRoleEvidence> = {};
  for (const [role, entry] of Object.entries(roles)) {
    const record = object(entry);
    exact(record, ['connection', 'model', 'capabilities']);
    const connection = object(record.connection);
    exact(connection, connectionFields);
    if (typeof connection.id !== 'string' || !connection.id ||
        typeof connection.name !== 'string' || !connection.name ||
        typeof connection.baseUrl !== 'string' ||
        typeof connection.allowInsecureLan !== 'boolean' ||
        !['responses', 'chat-completions'].includes(String(connection.protocol)) ||
        !['none', 'environment', 'managed', 'chatgpt'].includes(String(connection.credentialMode)))
      throw new Error('Invalid resolved Connection evidence.');
    validateRemoteEndpoint(connection.baseUrl, connection.allowInsecureLan);
    const rawModel = object(record.model);
    exact(rawModel, modelFields);
    const model = validateRemoteModel(rawModel);
    if (model.connectionId !== connection.id)
      throw new Error('Resolved role model/Connection mismatch.');
    const capabilities = object(record.capabilities);
    exact(capabilities, capabilityFields);
    if (capabilityFields.some((key) => typeof capabilities[key] !== 'boolean'))
      throw new Error('Invalid resolved role capabilities.');
    result[role] = {
      connection: connection as unknown as RecordedRemoteRoleEvidence['connection'],
      model: model as RecordedRemoteRoleEvidence['model'],
      capabilities: capabilities as Record<RemoteCapability, boolean>,
    };
  }
  return result;
}
