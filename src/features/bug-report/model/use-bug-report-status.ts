/**
 * Composable for the bug-report status review sheet.
 *
 * Tracks issues that the maintainer has closed on GitHub for the current user
 * and surfaces them so the user can confirm the fix worked ("Решено") or
 * re-open the issue with a short note ("Всё ещё баг").
 *
 * Trigger policy (see shouldCheckOnBoot):
 *   - first app run ever, OR
 *   - app version changed since last check, OR
 *   - more than 3 days since the last check.
 */
import { ref, readonly, computed } from 'vue';
import { APP_NAME } from '@/shared/config';
import {
  fetchUserClosedIssues,
  reopenIssue,
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

  function confirmResolved(address: string, issueNumber: number): void {
    if (!address) return;
    acknowledgeIssue(address, issueNumber);
    pendingIssues.value = pendingIssues.value.filter(
      (i) => i.number !== issueNumber,
    );
  }

  async function markUnresolved(
    address: string,
    issueNumber: number,
    reason: string,
  ): Promise<void> {
    if (!address) return;
    const comment = reason.trim()
      ? `Reporter says it is still broken:\n\n> ${reason.trim().slice(0, 1000)}`
      : 'Reporter reopened this via the app — the bug is not fixed.';
    await reopenIssue(issueNumber, comment);
    // Ack locally so we don't keep surfacing it; if maintainer closes it again
    // later, the new closed_at will differ and we will query again but the
    // acknowledgement already cleared our interest.
    acknowledgeIssue(address, issueNumber);
    pendingIssues.value = pendingIssues.value.filter(
      (i) => i.number !== issueNumber,
    );
  }

  function openSheet(): void {
    sheetOpen.value = true;
  }

  function closeSheet(): void {
    sheetOpen.value = false;
  }

  return {
    pendingIssues: readonly(pendingIssues),
    loading: readonly(loading),
    sheetOpen: readonly(sheetOpen),
    hasPending,
    checkStatuses,
    confirmResolved,
    markUnresolved,
    openSheet,
    closeSheet,
  };
}
