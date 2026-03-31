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

const RECONNECT_THRESHOLD = 5_000;
const STALE_TIMEOUT = 30_000;
const ERROR_STALE_TIMEOUT = 60_000;

const rawStatus = ref<SyncPhase>("connecting");
let lastUpToDateAt = 0;
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
  clearStaleTimer();
  const timeout = rawStatus.value === "error" ? ERROR_STALE_TIMEOUT : STALE_TIMEOUT;
  staleTimer = setTimeout(() => {
    staleTimer = null;
    if (isActivePhase(rawStatus.value)) {
      rawStatus.value = "up_to_date";
    }
  }, timeout);
}

export function handleSdkSync(sdkState: string): void {
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    rawStatus.value = "offline";
    startStaleTimer();
    return;
  }

  switch (sdkState) {
    case "PREPARED": {
      lastUpToDateAt = Date.now();
      rawStatus.value = "up_to_date";
      clearStaleTimer();
      break;
    }
    case "SYNCING": {
      const gap = Date.now() - lastUpToDateAt;
      rawStatus.value = gap > RECONNECT_THRESHOLD ? "catching_up" : "syncing";
      if (rawStatus.value === "catching_up") startStaleTimer();
      else clearStaleTimer();
      break;
    }
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

export function resetSyncStatus(): void {
  rawStatus.value = "connecting";
  lastUpToDateAt = 0;
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
