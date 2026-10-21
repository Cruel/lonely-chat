import type { InferenceInput } from './fake-inference';
import type { InferenceStageDefaults } from '../shared/inference-profile-contract';

export const STAGE_VARIABLES = ['context', 'cycle', 'events', 'transcripts', 'chat', 'scene', 'observations', 'narrative'] as const;
type Source = (typeof STAGE_VARIABLES)[number];
export const DEFAULT_VISION_PROMPT = 'You are a visual observation stage. Analyze timestamped frames and return factual sceneState and discrete events. Output no chat messages.';
export const DEFAULT_CHAT_PROMPT = 'You are the audience chat stage. React to new evidence, distinguish previously inferred context, and return valid JSON. No raw images are available.';

export function resolveStageContext(input: InferenceInput, stage: InferenceStageDefaults | undefined) {
  const policy = stage?.contextPolicy;
  const sources = new Set(policy?.sources ?? ['events', 'transcripts', 'chat', 'scene', 'observations', 'narrative']);
  const now = input.boundary?.throughMs ?? Math.max(0, ...(input.frames ?? []).map((f) => f.observedAt));
  const bound = <T>(items: readonly T[] | undefined, time: (item: T) => number): T[] =>
    (items ?? []).filter((item) => time(item) <= now + 1000 && (!policy || time(item) >= now - policy.maxAgeMs))
      .slice(policy?.maxCount === 0 ? Infinity : -(policy?.maxCount ?? 256));
  const data: Record<Source, unknown> = {
    context: input.context,
    cycle: input.cycle,
    events: sources.has('events') ? bound(input.recentEvents, (v) => v.observedAt) : [],
    transcripts: sources.has('transcripts') ? bound(input.recentTranscripts, (v) => v.observedAt) : [],
    chat: sources.has('chat') ? bound(input.recentChat, (v) => v.presentedAt) : [],
    scene: sources.has('scene') ? bound(input.observations, (v) => v.observedAt).filter((v) => v.source === 'vision') : [],
    observations: sources.has('observations') ? bound(input.observations, (v) => v.observedAt).filter((v) => v.source !== 'vision') : [],
    narrative: sources.has('narrative') ? input.context : '',
  };
  let omitted = 0;
  const max = policy?.maxCharacters ?? Infinity;
  // Preserve newest evidence: evict earliest historical entries before truncating required context.
  const serialize = () => JSON.stringify(data);
  for (const key of ['chat', 'transcripts', 'events', 'scene', 'observations'] as const) {
    const entries = data[key] as unknown[];
    while (serialize().length > max && entries.length) { entries.shift(); omitted++; }
  }
  if (serialize().length > max) {
    data.narrative = '';
    omitted++;
  }
  if (serialize().length > max) throw new Error('Stage context budget cannot fit mandatory context.');
  return { data, omitted, characters: serialize().length };
}

export function resolveStageTemplate(template: string, data: Record<Source, unknown>): string {
  if (template.length > 12000) throw new Error('Stage template exceeds maximum length.');
  return template.replace(/{{\s*([^{}]+?)\s*}}/g, (_match, name: string) => {
    if (!(STAGE_VARIABLES as readonly string[]).includes(name))
      throw new Error(`Unknown stage template variable: ${name}`);
    const value = data[name as Source];
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
}
