import type {
  TraceAttempt,
  TraceList,
  TraceStage,
  TraceSummary,
  TraceUsage,
} from '../shared/inference-trace-contract';

/** Each field is frozen at capture time. Oversize fields are explicitly marked, never silently cut. */
function freeze(value: unknown, fieldLimit: number): unknown {
  if (value === undefined) return null;
  try {
    const json = JSON.stringify(value);
    if (!json) return null;
    const size = Buffer.byteLength(json);
    if (size > fieldLimit)
      return { omitted: true, reason: 'Capture field exceeded memory limit', bytes: size };
    return JSON.parse(json) as unknown;
  } catch {
    return { omitted: true, reason: 'Capture field was not serializable' };
  }
}

/** Keep record identities and timestamps when the selected image bytes alone exceed the cap. */
function freezeInput(value: unknown, fieldLimit: number): unknown {
  const original = freeze(value, fieldLimit);
  if (!original || typeof original !== 'object' || !('omitted' in original)) return original;
  if (!value || typeof value !== 'object' || !('frames' in value) || !Array.isArray(value.frames))
    return original;
  return freeze(
    {
      ...value,
      frames: value.frames.map((frame: unknown) => {
        if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return frame;
        const { dataUrl: _bytes, ...metadata } = frame as Record<string, unknown>;
        return { ...metadata, imageOmitted: true };
      }),
    },
    fieldLimit,
  );
}

export function traceUsage(response: unknown): TraceUsage | null {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return null;
  const value = (response as { usage?: unknown }).usage;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const token = (field: string) => {
    const n = record[field];
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
  };
  return {
    promptTokens: token('prompt_tokens'),
    completionTokens: token('completion_tokens'),
    totalTokens: token('total_tokens'),
  };
}

type MutableAttempt = { -readonly [K in keyof TraceAttempt]: TraceAttempt[K] };

/** Volatile private inspector buffer, bounded by both entry count and serialized bytes. */
export class InferenceTrace {
  private attempts: MutableAttempt[] = [];
  private dropped = 0;
  private serial = 0;
  private listeners = new Set<(snapshot: TraceList) => void>();

  subscribe(listener: (snapshot: TraceList) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private notify(): void {
    if (this.listeners.size) {
      const snapshot = this.list();
      for (const listener of this.listeners) listener(snapshot);
    }
  }

  constructor(
    private readonly maxBytes = 24 * 1024 * 1024,
    private readonly maxEntries = 16,
    private readonly fieldLimit = 12 * 1024 * 1024,
  ) {}

  list(): TraceList {
    return {
      attempts: this.attempts.map(
        ({
          input: _input,
          settings: _settings,
          promptPreset: _preset,
          adaptation: _adaptation,
          request: _request,
          rawResponse: _raw,
          normalized: _normalized,
          parsed: _parsed,
          accepted: _accepted,
          scheduled: _scheduled,
          transportError: _transport,
          ...summary
        }) => ({ ...summary }) satisfies TraceSummary,
      ),
      dropped: this.dropped,
      bytes: this.bytes(),
    };
  }

  get(id: string): TraceAttempt | null {
    const found = this.attempts.find((item) => item.id === id);
    return found ? structuredClone(found) : null;
  }

  begin(
    initial: Omit<
      TraceAttempt,
      | 'id'
      | 'stage'
      | 'durationMs'
      | 'errorStage'
      | 'error'
      | 'usage'
      | 'request'
      | 'rawResponse'
      | 'normalized'
      | 'parsed'
      | 'accepted'
      | 'scheduled'
      | 'transportError'
    >,
  ): string {
    const id = `attempt-${++this.serial}`;
    this.attempts.push({
      ...initial,
      id,
      stage: 'preparing',
      durationMs: null,
      errorStage: null,
      error: null,
      usage: null,
      input: freezeInput(initial.input, this.fieldLimit),
      settings: freeze(initial.settings, this.fieldLimit),
      promptPreset: freeze(initial.promptPreset, this.fieldLimit),
      adaptation: freeze(initial.adaptation, this.fieldLimit),
      request: null,
      rawResponse: null,
      normalized: null,
      parsed: null,
      accepted: null,
      scheduled: null,
      transportError: null,
    });
    this.prune();
    this.notify();
    return id;
  }

  update(id: string, patch: Partial<TraceAttempt>): void {
    const found = this.attempts.find((item) => item.id === id);
    if (!found) return; // Evicted while asynchronous work was still pending.
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'id' || key === 'runId' || key === 'cycle' || key === 'attempt' || key === 'seed')
        continue;
      const field = key as keyof MutableAttempt;
      (found as unknown as Record<string, unknown>)[field] = [
        'request',
        'rawResponse',
        'normalized',
        'parsed',
        'accepted',
        'scheduled',
        'transportError',
        'input',
      ].includes(key)
        ? key === 'input'
          ? freezeInput(value, this.fieldLimit)
          : freeze(value, this.fieldLimit)
        : value;
    }
    this.prune();
    this.notify();
  }

  cancelPending(runId: number): void {
    for (const attempt of this.attempts) {
      if (
        attempt.runId === runId &&
        ['preparing', 'transport', 'normalization', 'validation', 'accepted'].includes(
          attempt.stage,
        )
      ) {
        attempt.errorStage = attempt.stage;
        attempt.stage = 'cancelled';
        attempt.error = 'Simulation stopped or model changed before completion.';
      }
    }
    this.notify();
  }

  private bytes(): number {
    return this.attempts.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0);
  }

  private prune(): void {
    while (
      this.attempts.length > 1 &&
      (this.attempts.length > this.maxEntries || this.bytes() > this.maxBytes)
    ) {
      this.attempts.shift();
      this.dropped++;
    }
    const latest = this.attempts[0];
    if (!latest || this.bytes() <= this.maxBytes) return;
    // Keep the newest attempt even if the request and its input contain two
    // copies of the same large JPEGs. Preserve the selected-frame metadata
    // and exact submitted request before omitting lower-priority fields.
    if (latest.input && typeof latest.input === 'object' && !Array.isArray(latest.input)) {
      const input = latest.input as Record<string, unknown>;
      if (Array.isArray(input.frames)) {
        latest.input = {
          ...input,
          frames: input.frames.map((frame: unknown) => {
            if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return frame;
            const { dataUrl: _bytes, ...metadata } = frame as Record<string, unknown>;
            return metadata;
          }),
        };
      }
    }
    for (const field of [
      'normalized',
      'parsed',
      'accepted',
      'scheduled',
      'rawResponse',
      'transportError',
      'request',
      'input',
    ] as const) {
      if (this.bytes() <= this.maxBytes) break;
      const value = latest[field];
      if (value === null) continue;
      latest[field] = { omitted: true, reason: 'Attempt exceeded total memory budget' };
    }
    if (this.bytes() > this.maxBytes || this.attempts.length > this.maxEntries) {
      this.attempts.shift();
      this.dropped++;
    }
  }
}

/** Observer reports real production transport boundaries, without altering the provider response. */
export type InferenceTraceObserver = (
  stage: 'request' | 'response' | 'normalized',
  value: unknown,
) => void;

export function traceFailureStage(attempt: TraceAttempt | null): TraceStage {
  return attempt?.stage ?? 'preparing';
}
