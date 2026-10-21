import type { InferenceStageDefaults } from '../shared/inference-profile-contract';

/** One application validator for both sequential and asynchronous Vision. */
export function validateVisionStageResult(
  value: unknown,
  policy?: InferenceStageDefaults,
): { sceneState: string; events: unknown[]; messages: [] } {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid Vision stage output.');
  const fields = value as Record<string, unknown>;
  if (typeof fields.sceneState !== 'string' || fields.sceneState.length > 2000 ||
      !Array.isArray(fields.events) || !Array.isArray(fields.messages) ||
      fields.messages.length !== 0 ||
      Object.keys(fields).some((key) =>
        !['events', 'messages', 'sceneState', ...(policy?.visionOptionalFields ?? [])].includes(key)))
    throw new Error('Invalid Vision stage schema.');
  const choice = policy?.visionOutput ?? 'both';
  if (choice === 'events' && fields.sceneState !== '')
    throw new Error('Vision output must omit scene state in Events-only mode.');
  if (choice === 'scene' && fields.events.length)
    throw new Error('Vision output must omit Events in Scene-only mode.');
  if ((fields.confidence !== undefined &&
      (typeof fields.confidence !== 'number' || !Number.isFinite(fields.confidence) ||
        fields.confidence < 0 || fields.confidence > 1)) ||
      (fields.notes !== undefined && (typeof fields.notes !== 'string' || fields.notes.length > 1000)))
    throw new Error('Invalid optional Vision field.');
  return { sceneState: fields.sceneState, events: fields.events, messages: [] };
}
