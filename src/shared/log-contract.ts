/** Operational events only. Never include prompts, media, transcripts or raw model responses. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogError {
  readonly message: string;
  readonly stack?: string;
  readonly cause?: LogError;
}
export interface LogEntry {
  readonly id: string;
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly source: string;
  readonly text: string;
  readonly error?: LogError;
  readonly context?: Readonly<Record<string, string | number | boolean>>;
}
export interface LogRetention {
  readonly ageDays: number;
  readonly maxMiB: number;
}
export interface LogSnapshot {
  readonly entries: readonly LogEntry[];
  readonly retention: LogRetention;
}

export const DEFAULT_LOG_RETENTION: LogRetention = { ageDays: 14, maxMiB: 5 };

export function validateLogRetention(value: unknown): LogRetention {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid log retention settings.');
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    !Number.isInteger(record.ageDays) ||
    !Number.isInteger(record.maxMiB) ||
    (record.ageDays as number) < 1 ||
    (record.ageDays as number) > 90 ||
    (record.maxMiB as number) < 1 ||
    (record.maxMiB as number) > 100
  ) {
    throw new Error('Log retention must be 1–90 days and 1–100 MiB.');
  }
  return { ageDays: record.ageDays as number, maxMiB: record.maxMiB as number };
}
