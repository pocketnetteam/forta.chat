import { ref, type Ref } from "vue";
import { getElectronAPI, isElectron } from "@/shared/lib/platform";
import type { ElectronDesktopSettings } from "@/shared/types/electron";

const DEFAULTS: ElectronDesktopSettings = {
  closeToTray: true,
  openAtLogin: false,
};

export interface UseDesktopSettings {
  /** True only inside Electron — hide the whole section elsewhere. */
  isAvailable: boolean;
  closeToTray: Ref<boolean>;
  openAtLogin: Ref<boolean>;
  loading: Ref<boolean>;
  setCloseToTray: (value: boolean) => Promise<void>;
  setOpenAtLogin: (value: boolean) => Promise<void>;
}

/**
 * Desktop UX prefs (close-to-tray, open-at-login) backed by main-process
 * userData JSON via electronAPI.
 */
export function useDesktopSettings(): UseDesktopSettings {
  const closeToTray = ref(DEFAULTS.closeToTray);
  const openAtLogin = ref(DEFAULTS.openAtLogin);
  const loading = ref(false);
  const available = isElectron && !!getElectronAPI();

  const hydrate = async () => {
    const api = getElectronAPI();
    if (!api?.getDesktopSettings) return;
    loading.value = true;
    try {
      const settings = await api.getDesktopSettings();
      closeToTray.value = settings.closeToTray;
      openAtLogin.value = settings.openAtLogin;
    } catch (e) {
      console.warn("[desktop-settings] hydrate failed:", e);
    } finally {
      loading.value = false;
    }
  };

  if (available) {
    void hydrate();
  }

  const setCloseToTray = async (value: boolean) => {
    const api = getElectronAPI();
    if (!api?.setDesktopSettings) return;
    closeToTray.value = value;
    try {
      const next = await api.setDesktopSettings({ closeToTray: value });
      closeToTray.value = next.closeToTray;
    } catch (e) {
      console.warn("[desktop-settings] setCloseToTray failed:", e);
      closeToTray.value = !value;
    }
  };

  const setOpenAtLogin = async (value: boolean) => {
    const api = getElectronAPI();
    if (!api?.setDesktopSettings) return;
    openAtLogin.value = value;
    try {
      const next = await api.setDesktopSettings({ openAtLogin: value });
      openAtLogin.value = next.openAtLogin;
    } catch (e) {
      console.warn("[desktop-settings] setOpenAtLogin failed:", e);
      openAtLogin.value = !value;
    }
  };

  return {
    isAvailable: available,
    closeToTray,
    openAtLogin,
    loading,
    setCloseToTray,
    setOpenAtLogin,
  };
}
