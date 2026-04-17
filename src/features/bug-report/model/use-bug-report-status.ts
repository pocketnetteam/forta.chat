/**
 * Composable for the "My bug reports" sheet.
 *
 * Everything is driven by the per-address localStorage cache populated at
 * submission time (trackCreatedIssue) and updated by the close/reopen
 * actions. We explicitly do NOT query GitHub search to list issues —
 * burning the PAT's 5000 req/hr rate limit for tens of thousands of users
 * each launch is not worth it.
 *
 * Cost: one GitHub call per explicit close/reopen action only.
 */
import { ref, readonly } from 'vue';
import { APP_NAME } from '@/shared/config';
import {
  reopenIssue,
  closeIssue,
  getLocalIssueCache,
  updateLocalIssueState,
  type TrackedIssue,
} from '@/shared/lib/bug-report';

const REPO_URL = 'https://github.com/greenShirtMystery/forta-bugs/issues';

// ─── Boot-trigger policy ───────────────────────────────────────────────
// The sheet is auto-opened after login when the user has locally-tracked
// reports AND at least one of: new app version since last check, or
// >3 days elapsed since last check. Purely local — no network involved.
const VERSION_KEY = `${APP_NAME}:bug-report-status:last-version`;
const CHECKED_AT_KEY = `${APP_NAME}:bug-report-status:last-checked-at`;
const INTERVAL_MS = 3 * 24 * 60 * 60 * 1000;

function readLS<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function shouldCheckOnBoot(currentVersion: string): boolean {
  if (!currentVersion) return true;
  const storedVersion = readLS<string>(VERSION_KEY);
  if (!storedVersion) return true;
  if (storedVersion !== currentVersion) return true;
  const lastCheckedAt = readLS<number>(CHECKED_AT_KEY);
  if (typeof lastCheckedAt !== 'number') return true;
  return Date.now() - lastCheckedAt > INTERVAL_MS;
}

export function markBootCheckCompleted(currentVersion: string): void {
  localStorage.setItem(VERSION_KEY, JSON.stringify(currentVersion));
  localStorage.setItem(CHECKED_AT_KEY, JSON.stringify(Date.now()));
}

// Module-level singleton state so the sheet shares data across call sites.
const allIssues = ref<TrackedIssue[]>([]);
const loading = ref(false);
const sheetOpen = ref(false);

export function useBugReportStatus() {
  /** Load every locally-tracked issue. Purely local — no network. */
  function loadAllIssues(address: string): void {
    if (!address) {
      allIssues.value = [];
      return;
    }
    const cache = getLocalIssueCache(address);
    allIssues.value = cache
      .map(
        (c): TrackedIssue => ({
          number: c.number,
          title: c.title,
          url: `${REPO_URL}/${c.number}`,
          state: c.lastKnownState,
          closedAt: null,
          stateReason: null,
        }),
      )
      .sort((a, b) => b.number - a.number);
  }

  async function markUnresolved(
    address: string,
    issueNumber: number,
    reason: string,
  ): Promise<boolean> {
    if (!address) return false;
    const comment = reason.trim()
      ? `Reporter says it is still broken:\n\n> ${reason.trim().slice(0, 1000)}`
      : 'Reporter reopened this via the app — the bug is not fixed.';
    loading.value = true;
    try {
      const ok = await reopenIssue(issueNumber, comment);
      if (!ok) return false;
      updateLocalIssueState(address, issueNumber, 'open');
      allIssues.value = allIssues.value.map((i) =>
        i.number === issueNumber
          ? { ...i, state: 'open', closedAt: null, stateReason: 'reopened' }
          : i,
      );
      return true;
    } finally {
      loading.value = false;
    }
  }

  async function closeUserIssue(
    address: string,
    issueNumber: number,
    reason: string,
  ): Promise<boolean> {
    if (!address) return false;
    const comment = reason.trim()
      ? `Reporter closed this via the app with a note:\n\n> ${reason.trim().slice(0, 1000)}`
      : '';
    loading.value = true;
    try {
      const ok = await closeIssue(issueNumber, comment);
      if (!ok) return false;
      updateLocalIssueState(address, issueNumber, 'closed');
      allIssues.value = allIssues.value.map((i) =>
        i.number === issueNumber
          ? {
              ...i,
              state: 'closed',
              closedAt: new Date().toISOString(),
              stateReason: 'completed',
            }
          : i,
      );
      return true;
    } finally {
      loading.value = false;
    }
  }

  function openSheet(): void {
    sheetOpen.value = true;
  }

  function closeSheet(): void {
    sheetOpen.value = false;
  }

  function resetState(): void {
    allIssues.value = [];
    loading.value = false;
    sheetOpen.value = false;
  }

  return {
    allIssues: readonly(allIssues),
    loading: readonly(loading),
    sheetOpen: readonly(sheetOpen),
    loadAllIssues,
    markUnresolved,
    closeUserIssue,
    openSheet,
    closeSheet,
    resetState,
  };
}
