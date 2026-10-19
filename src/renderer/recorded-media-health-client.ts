import { recordedMediaIssueText, type RecordedMediaIssue } from '../shared/recorded-media-health';

/** Only categorical metrics cross IPC; paths, codec messages and transcript data stay local. */
export function reportRecordedIssue(issue: RecordedMediaIssue): void {
  const api = window.lonelyChat;
  if (!api) return;
  const request = api.reportRecordedMediaIssue
    ? api.reportRecordedMediaIssue(issue)
    : issue.fatal
      ? api.reportRecordedVideoError(recordedMediaIssueText(issue))
      : null;
  void request?.catch(() => {
    // A diagnostic racing Stop/EOF must never resurrect an already finished Run.
  });
}
