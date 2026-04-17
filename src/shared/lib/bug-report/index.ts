export { collectEnvironment } from './collect-environment';
export { sendBugReport } from './bug-report-sender';
export {
  computeReporterHash,
  buildReporterMarker,
  extractReporterHashFromBody,
  REPORTER_MARKER_PREFIX,
} from './reporter-hash';
export {
  fetchUserClosedIssues,
  fetchAllUserIssues,
  reopenIssue,
  closeIssue,
  getAcknowledgedNumbers,
  hasAcknowledged,
  acknowledgeIssue,
  clearAcknowledged,
  getLocalIssueCache,
  trackCreatedIssue,
  updateLocalIssueState,
  removeFromLocalCache,
} from './bug-report-tracker';
export type { TrackedIssue, IssueStateReason, LocalIssueCache } from './bug-report-tracker';
export type { AppEnvironment, BugReportInput } from './types';
export type { BugReportResult } from './bug-report-sender';
