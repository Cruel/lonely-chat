import type { InferenceInput } from './fake-inference';
import {
  buildUnifiedInferenceRequest,
  type UnifiedInferenceRequest,
} from './unified-inference-request';
import type { InferenceStageDefaults } from '../shared/inference-profile-contract';

export const STAGE_VARIABLES = [
  'context',
  'cycle',
  'events',
  'transcripts',
  'chat',
  'scene',
  'observations',
  'narrative',
  'interpretations',
  'significantEvents',
] as const;
type Source = (typeof STAGE_VARIABLES)[number];
export const DEFAULT_VISION_PROMPT =
  'You are a visual observation stage. Analyze timestamped frames and return factual sceneState and discrete events. Output no chat messages.';
export const DEFAULT_CHAT_PROMPT =
  'You are the audience chat stage. React to new evidence, distinguish previously inferred context, and return valid JSON. No raw images are available.';

export function resolveStageContext(
  input: InferenceInput,
  stage: InferenceStageDefaults | undefined,
) {
  const policy = stage?.contextPolicy;
  const sources = new Set(
    policy?.sources ?? [
      'events',
      'transcripts',
      'chat',
      'scene',
      'observations',
      'narrative',
      'interpretations',
      'significantEvents',
    ],
  );
  const now =
    input.boundary?.throughMs ?? Math.max(0, ...(input.frames ?? []).map((f) => f.observedAt));
  const bound = <T>(items: readonly T[] | undefined, time: (item: T) => number): T[] =>
    (items ?? [])
      .filter(
        (item) => time(item) <= now + 1000 && (!policy || time(item) >= now - policy.maxAgeMs),
      )
      .sort((a, b) => time(a) - time(b))
      .slice(policy?.maxCount === 0 ? Infinity : -(policy?.maxCount ?? 256));
  const data: Record<Source, unknown> = {
    context: input.context,
    cycle: input.cycle,
    events: sources.has('events') ? bound(input.recentEvents, (v) => v.observedAt) : [],
    transcripts: sources.has('transcripts')
      ? bound(input.recentTranscripts, (v) => v.observedAt)
      : [],
    chat: sources.has('chat') ? bound(input.recentChat, (v) => v.presentedAt) : [],
    scene: sources.has('scene')
      ? bound(input.observations, (v) => v.observedAt)
          .filter((v) => v.source === 'vision')
          .map((v) => ({ ...v, evidence: 'model-interpretation' }))
      : [],
    observations: sources.has('observations')
      ? bound(input.observations, (v) => v.observedAt)
          .filter((v) => v.source !== 'vision')
          .map((v) => ({ ...v, evidence: 'captured' }))
      : [],
    narrative: sources.has('narrative')
      ? { context: input.context, memory: input.narrativeMemory ?? null }
      : '',
    interpretations: sources.has('interpretations')
      ? bound(input.priorInterpretations, (v) => v.observedAt).map((v) => ({
          ...v,
          evidence: 'model-interpretation',
        }))
      : [],
    // Deliberately not filtered by recent age: these were explicitly retained as significant.
    significantEvents: sources.has('significantEvents')
      ? (input.significantEvents ?? [])
          .slice(policy?.maxCount === 0 ? Infinity : -(policy?.maxCount ?? 256))
          .map((v) => ({ ...v, evidence: 'historical-summary' }))
      : [],
  };
  const max = policy?.maxCharacters ?? Infinity;
  const omittedBySource: Record<string, number> = {};
  const size = () => JSON.stringify(data).length;
  // Drop uncertain and historical context before contemporary captured evidence.
  for (const key of [
    'chat',
    'interpretations',
    'significantEvents',
    'events',
    'scene',
    'transcripts',
    'observations',
  ] as const) {
    const entries = data[key] as unknown[];
    while (size() > max && entries.length) {
      entries.shift();
      omittedBySource[key] = (omittedBySource[key] ?? 0) + 1;
    }
  }
  if (size() > max && data.narrative) {
    data.narrative = { context: input.context, memory: null };
    omittedBySource.narrative = 1;
  }
  if (size() > max)
    throw new Error('Stage context budget cannot fit required narrative and request metadata.');
  return {
    data,
    omitted: Object.values(omittedBySource).reduce((a, b) => a + b, 0),
    omittedBySource,
    characters: size(),
  };
}

export function resolveStageTemplate(template: string, data: Record<Source, unknown>): string {
  if (template.length > 12000) throw new Error('Stage template exceeds maximum length.');
  const resolved = template.replace(/{{\s*([^{}]+?)\s*}}/g, (_match, name: string) => {
    if (!(STAGE_VARIABLES as readonly string[]).includes(name))
      throw new Error(`Unknown stage template variable: ${name}`);
    const value = data[name as Source];
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
  if (resolved.includes('{{') || resolved.includes('}}'))
    throw new Error('Invalid stage template syntax.');
  return resolved;
}

/** Resolve one immutable Unified prompt against its admitted input, not mutable profile state. */
export function resolveUnifiedStageRequest(
  request: UnifiedInferenceRequest,
  input: InferenceInput,
  stage: InferenceStageDefaults | undefined,
): UnifiedInferenceRequest {
  if (!stage) return request;
  const context = resolveStageContext(input, stage).data;
  // Filter the actual canonical request, not only interpolated template variables.
  // Otherwise excluded private transcripts/chat still appear in the base payload.
  const selected = buildUnifiedInferenceRequest(
    {
      ...input,
      recentEvents: context.events as InferenceInput['recentEvents'],
      recentTranscripts: context.transcripts as InferenceInput['recentTranscripts'],
      recentChat: context.chat as InferenceInput['recentChat'],
      observations: [
        ...(context.scene as NonNullable<InferenceInput['observations']>),
        ...(context.observations as NonNullable<InferenceInput['observations']>),
      ],
    },
    request.nativeVideo?.sourceRef,
  );
  const retained =
    (context.significantEvents as unknown[]).length ||
    (context.interpretations as unknown[]).length ||
    Boolean((context.narrative as { memory?: unknown } | null)?.memory);
  return {
    ...request,
    instructions:
      stage.systemPrompt === undefined
        ? request.instructions
        : resolveStageTemplate(stage.systemPrompt, context),
    content: [
      ...(stage.userPrompt === undefined
        ? []
        : [{ type: 'text' as const, text: resolveStageTemplate(stage.userPrompt, context) }]),
      ...(retained
        ? [
            {
              type: 'text' as const,
              text: JSON.stringify({
                significantHistoricalSummaries: context.significantEvents,
                uncertainPriorInterpretations: context.interpretations,
                retainedNarrative: context.narrative,
              }),
            },
          ]
        : []),
      ...selected.content,
    ],
    sampling: {
      ...request.sampling,
      maxTokens: stage.maxResponseTokens ?? request.sampling.maxTokens,
    },
  };
}
