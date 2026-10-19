import type { RecordedScenarioConfig } from '../shared/recorded-scenario-contract';
import type { SessionSnapshot } from '../shared/session-contract';
import {
  recordedMediaIssueText,
  validateRecordedMediaIssue,
  type RecordedMediaIssue,
} from '../shared/recorded-media-health';

export interface ActiveRecordedMediaRun {
  readonly id: string;
  readonly sessionRunId: number;
  readonly config: RecordedScenarioConfig;
}

interface MediaFailure {
  failRecordedMedia(source: string, message: string): SessionSnapshot;
}
interface MediaLog {
  warn(source: string, message: string, error?: unknown, context?: Record<string, unknown>): void;
  error(source: string, message: string, error?: unknown, context?: Record<string, unknown>): void;
}

/** Only main can assign Run correlation IDs or authorize enabled sources. */
export function reportRecordedMediaIssue(
  value: RecordedMediaIssue,
  run: ActiveRecordedMediaRun | null,
  state: SessionSnapshot,
  media: MediaFailure,
  logger: MediaLog,
): SessionSnapshot {
  const issue = validateRecordedMediaIssue(value);
  if (!run || state.runId !== run.sessionRunId || state.inputMode !== 'recorded')
    throw new Error('No active recorded Run for this diagnostic.');
  const source =
    issue.kind === 'video'
      ? issue.sourceId === 'recorded:video' && run.config.video
        ? 'video'
        : null
      : (run.config.audio.find((item) => item.enabled && item.id === issue.sourceId)?.label ??
        null);
  if (!source) throw new Error('Diagnostic source is not enabled for this Run.');
  const context = {
    runId: state.runId,
    recordedRunId: run.id,
    sourceId: issue.sourceId,
    sourceKind: issue.kind,
    code: issue.code,
    ...(issue.count === undefined ? {} : { count: issue.count }),
  };
  const description = recordedMediaIssueText(issue);
  if (issue.fatal) {
    if (
      !['starting', 'running', 'switching'].includes(state.phase) &&
      !(state.phase === 'error' && state.failureKind === 'inference')
    )
      throw new Error('Recorded Run is no longer accepting diagnostics.');
    logger.error('media', 'Recorded ' + issue.kind + ' ' + description, undefined, context);
    return media.failRecordedMedia(source, description);
  }
  if (
    !['starting', 'running', 'switching', 'error'].includes(state.phase) ||
    (state.phase === 'error' && state.failureKind !== 'inference')
  )
    throw new Error('Recorded Run is no longer accepting diagnostics.');
  logger.warn('media', 'Recorded ' + issue.kind + ' ' + description, undefined, context);
  return state;
}
