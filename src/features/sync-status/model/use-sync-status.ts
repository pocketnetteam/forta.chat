import { ref, computed, watch, type Ref, type ComputedRef } from "vue";
import { useConnectivity } from "@/shared/lib/connectivity";
import { useDebouncedStatus, type DisplayPhase } from "./use-debounced-status";

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

const rawStatus = ref<SyncPhase>("connecting");
let lastUpToDateAt = 0;
let initialized = false;

let _debouncedResult: { visibleStatus: Ref<DisplayPhase> } | null = null;

function getDebounced() {
  if (!_debouncedResult) {
    _debouncedResult = useDebouncedStatus(rawStatus);
  }
  return _debouncedResult;
}

export function handleSdkSync(sdkState: string): void {
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    rawStatus.value = "offline";
    return;
  }

  switch (sdkState) {
    case "PREPARED": {
      lastUpToDateAt = Date.now();
      rawStatus.value = "up_to_date";
      break;
    }
    case "SYNCING": {
      const gap = Date.now() - lastUpToDateAt;
      rawStatus.value = gap > RECONNECT_THRESHOLD ? "catching_up" : "syncing";
      break;
    }
    case "ERROR":
    case "STOPPED":
      rawStatus.value = "error";
      break;
    case "RECONNECTING":
      rawStatus.value = "connecting";
      break;
  }
}

export function resetSyncStatus(): void {
  rawStatus.value = "connecting";
  lastUpToDateAt = 0;
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

  const bannerText = computed(() => {
    switch (visibleStatus.value) {
      case "offline": return "Ожидание сети...";
      case "connecting": return "Соединение...";
      case "catching_up": return "Обновление...";
      case "up_to_date": return "Обновлено";
      case "error": return "Не удалось подключиться";
      default: return "";
    }
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
