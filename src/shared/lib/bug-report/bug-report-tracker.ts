import { APP_NAME } from '@/shared/config';
import { computeReporterHash, extractReporterHashFromBody } from './reporter-hash';

const REPO = 'greenShirtMystery/forta-bugs';
const API_BASE = 'https://api.github.com';
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
}

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

async function fetchIssues(
  address: string,
  stateFilter: 'open' | 'closed' | 'all',
): Promise<TrackedIssue[]> {
  if (!address) return [];
  try {
    const token = getToken();
    const hash = await computeReporterHash(address);
    // GitHub Issues search has no `reporter:` qualifier, so search the
    // marker as a quoted literal in the body. Client-side re-checks the
    // body to guard against false positives (partial token matches, etc.).
    const marker = `reporter:${hash}`;
    const stateTerm = stateFilter === 'all' ? '' : ` state:${stateFilter}`;
    const query = `repo:${REPO} "${marker}" in:body${stateTerm}`;
    const url =
      `${API_BASE}/search/issues?q=${encodeURIComponent(query)}` +
      `&per_page=50&sort=updated`;
    const res = await fetch(url, { headers: ghHeaders(token) });
    if (!res.ok) {
      console.warn(
        `[bug-report-tracker] search ${stateFilter} returned ${res.status}`,
      );
      return [];
    }
    const data = (await res.json()) as { items?: unknown[]; total_count?: number };
    const items = Array.isArray(data.items) ? data.items : [];
    console.log(
      `[bug-report-tracker] search ${stateFilter} for ${hash}: ${items.length} raw items (total=${data.total_count ?? '?'})`,
    );
    const filtered = items
      .filter((raw) => {
        if (!raw || typeof raw !== 'object') return false;
        const body = (raw as Record<string, unknown>).body;
        const matched = extractReporterHashFromBody(
          typeof body === 'string' ? body : null,
        ) === hash;
        if (!matched) {
          const num = (raw as Record<string, unknown>).number;
          console.warn(
            `[bug-report-tracker] search returned #${num} but body marker missing/mismatch — dropped`,
          );
        }
        return matched;
      })
      .map(parseIssue)
      .filter((x): x is TrackedIssue => x !== null);
    console.log(
      `[bug-report-tracker] search ${stateFilter}: ${filtered.length} items after marker filter`,
    );
    return filtered;
  } catch (e) {
    console.warn('[bug-report-tracker] fetchIssues failed:', e);
    return [];
  }
}

export function fetchUserClosedIssues(address: string): Promise<TrackedIssue[]> {
  return fetchIssues(address, 'closed');
}

export function fetchAllUserIssues(address: string): Promise<TrackedIssue[]> {
  return fetchIssues(address, 'all');
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

/**
 * Close an open issue (user decides it is no longer relevant).
 * Returns true only if the PATCH succeeded. A comment with the user's note
 * is attached best-effort.
 */
export async function closeIssue(
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
        body: JSON.stringify({ state: 'closed', state_reason: 'completed' }),
      },
    );
    patched = res.ok;
    if (!patched) {
      console.warn(
        `[bug-report-tracker] closeIssue PATCH ${issueNumber} returned ${res.status}`,
      );
    }
  } catch (e) {
    console.warn('[bug-report-tracker] closeIssue PATCH failed:', e);
  }
  if (comment.trim()) {
    try {
      await fetch(`${API_BASE}/repos/${REPO}/issues/${issueNumber}/comments`, {
        method: 'POST',
        headers: ghHeaders(token),
        body: JSON.stringify({ body: comment }),
      });
    } catch (e) {
      console.warn('[bug-report-tracker] closeIssue comment failed:', e);
    }
  }
  return patched;
}

// ─────────────────────────────────────────────────────────────────────────
// Local cache of reported issues
// ─────────────────────────────────────────────────────────────────────────
// Stored at bug-report submission time so the "My reports" sheet can render
// instantly without depending on GitHub search indexing (which lags 1–2 min
// after issue creation). GitHub remains the source of truth for state; the
// cache is authoritative only for existence + title + createdAt.

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
  entry: { number: number; title: string },
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
