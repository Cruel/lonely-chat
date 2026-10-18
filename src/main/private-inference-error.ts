/** Inference provider details are private. Operational logs may retain only the public message. */
export class PrivateInferenceError extends Error {
  constructor(
    message: string,
    readonly diagnosticDetails: unknown,
  ) {
    super(message);
    this.name = 'PrivateInferenceError';
  }
}
