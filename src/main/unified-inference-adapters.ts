import type { InferenceInput, InferenceProvider } from './fake-inference';
import type { NativeVideoPreferences } from '../shared/video-tools-contract';
import { AUDIENCE } from './fake-inference';
import {
  extractNativeChat,
  extractNativeJson,
  llamaCppRequest,
  withNativeVideoPlaceholder,
} from './native-inference';
import { normalizeStageMemory } from './stage-output';
import type { InferenceRequest } from './unified-inference-request';
import { executeNativeSimulation } from './simulation-execution';
import type { UnifiedInferenceAdapter } from './inference-coordinator';
import { selectContinuousVideoWindow, type ContinuousVideoWindow } from './continuous-video-window';

/** Local llama.cpp implements only the transport; prompts and acceptance are app-owned. */
export function llamaCppAdapter(
  provider: {
    completeSimulationRequest(
      input: InferenceInput,
      request: unknown,
      signal: AbortSignal,
      videoToken?: string,
      videoOptions?: NativeVideoPreferences,
    ): Promise<unknown>;
  },
  input: InferenceInput,
  video?: { token: string; options?: NativeVideoPreferences },
): UnifiedInferenceAdapter {
  return {
    capabilities: { images: true, nativeVideo: Boolean(video) },
    async complete(request, signal, observe) {
      if (request.nativeVideo?.sourceRef !== video?.token)
        throw new Error('The native-video source does not match the requested local media.');
      const result = await executeNativeSimulation(
        input,
        video
          ? withNativeVideoPlaceholder(
              llamaCppRequest({
                ...request,
                content: request.content.filter((part) => part.type !== 'image'),
              }),
            )
          : llamaCppRequest(request),
        signal,
        (nativeRequest, activeSignal) =>
          video
            ? provider.completeSimulationRequest(
                input,
                nativeRequest,
                activeSignal,
                video.token,
                video.options,
              )
            : provider.completeSimulationRequest(input, nativeRequest, activeSignal),
        (raw) =>
          (request as InferenceRequest).role === 'memory'
            ? normalizeStageMemory(extractNativeJson(raw), request)
            : normalizeStageMemory(extractNativeChat(raw, input.roster ?? AUDIENCE), request),
        observe,
      );
      return { raw: result.rawNativeOutput, normalized: result.normalizedResult };
    },
  };
}

/**
 * Optional continuous Vision stage transport. Never assume that a vision-capable
 * model is video-capable: prepare the worker and inspect the advertised modality.
 * Unknown models keep the ordinary ordered JPEG input.
 */
export function nativeVideoStageAdapter(
  base: UnifiedInferenceAdapter,
  provider: {
    prepare(signal: AbortSignal): Promise<void>;
    supportsNativeVideo(): boolean;
    completeSimulationVideoWindow(
      input: InferenceInput,
      request: unknown,
      signal: AbortSignal,
      window: ContinuousVideoWindow,
    ): Promise<unknown>;
  },
  input: InferenceInput,
): UnifiedInferenceAdapter {
  return {
    capabilities: base.capabilities,
    async complete(request, signal, observe) {
      await provider.prepare(signal);
      if (!provider.supportsNativeVideo()) return base.complete(request, signal, observe);
      const identities = new Set(
        request.content
          .filter((part) => part.type === 'image')
          .map((part) => part.sourceId + ':' + part.observedAt),
      );
      const selected = (input.frames ?? []).filter((frame) =>
        identities.has(frame.sourceId + ':' + frame.observedAt),
      );
      const window = selectContinuousVideoWindow(
        selected,
        input.videoWindow?.fromMs ?? input.boundary?.fromMs ?? 0,
        input.videoWindow?.throughMs ?? input.boundary?.throughMs ?? 0,
      );
      if (!window) return base.complete(request, signal, observe);
      const token = window.sourceId + ':' + window.fromMs + ':' + window.throughMs;
      const video = llamaCppAdapter(
        {
          completeSimulationRequest: (selectedInput, nativeRequest, activeSignal) =>
            provider.completeSimulationVideoWindow(
              selectedInput,
              nativeRequest,
              activeSignal,
              window,
            ),
        },
        input,
        { token },
      );
      return video.complete({ ...request, nativeVideo: { sourceRef: token } }, signal, observe);
    },
  };
}

/** Deterministic fixture transports exercise the exact coordinator used by live inference. */
export function fixtureInferenceAdapter(
  provider: InferenceProvider,
  input: InferenceInput,
): UnifiedInferenceAdapter {
  return {
    capabilities: { images: true },
    async complete(_request, signal, observe) {
      const output = await provider.generate(input, signal, observe);
      return { raw: output, normalized: output };
    },
  };
}
