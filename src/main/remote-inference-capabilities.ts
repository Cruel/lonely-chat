import type { UnifiedInferenceRequest } from './unified-inference-request';
import {
  effectiveRemoteCapabilities,
  type RemoteConnection,
  type RemoteModelConfiguration,
} from '../shared/remote-inference-contract';

/** Fail closed before submitting content to an endpoint with uncertain features. */
export function validateRemoteRequest(
  connection: RemoteConnection,
  model: RemoteModelConfiguration,
  request: UnifiedInferenceRequest,
): void {
  const support = effectiveRemoteCapabilities(connection, model);
  if (!support.text)
    throw new Error(
      'This model does not support text input. Change the model or its verified capabilities.',
    );
  if (request.nativeVideo)
    throw new Error(
      'Native-video transport is not supported by this remote protocol. Select image frames instead.',
    );
  const parts = request.content;
  if (!parts.length || parts.length > 65)
    throw new Error(
      'Remote input must contain between 1 and 65 ordered content parts. Reduce the frame count.',
    );
  let count = 0;
  let bytes = 0;
  let lastTime = -Infinity;
  for (const part of parts) {
    if (part.type === 'text') {
      if (part.text.length > 250_000)
        throw new Error('Remote text context exceeds 250,000 characters. Reduce recent history.');
    } else {
      count++;
      if (!support.images || !model.images || !model.allowRemoteImages)
        throw new Error(
          'Remote screenshot transmission requires verified image support and explicit image permission. Check Model Configuration.',
        );
      if (!Number.isFinite(part.observedAt) || part.observedAt < lastTime)
        throw new Error('Remote image frames must have ordered observation timestamps.');
      lastTime = part.observedAt;
      const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(
        part.dataUrl,
      );
      if (!match || match[2].length % 4 !== 0)
        throw new Error('Remote image frame must be a JPEG, PNG or WebP base64 data URL.');
      bytes += Math.floor((match[2].length * 3) / 4);
      if (match[2].length > 8_000_000 || bytes > 24_000_000)
        throw new Error(
          'Remote image payload exceeds its size budget. Reduce frame resolution/count.',
        );
    }
  }
  if (count > 16)
    throw new Error('Remote image timeline supports at most 16 frames. Reduce frame count.');
  if (model.outputFormat === 'json-schema' && !support.jsonSchema)
    throw new Error(
      'Selected model does not support strict JSON Schema output. Choose prompt-guided JSON or override verified capabilities.',
    );
  if (model.outputFormat === 'json-object' && !support.jsonObject)
    throw new Error(
      'Selected model does not support JSON-object output. Choose prompt-guided JSON or override verified capabilities.',
    );
  if (request.sampling.seed !== undefined && !Number.isSafeInteger(request.sampling.seed))
    throw new Error('Invalid provider sampling seed.');
  if (
    !Number.isFinite(request.sampling.temperature) ||
    request.sampling.temperature < 0 ||
    request.sampling.temperature > 2
  )
    throw new Error('Invalid provider sampling temperature.');
  // Internal per-attempt seeds are advisory; explicit required controls fail closed.
  // Unsupported advisory seeds are declared in the request trace, not sent.
  if (
    request.sampling.seed !== undefined &&
    !support.seed &&
    request.sampling.seedMode === 'required'
  )
    throw new Error(
      'This model/protocol does not support seed. Remove the seed or choose a compatible model.',
    );
  // The built-in Unified temperature is a default, not an explicit provider control.
  if (request.sampling.temperature !== 0.7 && !support.sampling)
    throw new Error('This model/protocol does not support custom sampling temperature.');
  if (!Number.isInteger(request.sampling.maxTokens) || request.sampling.maxTokens < 1)
    throw new Error('Invalid maximum output token count.');
}
