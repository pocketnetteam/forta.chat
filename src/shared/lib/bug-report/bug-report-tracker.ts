import { APP_NAME } from '@/shared/config';
import { computeReporterHash, extractReporterHashFromBody } from './reporter-hash';

const REPO = 'greenShirtMystery/forta-bugs';
const API_BASE = 'https://api.github.com';
const LS_ACK_KEY = (address: string) =>
  `${APP_NAME}:bug-report-ack:${address}`;

export type IssueStateReason = 'completed' | 'not_planned' | 'reopened' | null;

export interface TrackedIssue {
  number: number;
  title: string;
  url: string;
  state: 'open' | 'closed';
  closedAt: string | null;
  stateReason: IssueStateReason;
}

function getToken(): string {
  const token = import.meta.env.VITE_BUG_REPORT_TOKEN;
  if (!token) throw new Error('Bug report token not configured');
  return token;
}

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

export async function fetchUserClosedIssues(
  address: string,
): Promise<TrackedIssue[]> {
  if (!address) return [];
  try {
    const token = getToken();
    const hash = await computeReporterHash(address);
    // GitHub Issues search has no `reporter:` qualifier, so search the
    // marker as a quoted literal in the body. Client-side re-checks the
    // body to guard against false positives (partial token matches, etc.).
    const marker = `reporter:${hash}`;
    const query = `repo:${REPO} "${marker}" in:body state:closed`;
    const url =
      `${API_BASE}/search/issues?q=${encodeURIComponent(query)}` +
      `&per_page=50&sort=updated`;
    const res = await fetch(url, { headers: ghHeaders(token) });
    if (!res.ok) return [];
    const data = (await res.json()) as { items?: unknown[] };
    const items = Array.isArray(data.items) ? data.items : [];
    return items
      .filter((raw) => {
        if (!raw || typeof raw !== 'object') return false;
        const body = (raw as Record<string, unknown>).body;
        return extractReporterHashFromBody(
          typeof body === 'string' ? body : null,
        ) === hash;
      })
      .map(parseIssue)
      .filter((x): x is TrackedIssue => x !== null);
  } catch (e) {
    console.warn('[bug-report-tracker] fetchUserClosedIssues failed:', e);
    return [];
  }
}

function parseIssue(raw: unknown): TrackedIssue | null {
  if (!raw || typeof raw !== 'object') return null;
  const it = raw as Record<string, unknown>;
  if (typeof it.number !== 'number' || typeof it.title !== 'string') return null;
  const state = it.state === 'open' ? 'open' : 'closed';
  const stateReason = (
    it.state_reason === 'completed' ||
    it.state_reason === 'not_planned' ||
    it.state_reason === 'reopened'
      ? it.state_reason
      : null
  ) as IssueStateReason;
  return {
    number: it.number,
    title: it.title,
    url: typeof it.html_url === 'string' ? it.html_url : '',
    state,
    closedAt: typeof it.closed_at === 'string' ? it.closed_at : null,
    stateReason,
  };
}

/**
 * Reopen a closed issue and leave an explanatory comment.
 * Returns true only if the PATCH succeeded; the comment is best-effort and
 * does not affect the return value so the issue is still reopened even if
 * the comment POST fails.
 */
export async function reopenIssue(
  issueNumber: number,
  comment: string,
): Promise<boolean> {
  const token = getToken();
  let patched = false;
  try {
    const res = await fetch(
      `${API_BASE}/repos/${REPO}/issues/${issueNumber}`,
      {
        method: 'PATCH',
        headers: ghHeaders(token),
        body: JSON.stringify({ state: 'open', state_reason: 'reopened' }),
      },
    );
    patched = res.ok;
    if (!patched) {
      console.warn(
        `[bug-report-tracker] reopenIssue PATCH ${issueNumber} returned ${res.status}`,
      );
    }
  } catch (e) {
    console.warn('[bug-report-tracker] reopenIssue PATCH failed:', e);
  }
  try {
    await fetch(`${API_BASE}/repos/${REPO}/issues/${issueNumber}/comments`, {
      method: 'POST',
      headers: ghHeaders(token),
      body: JSON.stringify({ body: comment }),
    });
  } catch (e) {
    console.warn('[bug-report-tracker] reopenIssue comment failed:', e);
  }
  return patched;
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
