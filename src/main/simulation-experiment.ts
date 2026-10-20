import { randomInt } from 'node:crypto';
import { AUDIENCE, type InferenceInput } from './fake-inference';
import {
  validatePlaygroundFrames,
  type PlaygroundFrame,
} from '../shared/playground-media-contract';
import { InferenceHistory } from './inference-history';
import { nativeChatRequest } from './native-inference';
import {
  DEFAULT_PREFERENCES,
  validateContext,
  type SessionPreferences,
} from '../shared/session-contract';
import { validateChatterName, type ChatterIdentity } from '../shared/audience-contract';
import { validatePlaygroundVideo, validateVideoOverrides } from '../shared/playground-contract';
import type {
  SimulationExperimentRequest,
  SimulationExperimentValues,
} from '../shared/playground-contract';

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Invalid ${label}: expected an object.`);
  return value as Record<string, unknown>;
}

function fields(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error(`Unexpected ${label} fields.`);
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error(`Invalid ${label} (1–${max} characters).`);
  return value;
}

function integer(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
    throw new Error(`Invalid ${label} (expected ${min}–${max}).`);
  return value as number;
}

function entries(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > 32)
    throw new Error(`Invalid ${label} (expected up to 32 entries).`);
  return value.map((entry) => object(entry, label));
}

/** IPC input is bounded and cannot inject private frames or an unbounded session history. */
export function validateSimulationExperiment(value: unknown): SimulationExperimentRequest {
  const v = object(value, 'simulation experiment');
  fields(
    v,
    ['modelId', 'values', 'rawRequestJson', 'frames', 'seed', 'videoMode', 'video', 'videoOptions'],
    'simulation experiment',
  );
  const video = validatePlaygroundVideo(v.videoMode, v.video, v.frames);
  const videoOptions = validateVideoOverrides(v.videoMode, v.videoOptions);
  if (video.videoMode === 'native-video' && v.rawRequestJson !== undefined)
    throw new Error('Raw JSON overrides are not available for native video clips.');
  if (v.seed !== undefined) integer(v.seed, 'seed', 0, 2147483647);
  const frames = validatePlaygroundFrames(v.frames);
  const modelId = text(v.modelId, 'model', 200);
  if (
    v.rawRequestJson !== undefined &&
    (typeof v.rawRequestJson !== 'string' ||
      v.rawRequestJson.length > 131072 + frames.length * 120000)
  )
    throw new Error('Raw request must be JSON under 128 KiB.');
  const source = object(v.values, 'simulation inputs');
  fields(
    source,
    [
      'context',
      'cycle',
      'playbackWindowMs',
      'chatActivity',
      'roster',
      'events',
      'transcripts',
      'observations',
      'recentChat',
    ],
    'simulation inputs',
  );
  const context = validateContext(source.context);
  const cycle = integer(source.cycle, 'cycle', 1, 1000000);
  const playbackWindowMs = integer(source.playbackWindowMs, 'playback window', 500, 60000);
  if (!['quiet', 'normal', 'busy'].includes(source.chatActivity as string))
    throw new Error('Invalid chat activity.');
  if (!Array.isArray(source.roster) || source.roster.length < 1 || source.roster.length > 100)
    throw new Error('Provide 1–100 chatter identities.');
  const seen = new Set<string>();
  const roster: ChatterIdentity[] = source.roster.map((item: unknown) => {
    const member = object(item, 'roster member');
    fields(member, ['author', 'color'], 'roster member');
    if (
      !validateChatterName(member.author) ||
      typeof member.color !== 'string' ||
      !/^#[\da-fA-F]{6}$/.test(member.color)
    )
      throw new Error('Invalid roster member name or color.');
    const author = member.author as string;
    if (seen.has(author.toLowerCase())) throw new Error('Duplicate roster identity.');
    seen.add(author.toLowerCase());
    return { author, color: member.color as string };
  });
  const events = entries(source.events, 'events').map((entry) => {
    fields(entry, ['kind', 'summary', 'ageMs'], 'event');
    if (entry.kind !== 'context' && entry.kind !== 'reaction')
      throw new Error('Invalid event kind.');
    return {
      kind: entry.kind as 'context' | 'reaction',
      summary: text(entry.summary, 'event summary', 300),
      ageMs: integer(entry.ageMs, 'event age', 0, 60000),
    };
  });
  const transcripts = entries(source.transcripts, 'transcripts').map((entry) => {
    fields(entry, ['source', 'text', 'ageMs'], 'transcript');
    return {
      source: text(entry.source, 'transcript source', 80),
      text: text(entry.text, 'transcript text', 2000),
      ageMs: integer(entry.ageMs, 'transcript age', 0, 60000),
    };
  });
  const observations = entries(source.observations, 'observations').map((entry) => {
    fields(entry, ['source', 'kind', 'description', 'ageMs'], 'observation');
    if (entry.kind !== 'audio' && entry.kind !== 'visual')
      throw new Error('Invalid observation kind.');
    return {
      source: text(entry.source, 'observation source', 80),
      kind: entry.kind,
      description: text(entry.description, 'observation description', 2000),
      ageMs: integer(entry.ageMs, 'observation age', 0, 60000),
    };
  });
  const recentChat = entries(source.recentChat, 'recent chat').map((entry) => {
    fields(entry, ['author', 'text', 'ageMs'], 'chat');
    return {
      author: text(entry.author, 'chat author', 50),
      text: text(entry.text, 'chat text', 500),
      ageMs: integer(entry.ageMs, 'chat age', 0, 60000),
    };
  });
  return {
    modelId,
    ...(v.seed === undefined ? {} : { seed: v.seed as number }),
    ...(frames.length ? { frames } : {}),
    ...video,
    ...videoOptions,
    values: {
      context,
      cycle,
      playbackWindowMs,
      chatActivity: source.chatActivity as SimulationExperimentValues['chatActivity'],
      roster,
      events,
      transcripts,
      observations: observations as SimulationExperimentValues['observations'],
      recentChat,
    },
    ...(v.rawRequestJson === undefined ? {} : { rawRequestJson: v.rawRequestJson }),
  };
}

/** The same bounded InferenceHistory.snapshot() used by SessionController. */
export function buildSimulationExperimentInput(
  values: SimulationExperimentValues,
  now: number,
  limits: Pick<SessionPreferences, 'historyMaxAgeMs' | 'historyMaxCount'> = DEFAULT_PREFERENCES,
  selectedFrames: SimulationExperimentRequest['frames'] = [],
  seed: number = randomInt(0x80000000),
): InferenceInput {
  const history = new InferenceHistory(limits);
  history.reset(now - values.playbackWindowMs);
  history.commitEvents(
    values.events.map((item) => ({
      kind: item.kind,
      summary: item.summary,
      observedAt: now - item.ageMs,
    })),
    now,
  );
  for (const transcript of values.transcripts) {
    history.recordTranscript(
      {
        source: transcript.source,
        text: transcript.text,
        observedAt: now - transcript.ageMs,
      },
      now,
    );
  }
  for (const observation of values.observations) {
    history.recordObservation(
      {
        source: observation.source,
        kind: observation.kind,
        description: observation.description,
        observedAt: now - observation.ageMs,
      },
      now,
    );
  }
  const chat = values.recentChat.map((item, index) => ({
    id: `chat-${index + 1}`,
    author: item.author,
    text: item.text,
    color: '#ffffff',
    presentedAt: now - item.ageMs,
  }));
  const snapshot = history.snapshot(
    values.context,
    values.cycle,
    now,
    values.playbackWindowMs,
    chat,
    values.roster,
  );
  return {
    ...snapshot,
    seed,
    chatActivity: values.chatActivity,
    // Preserve explicit selection order independent of source video time.
    frames:
      selectedFrames?.map((frame, index) => ({
        ...frame,
        observedAt: now - (selectedFrames.length - 1 - index) * 1000,
      })) ?? [],
    videoWindow: {
      fromMs: Math.min(
        snapshot.boundary.fromMs,
        now - Math.max(0, (selectedFrames?.length ?? 0) - 1) * 1000,
      ),
      throughMs: now,
      truncated: false,
    },
  };
}

export function validateRawSimulationRequest(
  raw: string,
  selectedFrames: readonly PlaygroundFrame[] = [],
): ReturnType<typeof nativeChatRequest> {
  if (raw.length > 131072 + selectedFrames.length * 120000)
    throw new Error('Raw request exceeds the JSON/media size limit.');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Raw request is not valid JSON.');
  }
  const request = object(value, 'raw request');
  if (request.stream !== false || !Array.isArray(request.messages) || request.messages.length !== 2)
    throw new Error('Raw request requires stream:false and system/user messages.');
  const system = object(request.messages[0], 'system message');
  const user = object(request.messages[1], 'user message');
  fields(system, ['role', 'content'], 'system message');
  fields(user, ['role', 'content'], 'user message');
  if (
    system.role !== 'system' ||
    typeof system.content !== 'string' ||
    system.content.length > 65536 ||
    user.role !== 'user'
  )
    throw new Error('Raw request requires a system prompt and user content.');
  if (selectedFrames.length === 0) {
    if (typeof user.content !== 'string' || user.content.length > 65536)
      throw new Error('Raw user prompt must be text without selected media.');
  } else {
    if (!Array.isArray(user.content) || user.content.length > 1 + selectedFrames.length * 2)
      throw new Error('Raw multimodal request must include the selected frames.');
    const urls: string[] = [];
    for (const part of user.content) {
      const entry = object(part, 'multimodal content part');
      if (entry.type === 'text') {
        fields(entry, ['type', 'text'], 'text part');
        if (typeof entry.text !== 'string' || entry.text.length > 65536)
          throw new Error('Invalid raw multimodal text.');
      } else if (entry.type === 'image_url') {
        fields(entry, ['type', 'image_url'], 'image part');
        const image = object(entry.image_url, 'image URL');
        fields(image, ['url'], 'image URL');
        if (typeof image.url !== 'string') throw new Error('Invalid raw image URL.');
        urls.push(image.url);
      } else {
        throw new Error('Unsupported raw multimodal content type.');
      }
    }
    if (
      urls.length !== selectedFrames.length ||
      urls.some((url, index) => url !== selectedFrames[index].dataUrl)
    )
      throw new Error('Raw request images must exactly match all selected frames in order.');
  }
  const format = object(request.response_format, 'response format');
  if (format.type !== 'json_object')
    throw new Error('Simulation requires a structured json_object response.');
  object(format.schema, 'response schema');
  if (
    typeof request.temperature !== 'number' ||
    !Number.isFinite(request.temperature) ||
    request.temperature < 0 ||
    request.temperature > 2
  )
    throw new Error('Invalid raw temperature.');
  integer(request.max_tokens, 'raw max_tokens', 1, 8192);
  if (
    Object.keys(request).some(
      (key) =>
        ![
          'stream',
          'messages',
          'temperature',
          'max_tokens',
          'response_format',
          'seed',
          'top_p',
          'top_k',
        ].includes(key),
    )
  )
    throw new Error('Unexpected raw request fields.');
  if (request.seed !== undefined) integer(request.seed, 'seed', 0, 2147483647);
  if (
    request.top_p !== undefined &&
    (typeof request.top_p !== 'number' || request.top_p < 0 || request.top_p > 1)
  )
    throw new Error('Invalid raw top_p.');
  if (request.top_k !== undefined) integer(request.top_k, 'raw top_k', 1, 200);
  return request as unknown as ReturnType<typeof nativeChatRequest>;
}

export function constructedSimulationRequest(
  input: InferenceInput,
): ReturnType<typeof nativeChatRequest> {
  return nativeChatRequest({ ...input, roster: input.roster?.length ? input.roster : AUDIENCE });
}
