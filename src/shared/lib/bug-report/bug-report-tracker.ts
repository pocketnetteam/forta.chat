import { APP_NAME } from '@/shared/config';
import { postToBugReportProxy } from './bug-report-proxy';
import { scrubPii } from './scrub-pii';

const LS_ACK_KEY = (address: string) =>
  `${APP_NAME}:bug-report-ack:${address}`;
const LS_REPORTS_KEY = (address: string) =>
  `${APP_NAME}:bug-report-mine:${address}`;

/** Minimal locally-cached info about an issue the user has reported. */
export interface LocalIssueCache {
  number: number;
  title: string;
  createdAt: string;
  lastKnownState: 'open' | 'closed';
  /**
   * Proof for the proxy that this device created the issue. Reports sent
   * before the proxy (audit S10-06) have none and cannot be closed or
   * reopened from the app.
   */
  manageKey?: string;
  /** Issue link from the proxy; empty for a private repository. Absent on reports sent before the proxy. */
  url?: string;
}

export type IssueStateReason = 'completed' | 'not_planned' | 'reopened' | null;

export interface TrackedIssue {
  number: number;
  title: string;
  url: string;
  state: 'open' | 'closed';
  closedAt: string | null;
  stateReason: IssueStateReason;
  /** The app holds the manage key, so the reporter can close or reopen the issue. */
  canManage: boolean;
}

/**
 * Asks the proxy to set the issue state and attach the reporter's note. True
 * only when the state changed; the proxy adds the note best effort.
 */
async function setIssueState(
  issueNumber: number,
  state: 'open' | 'closed',
  comment: string,
  manageKey: string,
): Promise<boolean> {
  try {
    const res = await postToBugReportProxy(`/v1/reports/${issueNumber}/state`, {
      state,
      comment: scrubPii(comment),
      manageKey,
    });
    if (!res.ok) {
      console.warn(`[bug-report-tracker] set #${issueNumber} ${state} returned ${res.status}`);
    }
    return res.ok;
  } catch (e) {
    console.warn(`[bug-report-tracker] set #${issueNumber} ${state} failed:`, e);
    return false;
  }
}

/** Reopen a closed issue and leave an explanatory comment. */
export function reopenIssue(issueNumber: number, comment: string, manageKey: string): Promise<boolean> {
  return setIssueState(issueNumber, 'open', comment, manageKey);
}

/** Close an open issue (user decides it is no longer relevant), with the user's note if any. */
export function closeIssue(issueNumber: number, comment: string, manageKey: string): Promise<boolean> {
  return setIssueState(issueNumber, 'closed', comment.trim(), manageKey);
}

// ─────────────────────────────────────────────────────────────────────────
// Local cache of reported issues
// ─────────────────────────────────────────────────────────────────────────
// Stored at bug-report submission time. The app holds no GitHub token, so
// this cache is all the "My reports" sheet knows. GitHub remains the source of
// truth for state; the cache is authoritative only for existence, title,
// createdAt and the manage key.

export function getLocalIssueCache(address: string): LocalIssueCache[] {
  if (!address) return [];
  try {
    const raw = localStorage.getItem(LS_REPORTS_KEY(address));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (i): i is LocalIssueCache =>
        !!i &&
        typeof i === 'object' &&
        typeof (i as LocalIssueCache).number === 'number' &&
        typeof (i as LocalIssueCache).title === 'string',
    );
  } catch {
    return [];
  }
}

export function trackCreatedIssue(
  address: string,
  entry: { number: number; title: string; manageKey: string; url: string | null },
): void {
  if (!address) return;
  const current = getLocalIssueCache(address);
  if (current.some((i) => i.number === entry.number)) return;
  const next: LocalIssueCache[] = [
    {
      number: entry.number,
      title: entry.title,
      createdAt: new Date().toISOString(),
      lastKnownState: 'open',
      manageKey: entry.manageKey,
      url: entry.url ?? '',
    },
    ...current,
  ];
  localStorage.setItem(LS_REPORTS_KEY(address), JSON.stringify(next));
}

export function updateLocalIssueState(
  address: string,
  issueNumber: number,
  newState: 'open' | 'closed',
): void {
  if (!address) return;
  const current = getLocalIssueCache(address);
  const next = current.map((i) =>
    i.number === issueNumber ? { ...i, lastKnownState: newState } : i,
  );
  localStorage.setItem(LS_REPORTS_KEY(address), JSON.stringify(next));
}

export function removeFromLocalCache(
  address: string,
  issueNumber: number,
): void {
  if (!address) return;
  const next = getLocalIssueCache(address).filter(
    (i) => i.number !== issueNumber,
  );
  localStorage.setItem(LS_REPORTS_KEY(address), JSON.stringify(next));
}

export function getAcknowledgedNumbers(address: string): number[] {
  if (!address) return [];
  try {
    const raw = localStorage.getItem(LS_ACK_KEY(address));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((n): n is number => typeof n === 'number');
  } catch {
    return [];
  }
}

export function hasAcknowledged(address: string, issueNumber: number): boolean {
  return getAcknowledgedNumbers(address).includes(issueNumber);
}

export function acknowledgeIssue(address: string, issueNumber: number): void {
  if (!address) return;
  const current = new Set(getAcknowledgedNumbers(address));
  current.add(issueNumber);
  localStorage.setItem(LS_ACK_KEY(address), JSON.stringify([...current]));
}

export function clearAcknowledged(
  address: string,
  issueNumber: number,
): void {
  if (!address) return;
  const next = getAcknowledgedNumbers(address).filter(
    (n) => n !== issueNumber,
  );
  localStorage.setItem(LS_ACK_KEY(address), JSON.stringify(next));
}
