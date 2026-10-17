/** Desktop-only audience configuration; never part of the public overlay protocol. */
export interface ChatterIdentity {
  readonly author: string;
  readonly color: string;
}

export type ChatActivity = 'quiet' | 'normal' | 'busy';

export const CHAT_ACTIVITY_LIMITS: Record<ChatActivity, number> = {
  quiet: 2,
  normal: 4,
  busy: 8,
};

export interface AudienceSnapshot {
  readonly revision: number;
  readonly phase: 'uninitialized' | 'ready' | 'generating' | 'error';
  readonly members: readonly ChatterIdentity[];
  readonly targetCount: number;
  readonly error: string | null;
}

export const AUTHOR_PLACEHOLDER = '__any__';

/** Case folding is intentional: display names retain their original spelling. */
export function normalizedAuthor(author: string): string {
  return author.toLowerCase();
}

export function validateChatterName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    /^[A-Za-z0-9_]{3,24}$/.test(name) &&
    normalizedAuthor(name) !== AUTHOR_PLACEHOLDER
  );
}
