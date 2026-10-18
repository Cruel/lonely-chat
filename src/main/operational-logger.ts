import { randomUUID } from 'node:crypto';
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_LOG_RETENTION,
  validateLogRetention,
  type LogEntry,
  type LogError,
  type LogLevel,
  type LogRetention,
  type LogSnapshot,
} from '../shared/log-contract';

export type OperationalErrorSink = (
  source: string,
  text: string,
  error?: unknown,
  context?: Record<string, unknown>,
) => void;

const LOG_DIRECTORY = 'operational-logs';
const SETTINGS_FILE = 'retention.json';
const RUN_MARKER = 'active-session.json';
const MAX_MEMORY_ENTRIES = 1000;
const MAX_ENTRY_BYTES = 16 * 1024;
const FILE_ROTATE_BYTES = 256 * 1024;
const SAFE_CONTEXT_KEYS = new Set([
  'backend',
  'phase',
  'code',
  'exitCode',
  'port',
  'worker',
  'cycle',
  'attempt',
  'modelRole',
  'sourceKind',
  'operation',
  'reason',
]);

/** Mask common credential forms even in Error.message, Error.stack and Error.cause. */
function redact(value: string): string {
  return value
    .replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
    .replace(
      /\b(authorization|api[_-]?key|access[_-]?token|secret|password|token)\s*[:=]\s*[^\s,;]+/gi,
      '$1=[REDACTED]',
    )
    .replace(/\b(sk-[a-zA-Z0-9_-]{12,})\b/g, '[REDACTED]')
    .slice(0, 8000);
}
function clean(value: string, limit = 8000): string {
  return redact(value).slice(0, limit);
}
function safeError(error: unknown, depth = 0): LogError {
  if (!(error instanceof Error)) return { message: clean(String(error)) };
  const result: { message: string; stack?: string; cause?: LogError } = {
    message: clean(error.message, 1200),
    ...(error.stack ? { stack: clean(error.stack, 3500) } : {}),
  };
  if (depth < 2 && error.cause !== undefined) result.cause = safeError(error.cause, depth + 1);
  return result;
}
function safeContext(
  context?: Record<string, unknown>,
): Record<string, string | number | boolean> | undefined {
  if (!context) return;
  const safe: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(context)) {
    if (!SAFE_CONTEXT_KEYS.has(key)) continue;
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
      safe[key] = value;
    } else if (typeof value === 'string') {
      safe[key] = clean(value, 100);
    }
  }
  return Object.keys(safe).length ? safe : undefined;
}
function parseLine(line: string): LogEntry | null {
  try {
    const entry: unknown = JSON.parse(line);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const value = entry as Record<string, unknown>;
    if (
      typeof value.id !== 'string' ||
      typeof value.timestamp !== 'string' ||
      !['debug', 'info', 'warn', 'error'].includes(String(value.level)) ||
      typeof value.source !== 'string' ||
      typeof value.text !== 'string'
    )
      return null;
    return entry as LogEntry;
  } catch {
    return null; // A torn final line must never prevent startup.
  }
}

/** Single main-process owner. Append-only log files, bounded on disk and in memory. */
export class OperationalLogger {
  private readonly directory: string;
  private entries: LogEntry[] = [];
  private readonly pending: LogEntry[] = [];
  private readonly listeners = new Set<(entry: LogEntry) => void>();
  private retention: LogRetention = DEFAULT_LOG_RETENTION;
  private writes: Promise<void> = Promise.resolve();
  private opening: Promise<void> | null = null;
  private initialized = false;
  private closed = false;
  private activeFile: string | null = null;
  private activeBytes = 0;
  private bytesSincePrune = 0;

  constructor(userData: string) {
    this.directory = path.join(userData, LOG_DIRECTORY);
  }

  snapshot(): LogSnapshot {
    return { entries: [...this.entries], retention: { ...this.retention } };
  }

