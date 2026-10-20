import type { InferenceInput, InferenceProvider } from './fake-inference';
import type { NativeVideoPreferences } from '../shared/video-tools-contract';
import { AUDIENCE } from './fake-inference';
import { extractNativeChat, llamaCppRequest, withNativeVideoPlaceholder } from './native-inference';
import { executeNativeSimulation } from './simulation-execution';
import type { UnifiedInferenceAdapter } from './inference-coordinator';

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
        video ? withNativeVideoPlaceholder(llamaCppRequest(request)) : llamaCppRequest(request),
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
        (raw) => extractNativeChat(raw, input.roster ?? AUDIENCE),
        observe,
      );
      return { raw: result.rawNativeOutput, normalized: result.normalizedResult };
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
