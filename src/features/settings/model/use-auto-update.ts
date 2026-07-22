import { computed, onScopeDispose, ref, type ComputedRef, type Ref } from "vue";
import { getElectronAPI, isElectron } from "@/shared/lib/platform";
import type {
  ElectronUpdateState,
  ElectronUpdateStatus,
} from "@/shared/types/electron";

const IDLE: ElectronUpdateState = {
  status: "idle",
  version: null,
  percent: null,
  error: null,
  enabled: false,
};

export interface UseAutoUpdate {
  isAvailable: boolean;
  status: Ref<ElectronUpdateStatus>;
  version: Ref<string | null>;
  percent: Ref<number | null>;
  error: Ref<string | null>;
  enabled: Ref<boolean>;
  /** True while checking or downloading. */
  isBusy: ComputedRef<boolean>;
  /** Update downloaded and ready to install. */
  canInstall: ComputedRef<boolean>;
  checkForUpdates: () => Promise<void>;
  quitAndInstall: () => Promise<void>;
}

/**
 * Desktop auto-update state from main (`electron-updater` via electronAPI).
 */
export function useAutoUpdate(): UseAutoUpdate {
  const status = ref<ElectronUpdateStatus>(IDLE.status);
  const version = ref<string | null>(IDLE.version);
  const percent = ref<number | null>(IDLE.percent);
  const error = ref<string | null>(IDLE.error);
  const enabled = ref(IDLE.enabled);
  const available = isElectron && !!getElectronAPI()?.getUpdateStatus;

  const apply = (state: ElectronUpdateState) => {
    status.value = state.status;
    version.value = state.version;
    percent.value = state.percent;
    error.value = state.error;
    enabled.value = state.enabled;
  };

  let unsubscribe: (() => void) | undefined;

  const hydrate = async () => {
    const api = getElectronAPI();
    if (!api?.getUpdateStatus) return;
    try {
      apply(await api.getUpdateStatus());
    } catch (e) {
      console.warn("[auto-update] hydrate failed:", e);
    }
  };

  if (available) {
    const api = getElectronAPI();
    unsubscribe = api?.onUpdateStatus?.(apply);
    void hydrate();
    onScopeDispose(() => {
      unsubscribe?.();
    });
  }

  const isBusy = computed(
    () => status.value === "checking" || status.value === "downloading",
  );

  const canInstall = computed(
    () => enabled.value && status.value === "downloaded",
  );

  const checkForUpdates = async () => {
    const api = getElectronAPI();
    if (!api?.checkForUpdates) return;
    try {
      apply(await api.checkForUpdates());
    } catch (e) {
      console.warn("[auto-update] check failed:", e);
      error.value = e instanceof Error ? e.message : String(e);
      status.value = "error";
    }
  };

  const quitAndInstall = async () => {
    const api = getElectronAPI();
    if (!api?.quitAndInstallUpdate) return;
    try {
      await api.quitAndInstallUpdate();
    } catch (e) {
      console.warn("[auto-update] quitAndInstall failed:", e);
    }
  };

  return {
    isAvailable: available,
    status,
    version,
    percent,
    error,
    enabled,
    isBusy,
    canInstall,
    checkForUpdates,
    quitAndInstall,
  };
}