  subscribe(listener: (entry: LogEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  debug(source: string, text: string, context?: Record<string, unknown>): void {
    this.log('debug', source, text, undefined, context);
  }
  info(source: string, text: string, context?: Record<string, unknown>): void {
    this.log('info', source, text, undefined, context);
  }
  warn(source: string, text: string, error?: unknown, context?: Record<string, unknown>): void {
    this.log('warn', source, text, error, context);
  }
  error(source: string, text: string, error?: unknown, context?: Record<string, unknown>): void {
    this.log('error', source, text, error, context);
  }

  private log(
    level: LogLevel,
    source: string,
    text: string,
    error?: unknown,
    context?: Record<string, unknown>,
  ): void {
    if (this.closed) return;
    const filteredContext = safeContext(context);
    const entry: LogEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      level,
      source: clean(source, 64).replace(/[\r\n]+/g, ' '),
      text: clean(text, 2000).replace(/[\r\n]+/g, ' '),
      ...(error === undefined ? {} : { error: safeError(error) }),
      ...(filteredContext ? { context: filteredContext } : {}),
    };
    // Bound both individual entries and the in-memory listing.
    if (Buffer.byteLength(JSON.stringify(entry)) > MAX_ENTRY_BYTES) {
      const short = {
        ...entry,
        error: entry.error
          ? { ...entry.error, stack: entry.error.stack?.slice(0, 1000), cause: undefined }
          : undefined,
      };
      this.record(short);
    } else {
      this.record(entry);
    }
  }

  private record(entry: LogEntry): void {
    this.entries.push(entry);
    if (this.entries.length > MAX_MEMORY_ENTRIES) this.entries.shift();
    if (this.initialized) this.enqueue(entry);
    else this.pending.push(entry);
    for (const listener of this.listeners) listener(entry);
  }

  open(): Promise<void> {
    if (this.opening) return this.opening;
    this.opening = this.initialize();
    return this.opening;
  }

  private async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const raw: unknown = JSON.parse(
        await readFile(path.join(this.directory, SETTINGS_FILE), 'utf8'),
      );
      this.retention = validateLogRetention(raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.warn('logger', 'Invalid log retention settings; using defaults', error);
      }
    }
    await this.prune();
    const history: LogEntry[] = [];
    for (const file of await this.logFiles()) {
      const contents = await readFile(path.join(this.directory, file), 'utf8');
      for (const line of contents.split('\n')) {
        if (!line) continue;
        const entry = parseLine(line);
        if (entry) history.push(entry);
        if (history.length > MAX_MEMORY_ENTRIES) history.shift();
      }
    }
    // Files sorted oldest to newest; pending startup events follow last run's history.
    this.entries = [...history, ...this.pending].slice(-MAX_MEMORY_ENTRIES);
    const marker = path.join(this.directory, RUN_MARKER);
    try {
      await stat(marker);
      this.warn('application', 'The previous session may have terminated abnormally.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await writeFile(
      marker,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
      { mode: 0o600 },
    );
    this.initialized = true;
    for (const entry of this.pending.splice(0)) this.enqueue(entry);
    await this.flush();
  }

  async configure(value: unknown): Promise<LogRetention> {
    const retention = validateLogRetention(value);
    await this.open();
    const temp = path.join(this.directory, SETTINGS_FILE + '.' + randomUUID() + '.tmp');
    try {
      await writeFile(temp, JSON.stringify(retention) + '\n', { mode: 0o600 });
      await rename(temp, path.join(this.directory, SETTINGS_FILE));
    } finally {
      await rm(temp, { force: true });
    }
    this.retention = retention;
    await this.flush();
    await this.prune();
    this.info('logger', 'Operational log retention updated', {
      ageDays: retention.ageDays,
      maxMiB: retention.maxMiB,
    });
    return { ...this.retention };
  }

  private async logFiles(): Promise<string[]> {
    return (await readdir(this.directory))
      .filter((name) => /^events-[\w.-]+\.jsonl$/.test(name))
      .sort();
  }

  private async prune(): Promise<void> {
    const cutoff = Date.now() - this.retention.ageDays * 86400_000;
    const files = [];
    let total = 0;
    for (const name of await this.logFiles()) {
      const filename = path.join(this.directory, name);
      const details = await stat(filename);
      if (details.mtimeMs < cutoff && filename !== this.activeFile) {
        await rm(filename, { force: true });
        continue;
      }
      total += details.size;
      files.push({ filename, size: details.size });
    }
    const maximum = this.retention.maxMiB * 1024 * 1024;
    for (const file of files) {
      if (total <= maximum) break;
      if (file.filename === this.activeFile) continue;
      await rm(file.filename, { force: true });
      total -= file.size;
    }
    this.bytesSincePrune = 0;
  }

  private enqueue(entry: LogEntry): void {
    const payload = JSON.stringify(entry) + '\n';
    const bytes = Buffer.byteLength(payload);
    this.writes = this.writes
      .then(async () => {
        if (!this.activeFile || this.activeBytes + bytes > FILE_ROTATE_BYTES) {
          this.activeFile = path.join(
            this.directory,
            'events-' +
              new Date().toISOString().replace(/[:]/g, '-') +
              '-' +
              randomUUID() +
              '.jsonl',
          );
          this.activeBytes = 0;
          await writeFile(this.activeFile, '', { flag: 'wx', mode: 0o600 });
        }
        await appendFile(this.activeFile, payload, { mode: 0o600 });
        this.activeBytes += bytes;
        this.bytesSincePrune += bytes;
        if (this.bytesSincePrune >= 64 * 1024) await this.prune();
      })
      .catch((error: unknown) => {
        // Avoid recursive logging if the log volume is unavailable.
        process.stderr.write('Operational logger write failed: ' + String(error) + '\n');
      });
  }

  async flush(): Promise<void> {
    await this.writes;
  }

  async close(): Promise<void> {
    await this.open();
    this.info('application', 'Logging session finished');
    await this.flush();
    await rm(path.join(this.directory, RUN_MARKER), { force: true });
    this.closed = true;
    await this.prune();
  }
}
