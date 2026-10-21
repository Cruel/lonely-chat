import type { UnifiedInferenceAdapter } from './inference-coordinator';
import { traceUsage } from './inference-trace';
import type { StageTraceCapture } from './stage-trace-evidence';
import type { InferenceContentPart, UnifiedInferenceRequest } from './unified-inference-request';

export interface NarrativeMemoryPolicy {
  readonly enabled: boolean;
  readonly intervalMs: number;
  readonly maxCharacters: number;
  readonly expireAfterMs: number;
}

export interface NarrativeMemorySnapshot {
  readonly version: number;
  readonly text: string;
  readonly updatedAt: number;
}

/** One Run's compact, uncertain narrative; no publication of partial/failed revisions. */
export class NarrativeMemory {
  private generation = 0;
  private revision = 0;
  private value: NarrativeMemorySnapshot | null = null;
  private pending: string[] = [];
  private inFlight = false;
  private suspended = false;
  private lastStarted = -Infinity;
  private abort = new AbortController();

  reset(): void {
    this.generation++;
    this.abort.abort();
    this.abort = new AbortController();
    this.value = null;
    this.pending = [];
    this.revision = 0;
    this.suspended = false;
    this.inFlight = false;
    this.lastStarted = -Infinity;
  }

  suspend(): void {
    this.suspended = true;
    this.generation++;
    this.abort.abort();
    this.abort = new AbortController();
    this.inFlight = false;
  }

  resume(): void { this.suspended = false; }

  observe(description: string, observedAt: number): void {
    if (!description.trim()) return;
    this.pending.push(JSON.stringify({ observedAt, description: description.trim().slice(0, 400) }));
    if (this.pending.length > 256) this.pending.splice(0, this.pending.length - 256);
  }

  snapshot(now: number, policy: NarrativeMemoryPolicy): NarrativeMemorySnapshot | null {
    if (!policy.enabled || !this.value) return null;
    if (policy.expireAfterMs > 0 && now - this.value.updatedAt > policy.expireAfterMs) return null;
    return { ...this.value };
  }

  /** Never overlap updates or retry in a tight loop. New evidence remains pending after failure. */
  async update(now: number, policy: NarrativeMemoryPolicy, adapter: UnifiedInferenceAdapter, signal: AbortSignal, capture?: (request: UnifiedInferenceRequest) => StageTraceCapture): Promise<boolean> {
    if (!policy.enabled || this.suspended || !this.pending.length || this.inFlight || signal.aborted ||
        now - this.lastStarted < policy.intervalMs) return false;
    const generation = this.generation;
    const count = this.pending.length;
    const old = this.snapshot(now, policy)?.text ?? '';
    const observations = this.pending.slice(0, count);
    this.inFlight = true;
    this.lastStarted = now;
    const activeSignal = AbortSignal.any([signal, this.abort.signal]);
    const schema = {
      type: 'object', additionalProperties: false, required: ['summary'],
      properties: { summary: { type: 'string', minLength: 1, maxLength: policy.maxCharacters } },
    };
    const content: InferenceContentPart[] = [{ type: 'text', text: JSON.stringify({ previousSummary: old, newEvidence: observations }) }];
    const request = {
      role: 'memory',
      instructions: 'Maintain an accurate compact chronology of meaningful developments. Retain important older facts and their approximate timestamps; do not invent unsupported facts. Treat previous summary as uncertain model interpretation. Return only JSON with summary.',
      content, response: { kind: 'json', schema },
      sampling: { temperature: 0, temperatureMode: 'advisory', maxTokens: Math.min(4096, Math.max(128, Math.ceil(policy.maxCharacters / 3))) },
      evidenceWindow: null,
    } as unknown as UnifiedInferenceRequest;
    const evidence = capture?.(request);
    let stage: 'transport' | 'validation' = 'transport';
    try {
      evidence?.update({ stage: 'transport' });
      const result = await adapter.complete(request, activeSignal, evidence?.observe);
      if (activeSignal.aborted || generation !== this.generation) {
        evidence?.update({ stage: 'cancelled', errorStage: stage });
        return false;
      }
      evidence?.update({ stage: 'normalization', rawResponse: result.raw, usage: result.usage ?? traceUsage(result.raw) });
      stage = 'validation';
      evidence?.update({ stage, normalized: result.normalized });
      const record = result.normalized;
      const fields = record && typeof record === 'object' && !Array.isArray(record) ? record as Record<string, unknown> : null;
      if (!fields || Object.keys(fields).length !== 1 || typeof fields.summary !== 'string' ||
          !fields.summary.trim() || fields.summary.length > policy.maxCharacters) {
        evidence?.update({ stage: 'failed', errorStage: 'validation', error: 'Invalid narrative memory response.' });
        return false;
      }
      this.value = { version: ++this.revision, text: fields.summary.trim(), updatedAt: now };
      this.pending.splice(0, count);
      evidence?.update({ stage: 'accepted', parsed: fields, accepted: this.value, availableAt: now });
      return true;
    } catch (error) {
      evidence?.update({ stage: activeSignal.aborted ? 'cancelled' : 'failed', errorStage: stage,
        error: error instanceof Error ? error.message : 'Narrative memory inference failed.' });
      return false;
    } finally {
      if (generation === this.generation) this.inFlight = false;
    }
  }
}
