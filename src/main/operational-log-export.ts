import type { LogEntry } from '../shared/log-contract';

/** Never trust renderer-supplied entry contents or file paths; select IDs from main-owned logs. */
export function serializeOperationalLogs(
  entries: readonly LogEntry[],
  selectedIds: unknown,
): string {
  if (
    !Array.isArray(selectedIds) ||
    selectedIds.length < 1 ||
    selectedIds.length > 1000 ||
    selectedIds.some(
      (id: unknown) => typeof id !== 'string' || id.length > 80 || !/^[\w-]+$/.test(id),
    ) ||
    new Set(selectedIds).size !== selectedIds.length
  )
    throw new Error('Invalid operational log selection.');
  const ids = new Set(selectedIds as string[]);
  const chosen = entries.filter((entry) => ids.has(entry.id));
  if (!chosen.length) throw new Error('The selected operational logs are no longer retained.');
  return chosen.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
}
