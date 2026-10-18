import { describe, it, expect } from 'vitest';
import { serializeOperationalLogs } from './operational-log-export';
import type { LogEntry } from '../shared/log-contract';

const logs: LogEntry[] = [
  {
    id: 'a',
    timestamp: '2026-01-01T00:00:00.000Z',
    source: 'overlay',
    level: 'error',
    text: 'Port unavailable',
  },
  {
    id: 'b',
    timestamp: '2026-01-01T00:00:01.000Z',
    source: 'renderer',
    level: 'warn',
    text: 'UI failure',
    error: { message: 'safe', stack: 'at assets/index.js:12:4' },
  },
];

describe('main-owned operational exports', () => {
  it('exports only retained selected entries in chronological order, without caller-supplied content', () => {
    const lines = serializeOperationalLogs(logs, ['b', 'a'])
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as LogEntry);
    expect(lines).toEqual(logs);
    expect(serializeOperationalLogs(logs, ['b'])).not.toContain('Port unavailable');
  });
  it('rejects invalid, repeated, forged or missing selections', () => {
    expect(() => serializeOperationalLogs(logs, [{ id: 'a', text: 'PRIVATE' }])).toThrow();
    expect(() => serializeOperationalLogs(logs, ['a', 'a'])).toThrow();
    expect(() => serializeOperationalLogs(logs, ['a', 'PRIVATE\nSECRET'])).toThrow();
    expect(() => serializeOperationalLogs(logs, [])).toThrow();
    expect(() => serializeOperationalLogs(logs, ['missing'])).toThrow();
  });
});
