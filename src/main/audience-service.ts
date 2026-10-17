import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  AUTHOR_PLACEHOLDER,
  normalizedAuthor,
  validateChatterName,
  type AudienceSnapshot,
  type ChatterIdentity,
} from '../shared/audience-contract';
import type { InferenceProvider } from './fake-inference';
import type { ScheduledChat } from './chat-scheduler';

const FILE = 'audience.json';
const PALETTE = [
  '#bba5ff',
  '#62d9b4',
  '#ffbb78',
  '#ed91ab',
  '#8bc5fa',
  '#dfc881',
  '#a8e089',
  '#efa8e2',
];
const MAX_GENERATION_BATCH = 12;
const GENERATION_ATTEMPTS_PER_BATCH = 3;

function colorFor(name: string): string {
  let hash = 0;
  for (const char of name) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

function validMembers(value: unknown): value is ChatterIdentity[] {
  if (!Array.isArray(value) || value.length > 100) return false;
  const seen = new Set<string>();
  return value.every((item) => {
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      Object.keys(item).sort().join(',') !== 'author,color' ||
      !validateChatterName(item.author) ||
      typeof item.color !== 'string' ||
      !/^#[0-9a-fA-F]{6}$/.test(item.color)
    )
      return false;
    const key = normalizedAuthor(item.author);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Stable desktop-owned roster, completely separate from published historical chat. */
export class AudienceService {
  private state: AudienceSnapshot;
  private subscribers = new Set<(snapshot: AudienceSnapshot) => void>();
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly directory: string | null,
    targetCount: number,
  ) {
    this.state = { revision: 0, phase: 'uninitialized', members: [], targetCount, error: null };
  }

  snapshot(): AudienceSnapshot {
    return { ...this.state, members: this.state.members.map((member) => ({ ...member })) };
  }

  subscribe(listener: (snapshot: AudienceSnapshot) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  private publish(patch: Partial<Omit<AudienceSnapshot, 'revision'>>): void {
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1 };
    for (const listener of this.subscribers) listener(this.snapshot());
  }

  async open(): Promise<void> {
    if (!this.directory) {
      this.publish({ phase: 'ready' });
      return;
    }
    try {
      const raw: unknown = JSON.parse(await readFile(path.join(this.directory, FILE), 'utf8'));
      if (
        !raw ||
        typeof raw !== 'object' ||
        Array.isArray(raw) ||
        Object.keys(raw).sort().join(',') !== 'members,version' ||
        (raw as { version?: unknown }).version !== 1 ||
        !validMembers((raw as { members?: unknown }).members)
      )
        throw new Error('Invalid saved audience roster.');
      const members = (raw as { members: ChatterIdentity[] }).members.slice(
        0,
        this.state.targetCount,
      );
      this.publish({ members, phase: 'ready', error: null });
      if (members.length !== (raw as { members: ChatterIdentity[] }).members.length)
        await this.save(members);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.publish({ phase: 'ready' });
      } else {
        const message = error instanceof Error ? error.message : 'Unable to load audience roster.';
        this.publish({ phase: 'error', error: message });
      }
    }
  }

  /** Shrinking removes only active roster membership, never historical message authors. */
  async setTarget(count: number): Promise<AudienceSnapshot> {
    if (!Number.isSafeInteger(count) || count < 1 || count > 100)
      throw new Error('Invalid audience size.');
    if (count === this.state.targetCount) return this.snapshot();
    if (this.state.phase === 'generating') throw new Error('Roster generation is in progress.');
    const members = this.state.members.slice(0, count);
    if (members.length !== this.state.members.length) await this.save(members);
    this.publish({ targetCount: count, members, phase: 'ready', error: null });
    return this.snapshot();
  }

  async ensure(
    provider: InferenceProvider,
    signal: AbortSignal,
    regenerate = false,
  ): Promise<AudienceSnapshot> {
    if (signal.aborted) throw new Error('Roster generation cancelled.');
    if (this.state.phase === 'generating') throw new Error('Roster generation is already running.');
    if (!regenerate && this.state.members.length === this.state.targetCount) return this.snapshot();
    if (!provider.generateRoster)
      throw new Error('The selected inference provider cannot generate a roster.');
    const previous = this.state.members;
    const members = regenerate ? [] : [...previous];
    // Regeneration excludes old identities so the operation actually produces a different roster.
    const seen = new Set(
      (regenerate ? previous : members).map((item) => normalizedAuthor(item.author)),
    );
    this.publish({ phase: 'generating', error: null });
    const attempts = Math.max(
      GENERATION_ATTEMPTS_PER_BATCH,
      Math.ceil((this.state.targetCount - members.length) / MAX_GENERATION_BATCH) *
        GENERATION_ATTEMPTS_PER_BATCH,
    );
    try {
      for (
        let attempt = 0;
        members.length < this.state.targetCount && attempt < attempts;
        attempt++
      ) {
        const requested = Math.min(MAX_GENERATION_BATCH, this.state.targetCount - members.length);
        const names = await provider.generateRoster(requested, [...seen], signal);
        if (signal.aborted) throw new Error('Roster generation cancelled.');
        if (!Array.isArray(names) || names.length > requested) {
          throw new Error('The model returned an invalid roster.');
        }
        for (const name of names) {
          if (!validateChatterName(name))
            throw new Error('The model returned an invalid username.');
          const key = normalizedAuthor(name);
          if (seen.has(key)) continue;
          seen.add(key);
          members.push({ author: name, color: colorFor(name) });
        }
      }
      if (members.length !== this.state.targetCount) {
        throw new Error(
          `The model did not generate enough unique usernames after ${attempts} attempts. Retry generation.`,
        );
      }
      if (signal.aborted) throw new Error('Roster generation cancelled.');
      await this.save(members);
      this.publish({ members, phase: 'ready', error: null });
      return this.snapshot();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to generate roster.';
      // Stop/Restart cancellation is not a roster failure and must not leave a warning.
      this.publish(
        signal.aborted ? { phase: 'ready', error: null } : { phase: 'error', error: message },
      );
      throw error;
    }
  }

  /** Resolve all authors before any batch is enqueued; never rewrite old chat history. */
  resolve(
    messages: readonly ScheduledChat[],
    recentChat: readonly { author: string }[],
  ): ScheduledChat[] {
    const byName = new Map(this.state.members.map((item) => [item.author, item]));
    const uses = new Map<string, number>();
    for (const item of recentChat) uses.set(item.author, (uses.get(item.author) ?? 0) + 1);
    return messages.map((message) => {
      let author = message.author;
      if (author === AUTHOR_PLACEHOLDER) {
        const candidate = this.state.members.reduce<ChatterIdentity | null>(
          (best, item) =>
            !best || (uses.get(item.author) ?? 0) < (uses.get(best.author) ?? 0) ? item : best,
          null,
        );
        if (!candidate) throw new Error('No eligible audience members for placeholder.');
        author = candidate.author;
      }
      const member = byName.get(author);
      if (!member) throw new Error(`Inference referenced a chatter outside the roster: ${author}`);
      uses.set(author, (uses.get(author) ?? 0) + 1);
      return { ...message, author, color: member.color };
    });
  }

  private async save(members: readonly ChatterIdentity[]): Promise<void> {
    if (!this.directory) return;
    const save = this.writes.then(async () => {
      await mkdir(this.directory!, { recursive: true });
      const destination = path.join(this.directory!, FILE);
      const temp = `${destination}.${process.pid}.tmp`;
      try {
        await writeFile(temp, JSON.stringify({ version: 1, members }, null, 2) + '\n', {
          mode: 0o600,
        });
        await rename(temp, destination);
      } finally {
        await rm(temp, { force: true });
      }
    });
    this.writes = save.then(
      () => {},
      () => {},
    );
    await save;
  }
}
