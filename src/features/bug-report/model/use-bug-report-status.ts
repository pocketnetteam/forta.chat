/**
 * Composable for the "My bug reports" sheet.
 *
 * Everything is driven by the per-address localStorage cache populated at
 * submission time (trackCreatedIssue) and updated by the close/reopen
 * actions. The app holds no GitHub token (audit S10-06): a close or reopen
 * goes through the bug-report proxy with the issue's manage key.
 *
 * Cost: one proxy call per explicit close/reopen action only.
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

/** Where reports went before the proxy; their cache entries carry no link. */
const LEGACY_REPO_URL = 'https://github.com/greenShirtMystery/forta-bugs/issues';

// ─── Boot-trigger policy ───────────────────────────────────────────────
// The sheet is auto-opened after login when the user has locally-tracked
// reports AND >2 days elapsed since last check. Version changes do NOT
// trigger the sheet — after an update the user needs time to actually use
// the new build before being asked whether their bug is resolved.
const CHECKED_AT_KEY = `${APP_NAME}:bug-report-status:last-checked-at`;
const INTERVAL_MS = 2 * 24 * 60 * 60 * 1000;

function readLS<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function shouldCheckOnBoot(): boolean {
  const lastCheckedAt = readLS<number>(CHECKED_AT_KEY);
  if (typeof lastCheckedAt !== 'number') return true;
  return Date.now() - lastCheckedAt > INTERVAL_MS;
}

/** The boot sheet asks only about reports the user can close or reopen. */
export function hasManageableIssue(issues: readonly TrackedIssue[]): boolean {
  return issues.some((issue) => issue.canManage);
}

function usableKey(key: unknown): string | undefined {
  return typeof key === 'string' && key ? key : undefined;
}

export function markBootCheckCompleted(): void {
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
          url: c.url ?? `${LEGACY_REPO_URL}/${c.number}`,
          state: c.lastKnownState,
          closedAt: null,
          stateReason: null,
          canManage: !!usableKey(c.manageKey),
        }),
      )
      .sort((a, b) => b.number - a.number);
  }

  function manageKeyOf(address: string, issueNumber: number): string | undefined {
    return usableKey(getLocalIssueCache(address).find((c) => c.number === issueNumber)?.manageKey);
  }

  async function markUnresolved(
    address: string,
    issueNumber: number,
    reason: string,
  ): Promise<boolean> {
    if (!address) return false;
    const manageKey = manageKeyOf(address, issueNumber);
    if (!manageKey) return false;
    const comment = reason.trim()
      ? `Reporter says it is still broken:\n\n> ${reason.trim().slice(0, 1000)}`
      : 'Reporter reopened this via the app — the bug is not fixed.';
    loading.value = true;
    try {
      const ok = await reopenIssue(issueNumber, comment, manageKey);
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
    const manageKey = manageKeyOf(address, issueNumber);
    if (!manageKey) return false;
    const comment = reason.trim()
      ? `Reporter closed this via the app with a note:\n\n> ${reason.trim().slice(0, 1000)}`
      : '';
    loading.value = true;
    try {
      const ok = await closeIssue(issueNumber, comment, manageKey);
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
