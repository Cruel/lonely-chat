import {
  DEFAULT_PREFERENCES,
  validatePreferences,
  type SessionPreferences,
} from './session-contract';

export type InferenceTopology = 'unified' | 'split' | 'hybrid';
export type InferenceRole = 'unified' | 'observer' | 'chat' | 'memory';
export type ProfileModelReference =
  | { readonly kind: 'local'; readonly modelId: string }
  | { readonly kind: 'remote'; readonly modelId: string };

/** A role's request policy, not a duplicate of Simulation's prompt preset. */
export interface InferenceStageDefaults {
  readonly settings?: Partial<SessionPreferences>;
  readonly systemPrompt?: string;
  readonly userPrompt?: string;
  /** Optional bounded context independently applied to this stage. */
  readonly contextPolicy?: {
    readonly maxAgeMs: number;
    readonly maxCount: number;
    readonly maxCharacters: number;
    readonly sources: readonly ('events' | 'transcripts' | 'chat' | 'scene' | 'observations' | 'narrative' | 'interpretations' | 'significantEvents')[];
  };
  /** Vision must always emit protocol-required fields; disabled outputs are empty. */
  readonly visionOutput?: 'scene' | 'events' | 'both';
  readonly maxResponseTokens?: number;
  readonly visionOptionalFields?: readonly ('confidence' | 'notes')[];
}
export interface InferenceProfileValues {
  readonly topology: InferenceTopology;
  readonly roles: Partial<Record<InferenceRole, ProfileModelReference>>;
  readonly stageDefaults: Partial<Record<InferenceRole, InferenceStageDefaults>>;
  readonly memory?: { readonly enabled: boolean; readonly intervalMs: number; readonly maxCharacters: number; readonly expireAfterMs: number };
  readonly contextDefaults?: {
    readonly context?: string;
    readonly chatActivity?: SessionPreferences['chatActivity'];
  };
  readonly architecture?: {
    readonly execution: 'sequential' | 'asynchronous';
    readonly hybridMaxImages: number;
    readonly visionIntervalMs?: number;
    readonly chatIntervalMs?: number;
    readonly maximumWaitMs?: number;
    readonly maximumAgeMs?: number;
    readonly strictWait?: boolean;
    readonly warmIdleMs?: number;
  };
}
export interface InferenceProfile {
  readonly id: string;
  readonly name: string;
  readonly revision: number;
  readonly values: InferenceProfileValues;
}
export interface InferenceProfileSelection {
  readonly id: string;
  readonly revision: number;
}
const roles: Record<InferenceTopology, readonly InferenceRole[]> = {
  unified: ['unified'],
  split: ['observer', 'chat'],
  hybrid: ['observer', 'chat'],
};
const object = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Invalid ${label}.`);
  return value as Record<string, unknown>;
};
function exact(value: Record<string, unknown>, allowed: readonly string[], label: string) {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error(`Unexpected ${label} field.`);
}
const variables = new Set(['context', 'cycle', 'events', 'transcripts', 'chat', 'scene', 'observations', 'narrative', 'interpretations', 'significantEvents']);
function safePrompt(value: unknown) {
  if (typeof value !== 'string' || value.length > 12000) return false;
  const stripped = value.replace(/{{\s*([^{}]+?)\s*}}/g, (_part, key: string) =>
    variables.has(key) ? '' : '__invalid__');
  return !stripped.includes('__invalid__') && !stripped.includes('{{') && !stripped.includes('}}');
}

export function validateProfileValues(
  input: unknown,
  exists: (reference: ProfileModelReference, role: InferenceRole) => boolean,
): InferenceProfileValues {
  const value = object(input, 'Inference Profile');
  exact(
    value,
    ['topology', 'roles', 'stageDefaults', 'contextDefaults', 'architecture', 'memory'],
    'Inference Profile',
  );
  if (value.topology !== 'unified' && value.topology !== 'split' && value.topology !== 'hybrid')
    throw new Error('Invalid Inference Profile topology.');
  const topology = value.topology;
  const required = roles[topology];
  const assignments = object(value.roles, 'Inference Profile roles');
  if (
    Object.keys(assignments).some((key) => ![...required, 'memory'].includes(key as InferenceRole)) ||
    required.some((role) => !assignments[role])
  )
    throw new Error(`The ${topology} topology requires ${required.join(' and ')} roles.`);
  const resolved: Partial<Record<InferenceRole, ProfileModelReference>> = {};
  for (const role of [...required, ...(assignments.memory ? ['memory' as const] : [])]) {
    const ref = object(assignments[role], `${role} assignment`);
    exact(ref, ['kind', 'modelId'], `${role} model assignment`);
    if (
      (ref.kind !== 'local' && ref.kind !== 'remote') ||
      typeof ref.modelId !== 'string' ||
      !ref.modelId ||
      ref.modelId.length > 200
    )
      throw new Error(`Invalid ${role} model assignment.`);
    const model = { kind: ref.kind, modelId: ref.modelId } as ProfileModelReference;
    if (!exists(model, role))
      throw new Error(
        `Missing or incompatible ${role} ${model.kind} Model Configuration: ${model.modelId}.`,
      );
    resolved[role] = model;
  }
  const defaults = object(value.stageDefaults, 'Inference Profile stage defaults');
  exact(defaults, [...required, 'memory'], 'stage default role');
  const stages: Partial<Record<InferenceRole, InferenceStageDefaults>> = {};
  for (const [role, raw] of Object.entries(defaults)) {
    const stage = object(raw, `${role} stage defaults`);
    exact(stage, ['settings', 'systemPrompt', 'userPrompt', 'contextPolicy', 'visionOutput', 'maxResponseTokens', 'visionOptionalFields'], `${role} stage default`);
    if (stage.visionOutput !== undefined &&
      (role !== 'observer' || !['scene', 'events', 'both'].includes(String(stage.visionOutput))))
      throw new Error('Invalid Vision output selection.');
    if (stage.visionOptionalFields !== undefined &&
      (role !== 'observer' || !Array.isArray(stage.visionOptionalFields) ||
        stage.visionOptionalFields.some((v: unknown) => v !== 'confidence' && v !== 'notes') ||
        new Set(stage.visionOptionalFields).size !== stage.visionOptionalFields.length))
      throw new Error('Invalid optional Vision fields.');
    if (stage.maxResponseTokens !== undefined &&
      (!Number.isSafeInteger(stage.maxResponseTokens) || (stage.maxResponseTokens as number) < 128 ||
        (stage.maxResponseTokens as number) > 8192))
      throw new Error('Invalid stage response token budget.');
    let contextPolicy: InferenceStageDefaults['contextPolicy'];
    if (stage.contextPolicy !== undefined) {
      const policy = object(stage.contextPolicy, 'stage context policy');
      exact(policy, ['maxAgeMs', 'maxCount', 'maxCharacters', 'sources'], 'stage context policy');
      if (!Number.isSafeInteger(policy.maxAgeMs) || (policy.maxAgeMs as number) < 1000 ||
          (policy.maxAgeMs as number) > 3600000 ||
          !Number.isSafeInteger(policy.maxCount) || (policy.maxCount as number) < 0 ||
          (policy.maxCount as number) > 256 ||
          !Number.isSafeInteger(policy.maxCharacters) || (policy.maxCharacters as number) < 512 ||
          (policy.maxCharacters as number) > 100000 ||
          !Array.isArray(policy.sources) ||
          policy.sources.some((source: unknown) => !['events','transcripts','chat','scene','observations','narrative','interpretations','significantEvents'].includes(String(source))) ||
          new Set(policy.sources).size !== policy.sources.length)
        throw new Error('Invalid stage context policy.');
      contextPolicy = policy as unknown as NonNullable<InferenceStageDefaults['contextPolicy']>;
    }
    if (
      (stage.systemPrompt !== undefined && !safePrompt(stage.systemPrompt)) ||
      (stage.userPrompt !== undefined && !safePrompt(stage.userPrompt))
    )
      throw new Error(`Invalid ${role} stage prompt.`);
    let settings: Partial<SessionPreferences> | undefined;
    if (stage.settings !== undefined) {
      const preferences = object(stage.settings, `${role} settings`);
      exact(preferences, Object.keys(DEFAULT_PREFERENCES), `${role} preference`);
      validatePreferences({ ...DEFAULT_PREFERENCES, ...preferences });
      settings = preferences as Partial<SessionPreferences>;
    }
    stages[role as InferenceRole] = {
      ...(settings ? { settings } : {}),
      ...(stage.systemPrompt !== undefined ? { systemPrompt: stage.systemPrompt as string } : {}),
      ...(stage.userPrompt !== undefined ? { userPrompt: stage.userPrompt as string } : {}),
      ...(contextPolicy ? { contextPolicy } : {}),
      ...(stage.maxResponseTokens !== undefined ? { maxResponseTokens: stage.maxResponseTokens as number } : {}),
      ...(stage.visionOutput !== undefined ? { visionOutput: stage.visionOutput as 'scene' | 'events' | 'both' } : {}),
      ...(stage.visionOptionalFields !== undefined ? { visionOptionalFields: stage.visionOptionalFields as ('confidence' | 'notes')[] } : {}),
    };
  }
  let memory: InferenceProfileValues['memory'];
  if (value.memory !== undefined) {
    const entry = object(value.memory, 'narrative memory');
    exact(entry, ['enabled', 'intervalMs', 'maxCharacters', 'expireAfterMs'], 'narrative memory');
    if (typeof entry.enabled !== 'boolean' ||
      !Number.isSafeInteger(entry.intervalMs) || (entry.intervalMs as number) < 1000 || (entry.intervalMs as number) > 3600000 ||
      !Number.isSafeInteger(entry.maxCharacters) || (entry.maxCharacters as number) < 256 || (entry.maxCharacters as number) > 12000 ||
      !Number.isSafeInteger(entry.expireAfterMs) || (entry.expireAfterMs as number) < 0 || (entry.expireAfterMs as number) > 86400000)
      throw new Error('Invalid narrative memory policy.');
    memory = entry as unknown as NonNullable<InferenceProfileValues['memory']>;
  }
  let contextDefaults: InferenceProfileValues['contextDefaults'];
  if (value.contextDefaults !== undefined) {
    const context = object(value.contextDefaults, 'profile context defaults');
    exact(context, ['context', 'chatActivity'], 'context default');
    if (
      (context.context !== undefined &&
        (typeof context.context !== 'string' || context.context.length > 2000)) ||
      (context.chatActivity !== undefined &&
        !['quiet', 'normal', 'busy'].includes(String(context.chatActivity)))
    )
      throw new Error('Invalid Inference Profile context defaults.');
    contextDefaults = context as InferenceProfileValues['contextDefaults'];
  }
  let architecture: InferenceProfileValues['architecture'];
  if (value.architecture !== undefined) {
    const config = object(value.architecture, 'Inference Profile architecture');
    exact(
      config,
      [
        'execution',
        'hybridMaxImages',
        'visionIntervalMs',
        'chatIntervalMs',
        'maximumWaitMs',
        'maximumAgeMs',
        'strictWait',
        'warmIdleMs',
      ],
      'architecture',
    );
    for (const key of [
      'visionIntervalMs',
      'chatIntervalMs',
      'maximumWaitMs',
      'maximumAgeMs',
      'warmIdleMs',
    ] as const) {
      if (
        config[key] !== undefined &&
        (typeof config[key] !== 'number' ||
          !Number.isSafeInteger(config[key]) ||
          (config[key] as number) < 0 ||
          (config[key] as number) > 600000)
      )
        throw new Error(`Invalid ${key} stage scheduling limit.`);
    }
    if (config.strictWait !== undefined && typeof config.strictWait !== 'boolean')
      throw new Error('Invalid strict-wait policy.');
    if (
      (config.execution !== 'sequential' && config.execution !== 'asynchronous') ||
      typeof config.hybridMaxImages !== 'number' ||
      !Number.isSafeInteger(config.hybridMaxImages) ||
      config.hybridMaxImages < 0 ||
      config.hybridMaxImages > 24 ||
      (topology !== 'hybrid' && config.hybridMaxImages !== 0)
    )
      throw new Error('Invalid architecture execution or Hybrid image budget.');
    architecture = {
      execution: config.execution,
      hybridMaxImages: config.hybridMaxImages,
      ...(config.visionIntervalMs !== undefined
        ? { visionIntervalMs: config.visionIntervalMs as number }
        : {}),
      ...(config.chatIntervalMs !== undefined
        ? { chatIntervalMs: config.chatIntervalMs as number }
        : {}),
      ...(config.maximumWaitMs !== undefined
        ? { maximumWaitMs: config.maximumWaitMs as number }
        : {}),
      ...(config.maximumAgeMs !== undefined ? { maximumAgeMs: config.maximumAgeMs as number } : {}),
      ...(config.strictWait !== undefined ? { strictWait: config.strictWait as boolean } : {}),
      ...(config.warmIdleMs !== undefined ? { warmIdleMs: config.warmIdleMs as number } : {}),
    };
  }
  return {
    topology,
    roles: resolved,
    stageDefaults: stages,
    ...(memory ? { memory } : {}),
    ...(contextDefaults ? { contextDefaults } : {}),
    ...(architecture ? { architecture } : {}),
  };
}

/** Resolve a frozen Unified policy. Prompt presets override context only, never stage policy. */
export function resolveUnifiedProfilePolicy(
  profile: InferenceProfile | null,
  preferences: SessionPreferences,
  context: string,
  preset?: { readonly context: string; readonly chatActivity: SessionPreferences['chatActivity'] },
): { settings: SessionPreferences; context: string; model: ProfileModelReference | null } {
  const settings = validatePreferences({
    ...preferences,
    ...profile?.values.stageDefaults.unified?.settings,
    ...(profile?.values.contextDefaults?.chatActivity
      ? { chatActivity: profile.values.contextDefaults.chatActivity }
      : {}),
    ...(preset ? { chatActivity: preset.chatActivity } : {}),
  });
  return {
    settings,
    context: preset ? preset.context : context || profile?.values.contextDefaults?.context || '',
    model: profile?.values.roles.unified ?? null,
  };
}

export function validateProfileSnapshot(value: unknown): InferenceProfile {
  const profile = object(value, 'saved Inference Profile snapshot');
  exact(profile, ['id', 'name', 'revision', 'values'], 'saved profile');
  if (
    typeof profile.id !== 'string' ||
    !/^[0-9a-f-]{36}$/i.test(profile.id) ||
    typeof profile.name !== 'string' ||
    !profile.name.trim() ||
    profile.name.length > 80 ||
    typeof profile.revision !== 'number' ||
    !Number.isSafeInteger(profile.revision) ||
    profile.revision < 1
  )
    throw new Error('Invalid saved Inference Profile metadata.');
  return {
    id: profile.id,
    name: profile.name,
    revision: profile.revision,
    values: validateProfileValues(profile.values, () => true),
  };
}
