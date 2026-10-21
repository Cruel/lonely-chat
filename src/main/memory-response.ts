/** Transport-independent normalization for the Memory role, never a Chat batch. */
export function normalizeMemoryResponse(value: unknown, maxCharacters = 12000): { summary: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Memory response must be a JSON object.');
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).length !== 1 ||
      typeof fields.summary !== 'string' ||
      !fields.summary.trim() ||
      fields.summary.length > maxCharacters)
    throw new Error('Memory response must contain only a bounded, nonempty summary.');
  return { summary: fields.summary.trim() };
}
