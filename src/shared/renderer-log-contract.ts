/** Desktop-only renderer failures. User-controlled messages and data never cross this IPC. */
export const RENDERER_AREAS = [
  'application',
  'react',
  'simulation',
  'playground',
  'inputs',
  'models',
  'overlay',
  'window',
  'logs',
] as const;
export type RendererArea = (typeof RENDERER_AREAS)[number];
export type RendererFailureKind = 'uncaught' | 'unhandled-rejection' | 'react' | 'operation';
export interface RendererFailure {
  readonly area: RendererArea;
  readonly kind: RendererFailureKind;
  readonly name:
    | 'Error'
    | 'TypeError'
    | 'RangeError'
    | 'ReferenceError'
    | 'SyntaxError'
    | 'Unknown';
  readonly frames: readonly string[];
  readonly cause?: RendererFailure['name'];
}

const NAMES = ['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError'] as const;
const KINDS: readonly string[] = ['uncaught', 'unhandled-rejection', 'react', 'operation'];
const FRAME = /^(?:src\/renderer\/[\w./@-]+|assets\/[\w.-]+):\d{1,7}:\d{1,5}$/;
const TRACE = /(?:src\/renderer\/[\w./@-]+|assets\/[\w.-]+):\d{1,7}:\d{1,5}/g;

function nameOf(error: unknown): RendererFailure['name'] {
  if (!error || typeof error !== 'object') return 'Unknown';
  const name = (error as { name?: unknown }).name;
  return typeof name === 'string' && (NAMES as readonly string[]).includes(name)
    ? (name as RendererFailure['name'])
    : 'Unknown';
}

/** Preserve code locations and error types, never arbitrary message/stack snippets. */
export function makeRendererFailure(
  area: RendererArea,
  kind: RendererFailureKind,
  error: unknown,
): RendererFailure {
  const stack = error instanceof Error ? error.stack : undefined;
  // Discard the exception headline and any non-stack lines; they can echo
  // private prompt/transcript data. Only real stack-frame-looking locations count.
  const frames =
    typeof stack === 'string'
      ? stack
          .split('\n')
          .slice(1)
          .filter((line) => /^\s*at\s/.test(line))
          .flatMap((line) => line.match(TRACE) ?? [])
          .filter((frame) => FRAME.test(frame))
          .slice(0, 12)
      : [];
  const cause = error instanceof Error ? nameOf(error.cause) : 'Unknown';
  return {
    area,
    kind,
    name: nameOf(error),
    frames,
    ...(cause === 'Unknown' ? {} : { cause }),
  };
}

/** Validation is repeated in the privileged main process; renderer IPC is untrusted. */
export function validateRendererFailure(value: unknown): RendererFailure {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid renderer failure');
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).some(
      (key) => !['area', 'kind', 'name', 'frames', 'cause'].includes(key),
    ) ||
    !RENDERER_AREAS.includes(candidate.area as RendererArea) ||
    !KINDS.includes(String(candidate.kind)) ||
    ![...NAMES, 'Unknown'].includes(candidate.name as 'Unknown') ||
    !Array.isArray(candidate.frames) ||
    candidate.frames.length > 12 ||
    candidate.frames.some((frame: unknown) => typeof frame !== 'string' || !FRAME.test(frame)) ||
    (candidate.cause !== undefined && ![...NAMES, 'Unknown'].includes(candidate.cause as 'Unknown'))
  )
    throw new Error('Invalid renderer failure');
  return value as RendererFailure;
}
