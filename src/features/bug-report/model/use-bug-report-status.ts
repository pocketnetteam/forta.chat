/**
 * Composable for the bug-report status review sheet.
 *
 * Tracks issues that the maintainer has closed on GitHub for the current user
 * and surfaces them so the user can confirm the fix worked ("Решено") or
 * re-open the issue with a short note ("Всё ещё баг").
 *
 * Trigger policy (see shouldCheckOnBoot):
 *   - first app run ever (kept enabled for easier manual testing), OR
 *   - app version changed since last check, OR
 *   - more than 3 days since the last check.
 */
import { ref, readonly, computed } from 'vue';
import { APP_NAME } from '@/shared/config';
import {
  fetchUserClosedIssues,
  fetchAllUserIssues,
  reopenIssue,
  closeIssue,
  getAcknowledgedNumbers,
  acknowledgeIssue,
  type TrackedIssue,
} from '@/shared/lib/bug-report';

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

export function resetBootCheckMeta(): void {
  localStorage.removeItem(VERSION_KEY);
  localStorage.removeItem(CHECKED_AT_KEY);
}

// Module-level singleton state so the sheet and boot trigger share data.
const pendingIssues = ref<TrackedIssue[]>([]);
// Full list used by the manual "My reports" sheet — includes both open and
// closed issues so the user can toggle state from within the app.
const allIssues = ref<TrackedIssue[]>([]);
const loading = ref(false);
const sheetOpen = ref(false);

export function useBugReportStatus() {
  const hasPending = computed(() => pendingIssues.value.length > 0);

  async function checkStatuses(address: string): Promise<void> {
    if (!address || loading.value) return;
    loading.value = true;
    try {
      const closed = await fetchUserClosedIssues(address);
      const acked = new Set(getAcknowledgedNumbers(address));
      pendingIssues.value = closed.filter((i) => !acked.has(i.number));
    } finally {
      loading.value = false;
    }
  }

  /** Load every issue reported by this user (open + closed) — used by the
   *  manual "My reports" entry point where the user wants to manage state. */
  async function loadAllIssues(address: string): Promise<void> {
    if (!address || loading.value) return;
    loading.value = true;
    try {
      allIssues.value = await fetchAllUserIssues(address);
    } finally {
      loading.value = false;
    }
  }

  function confirmResolved(address: string, issueNumber: number): void {
    if (!address) return;
    acknowledgeIssue(address, issueNumber);
    pendingIssues.value = pendingIssues.value.filter(
      (i) => i.number !== issueNumber,
    );
    allIssues.value = allIssues.value.filter((i) => i.number !== issueNumber);
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
    const ok = await reopenIssue(issueNumber, comment);
    if (!ok) return false;
    // Do NOT acknowledgeIssue here: the user said the fix did not work. If the
    // maintainer closes it again later with a new attempt, we want to ask the
    // user again.
    pendingIssues.value = pendingIssues.value.filter(
      (i) => i.number !== issueNumber,
    );
    // In the all-issues list, reflect the new open state instead of dropping it.
    allIssues.value = allIssues.value.map((i) =>
      i.number === issueNumber
        ? { ...i, state: 'open', closedAt: null, stateReason: 'reopened' }
        : i,
    );
    return true;
  }

  /** User decides an open issue is no longer relevant — close it on GitHub. */
  async function closeUserIssue(
    issueNumber: number,
    reason: string,
  ): Promise<boolean> {
    const comment = reason.trim()
      ? `Reporter closed this via the app with a note:\n\n> ${reason.trim().slice(0, 1000)}`
      : '';
    const ok = await closeIssue(issueNumber, comment);
    if (!ok) return false;
    allIssues.value = allIssues.value.map((i) =>
      i.number === issueNumber
        ? { ...i, state: 'closed', closedAt: new Date().toISOString(), stateReason: 'completed' }
        : i,
    );
    return true;
  }

  function openSheet(): void {
    sheetOpen.value = true;
  }

  function closeSheet(): void {
    sheetOpen.value = false;
  }

  /**
   * Wipe in-memory state. Call this from the logout path so another account
   * signed in on the same browser tab does not see the previous user's
   * unresolved issues.
   */
  function resetState(): void {
    pendingIssues.value = [];
    allIssues.value = [];
    loading.value = false;
    sheetOpen.value = false;
  }

  return {
    pendingIssues: readonly(pendingIssues),
    allIssues: readonly(allIssues),
    loading: readonly(loading),
    sheetOpen: readonly(sheetOpen),
    hasPending,
    checkStatuses,
    loadAllIssues,
    confirmResolved,
    markUnresolved,
    closeUserIssue,
    openSheet,
    closeSheet,
    resetState,
  };
}
