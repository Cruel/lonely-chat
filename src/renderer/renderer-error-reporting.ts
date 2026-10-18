import {
  makeRendererFailure,
  type RendererArea,
  type RendererFailureKind,
} from '../shared/renderer-log-contract';

/** Never report arbitrary exception messages, component props, or private input data. */
export function reportRendererFailure(
  area: RendererArea,
  kind: RendererFailureKind,
  error: unknown,
): void {
  // The public overlay has no desktop API and must never acquire one.
  void window.lonelyChat
    ?.reportRendererFailure(makeRendererFailure(area, kind, error))
    .catch(() => {
      // An unavailable main process must not trigger an unhandled rejection loop.
    });
}

export function installRendererErrorReporting(): () => void {
  if (!window.lonelyChat) return () => {};
  const uncaught = (event: ErrorEvent) =>
    reportRendererFailure('application', 'uncaught', event.error);
  const rejected = (event: PromiseRejectionEvent) =>
    reportRendererFailure('application', 'unhandled-rejection', event.reason);
  window.addEventListener('error', uncaught);
  window.addEventListener('unhandledrejection', rejected);
  return () => {
    window.removeEventListener('error', uncaught);
    window.removeEventListener('unhandledrejection', rejected);
  };
}
