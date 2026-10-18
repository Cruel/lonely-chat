import { CHAT_ACTIVITY_LIMITS } from '../shared/audience-contract';
import { AUDIENCE, parseInferenceResult, type InferenceInput } from './fake-inference';
import { resolveChatAuthors } from './audience-service';

/** The one authoritative post-native validation and acceptance seam. No side effects. */
export function validateSimulationCycle(
  input: InferenceInput,
  output: unknown,
  enforceAudience = true,
  onParsed?: (parsed: ReturnType<typeof parseInferenceResult>) => void,
) {
  const evidenceStart = Math.min(
    input.boundary?.fromMs ?? Date.now() - 60000,
    ...(input.frames ?? []).map((entry) => entry.observedAt),
    ...(input.recentEvents ?? []).map((entry) => entry.observedAt),
    ...(input.recentTranscripts ?? []).map((entry) => entry.observedAt),
    ...(input.observations ?? []).map((entry) => entry.observedAt),
  );
  const now = input.boundary?.throughMs ?? Date.now();
  const parsed = parseInferenceResult(output, now, evidenceStart);
  onParsed?.(parsed);
  if (
    enforceAudience &&
    parsed.messages.length > CHAT_ACTIVITY_LIMITS[input.chatActivity ?? 'normal']
  )
    throw new Error('Inference generated more messages than the configured chat activity allows.');
  const roster = input.roster ?? AUDIENCE;
  return {
    parsed,
    accepted: {
      events: parsed.events,
      messages: enforceAudience
        ? resolveChatAuthors(roster, parsed.messages, input.recentChat ?? [])
        : parsed.messages,
    },
  };
}
