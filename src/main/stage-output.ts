import type { InferenceRequest, UnifiedInferenceRequest } from './unified-inference-request';
import { normalizeMemoryResponse } from './memory-response';

/** Strict providers encode optional properties as required nullable fields.
 * Restore their original optional semantics before application validation. */
export function restoreOptionalFields(value: unknown, request: UnifiedInferenceRequest): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const schema = request.response.schema as unknown as { properties?: Record<string, unknown>; required?: readonly string[] };
  const required = new Set(schema.required ?? []);
  const restored = { ...value } as Record<string, unknown>;
  for (const key of Object.keys(schema.properties ?? {})) {
    if (!required.has(key) && restored[key] === null) delete restored[key];
  }
  return restored;
}

export function normalizeStageMemory(value: unknown, request: UnifiedInferenceRequest): unknown {
  if ((request as InferenceRequest).role !== 'memory') return restoreOptionalFields(value, request);
  const schema = request.response.schema as unknown as { properties?: { summary?: { maxLength?: number } } };
  return normalizeMemoryResponse(value, schema.properties?.summary?.maxLength ?? 12000);
}
