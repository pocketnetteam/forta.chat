import { ref, computed, watch, type Ref, type ComputedRef } from "vue";
import { useConnectivity } from "@/shared/lib/connectivity";
import { useDebouncedStatus, type DisplayPhase } from "./use-debounced-status";
import { useI18n, type TranslationKey } from "@/shared/lib/i18n";

export type SyncPhase =
  | "offline"
  | "connecting"
  | "catching_up"
  | "syncing"
  | "up_to_date"
  | "error";

export interface SyncStatusReturn {
  rawStatus: Readonly<Ref<SyncPhase>>;
  displayStatus: Readonly<Ref<DisplayPhase>>;
  showBanner: ComputedRef<boolean>;
  bannerText: ComputedRef<string>;
  bannerVariant: ComputedRef<"warning" | "info" | "success" | "error">;
}

const STALE_TIMEOUT = 30_000;
const ERROR_STALE_TIMEOUT = 60_000;
/** Two /sync long-poll timeouts (pollTimeout = 60s in matrix-client.ts): a
 *  healthy client completes a sync at least once per poll, so a gap this long
 *  means the chat list is behind and the next sync is a catch-up. */
const SYNC_FRESHNESS_THRESHOLD = 2 * 60_000;
/** Cap for the catch-up indicator; a long offline gap makes the first /sync slow. */
const CATCH_UP_STALE_TIMEOUT = 2 * 60_000;
const LAST_SYNC_KEY = "forta.sync.lastSuccessAt";

const rawStatus = ref<SyncPhase>("connecting");
let initialized = false;
let staleTimer: ReturnType<typeof setTimeout> | null = null;

let _debouncedResult: { visibleStatus: Ref<DisplayPhase> } | null = null;

function getDebounced() {
  if (!_debouncedResult) {
    _debouncedResult = useDebouncedStatus(rawStatus);
  }
  return _debouncedResult;
}

function isActivePhase(s: SyncPhase): boolean {
  return s === "offline" || s === "connecting" || s === "catching_up" || s === "error";
}

function clearStaleTimer() {
  if (staleTimer) {
    clearTimeout(staleTimer);
    staleTimer = null;
  }
}

function startStaleTimer() {
  // Anchor the cap to the FIRST active-phase entry of an episode. The old code
  // cleared and re-armed the timer on every ERROR/RECONNECTING, so as long as
  // errors arrived more often than the timeout the deadline was pushed out
  // forever and the banner never cleared (WEE-105 H4). Arm once per episode; a
  // healthy PREPARED/SYNCING clears it via clearStaleTimer, and the matrix
  // watchdog escalates a genuinely stuck sync to a mirror failover.
  if (staleTimer) return;
  const timeout =
    rawStatus.value === "error" ? ERROR_STALE_TIMEOUT
    : rawStatus.value === "catching_up" ? CATCH_UP_STALE_TIMEOUT
    : STALE_TIMEOUT;
  staleTimer = setTimeout(() => {
    staleTimer = null;
    if (isActivePhase(rawStatus.value)) {
      rawStatus.value = "up_to_date";
    }
  }, timeout);
}

function readLastSyncAt(): number | null {
  try {
    const v = Number(localStorage.getItem(LAST_SYNC_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

function writeLastSyncAt(ts: number): void {
  try {
    localStorage.setItem(LAST_SYNC_KEY, String(ts));
  } catch {
    // Storage unavailable (private mode) — freshness check just stays off.
  }
}

/** Last completed /sync is older than the threshold → the next sync is a
 *  catch-up. Unknown (first launch) counts as fresh: nothing to compare with. */
function isSyncStale(): boolean {
  const last = readLastSyncAt();
  return last !== null && Date.now() - last > SYNC_FRESHNESS_THRESHOLD;
}

/** Show the catch-up indicator when the app comes back (cold start from the
 *  SDK cache, or resume from background) after the last successful sync went
 *  stale. Cleared by the next SYNCING. Never overrides offline/error states. */
export function checkSyncFreshness(): void {
  if (typeof navigator !== "undefined" && !navigator.onLine) return;
  if (isActivePhase(rawStatus.value) || !isSyncStale()) return;
  rawStatus.value = "catching_up";
  startStaleTimer();
}

/** True once a live /sync completed in this page. Until then the chat list is
 *  whatever the SDK cache held, and the header spinner stays up. */
let liveSyncSeen = false;

export function handleSdkSync(sdkState: string, info?: { fromCache?: boolean }): void {
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    rawStatus.value = "offline";
    startStaleTimer();
    return;
  }

  switch (sdkState) {
    case "PREPARED":
      // PREPARED replayed from the SDK cache does not prove the data is
      // current: keep the spinner up until the first live /sync of the page.
      if (info?.fromCache && !liveSyncSeen) {
        rawStatus.value = "catching_up";
        startStaleTimer();
        break;
      }
      liveSyncSeen = true;
      writeLastSyncAt(Date.now());
      rawStatus.value = "up_to_date";
      clearStaleTimer();
      break;
    case "SYNCING":
      // The SDK emits SYNCING after every completed /sync, including routine
      // long-poll returns every ~30s and the first sync after a reconnect.
      // Either way the data is already in, so it is a healthy state. Measuring
      // the time since PREPARED flagged every routine poll as catch-up and kept
      // the header spinner on permanently.
      liveSyncSeen = true;
      rawStatus.value = "syncing";
      clearStaleTimer();
      writeLastSyncAt(Date.now());
      break;
    case "ERROR":
    case "STOPPED":
      rawStatus.value = "error";
      startStaleTimer();
      break;
    case "RECONNECTING":
      rawStatus.value = "connecting";
      startStaleTimer();
      break;
  }
}

function attachResumeListeners(): void {
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) checkSyncFreshness();
    });
  }
  // Capacitor's appStateChange can fire before visibilitychange on Android.
  import("@capacitor/app")
    .then(({ App }) => App.addListener("appStateChange", ({ isActive }) => {
      if (isActive) checkSyncFreshness();
    }))
    .catch(() => { /* @capacitor/app unavailable on web */ });
}

export function resetSyncStatus(): void {
  liveSyncSeen = false;
  rawStatus.value = "connecting";
  clearStaleTimer();
}

export function useSyncStatus(): SyncStatusReturn {
  if (!initialized) {
    initialized = true;
    const { isOnline } = useConnectivity();

    watch(isOnline, (online) => {
      if (!online) {
        rawStatus.value = "offline";
      } else if (rawStatus.value === "offline") {
        rawStatus.value = "connecting";
      }
    });

    attachResumeListeners();
  }

  const { visibleStatus } = getDebounced();

  const showBanner = computed(() => {
    const s = visibleStatus.value;
    return s !== "idle" && s !== "syncing";
  });

  const { t } = useI18n();

  const bannerTextKeys: Record<string, TranslationKey> = {
    offline: "sync.offline",
    connecting: "sync.connecting",
    catching_up: "sync.catchingUp",
    up_to_date: "sync.upToDate",
    error: "sync.error",
  };

  const bannerText = computed(() => {
    const key = bannerTextKeys[visibleStatus.value];
    return key ? t(key) : "";
  });

  const bannerVariant = computed<"warning" | "info" | "success" | "error">(() => {
    switch (visibleStatus.value) {
      case "offline":
      case "connecting": return "warning";
      case "catching_up": return "info";
      case "up_to_date": return "success";
      case "error": return "error";
      default: return "info";
    }
  });

  return { rawStatus, displayStatus: visibleStatus, showBanner, bannerText, bannerVariant };
}
