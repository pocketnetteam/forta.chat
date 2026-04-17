import { APP_NAME } from '@/shared/config';
import { computeReporterHash } from './reporter-hash';

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
    const query = `repo:${REPO} reporter:${hash} state:closed`;
    const url =
      `${API_BASE}/search/issues?q=${encodeURIComponent(query)}` +
      `&per_page=50&sort=updated`;
    const res = await fetch(url, { headers: ghHeaders(token) });
    if (!res.ok) return [];
    const data = (await res.json()) as { items?: unknown[] };
    const items = Array.isArray(data.items) ? data.items : [];
    return items.map(parseIssue).filter((x): x is TrackedIssue => x !== null);
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

export async function reopenIssue(
  issueNumber: number,
  comment: string,
): Promise<void> {
  const token = getToken();
  // PATCH first; comment is best-effort so that even a partial success still
  // leaves a trail on the issue for the maintainer.
  try {
    await fetch(`${API_BASE}/repos/${REPO}/issues/${issueNumber}`, {
      method: 'PATCH',
      headers: ghHeaders(token),
      body: JSON.stringify({ state: 'open', state_reason: 'reopened' }),
    });
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
