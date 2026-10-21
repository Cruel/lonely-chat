import type { InferredEvent, CapturedObservation } from '../shared/session-contract';

export interface NarrativeEvent {
  readonly event: InferredEvent;
  readonly sourceModel: 'vision' | 'chat';
  readonly frameIds: readonly string[];
  readonly observedAt: number;
  readonly availableAt: number;
  readonly acknowledged: boolean;
  readonly attemptId?: string;
}

export interface NarrativeScene {
  readonly text: string;
  readonly sourceModel: 'vision';
  readonly frameIds: readonly string[];
  readonly observedAt: number;
  readonly availableAt: number;
  readonly attemptId?: string;
}

/** Owned by one Run. Scene descriptions and discrete reaction triggers never share a queue. */
export class SplitNarrative {
  private events: NarrativeEvent[] = [];
  private scene: NarrativeScene | null = null;
  private interpretations: NarrativeScene[] = [];
  private lastVisionAt = -Infinity;

  reset(): void {
    this.events = [];
    this.scene = null;
    this.interpretations = [];
    this.lastVisionAt = -Infinity;
  }

  /** Changing input sources invalidates the current visual interpretation, not
   * the Run's Event history or Chat's already frozen retry context. */
  clearVisualSource(): void {
    this.scene = null;
    this.interpretations = [];
    this.lastVisionAt = -Infinity;
  }

  private key(event: InferredEvent): string {
    return `${event.kind}:${event.summary.trim().toLocaleLowerCase().replace(/\s+/g, ' ')}`;
  }

  /** A repeated frame or a late completion cannot roll the scene backward. */
  observeVision(
    text: string,
    events: readonly InferredEvent[],
    observedAt: number,
    availableAt: number,
    frameIds: readonly string[],
    attemptId?: string,
  ): void {
    if (observedAt < this.lastVisionAt) return;
    const sameFrame = observedAt === this.lastVisionAt;
    if (!sameFrame) this.lastVisionAt = observedAt;
    const trimmed = text.trim();
    if (trimmed && (!sameFrame || !this.scene)) {
      this.scene = {
        text: trimmed,
        sourceModel: 'vision',
        frameIds: [...frameIds],
        observedAt,
        availableAt,
        attemptId,
      };
      if (this.interpretations.at(-1)?.text !== trimmed) {
        this.interpretations.push(this.scene);
        this.interpretations = this.interpretations.slice(-256);
      }
    }
    this.merge(events, 'vision', availableAt, frameIds, attemptId);
  }

  merge(
    events: readonly InferredEvent[],
    sourceModel: 'vision' | 'chat',
    availableAt: number,
    frameIds: readonly string[] = [],
    attemptId?: string,
  ): readonly NarrativeEvent[] {
    const accepted: NarrativeEvent[] = [];
    for (const event of events) {
      if (!Number.isFinite(event.observedAt)) continue;
      const duplicate = this.events.some(
        (existing) =>
          this.key(existing.event) === this.key(event) &&
          Math.abs(existing.observedAt - event.observedAt) <= 3000,
      );
      if (duplicate) continue;
      const entry: NarrativeEvent = {
        event: { ...event },
        sourceModel,
        frameIds: [...frameIds],
        observedAt: event.observedAt,
        availableAt,
        acknowledged: sourceModel === 'chat',
        attemptId,
      };
      this.events.push(entry);
      accepted.push(entry);
    }
    return accepted;
  }

  /** Historical events remain usable even once their reaction trigger is acknowledged. */
  history(now: number, maxAgeMs: number): readonly NarrativeEvent[] {
    this.prune(now, maxAgeMs);
    return this.events.slice();
  }

  pending(now: number, maxAgeMs: number): readonly NarrativeEvent[] {
    return this.history(now, maxAgeMs).filter((event) => !event.acknowledged);
  }

  acknowledge(entries: readonly NarrativeEvent[]): void {
    const selected = new Set(entries);
    this.events = this.events.map((entry) =>
      selected.has(entry) ? { ...entry, acknowledged: true } : entry,
    );
  }

  currentScene(now: number, maxAgeMs: number): NarrativeScene | null {
    return this.scene && now - this.scene.availableAt <= maxAgeMs ? { ...this.scene } : null;
  }

  priorInterpretations(now: number, maxAgeMs: number) {
    return this.interpretations
      .filter((item) => now - item.availableAt <= maxAgeMs)
      .map(({ text, observedAt, sourceModel }) => ({ text, observedAt, sourceModel }));
  }

  sceneObservation(now: number, maxAgeMs: number): CapturedObservation[] {
    const scene = this.currentScene(now, maxAgeMs);
    return scene
      ? [
          {
            source: 'vision',
            kind: 'visual',
            description: scene.text,
            observedAt: scene.observedAt,
          },
        ]
      : [];
  }

  private prune(now: number, maxAgeMs: number): void {
    this.events = this.events.filter((entry) => now - entry.availableAt <= maxAgeMs);
    if (this.events.length > 256) this.events = this.events.slice(-256);
  }
}
