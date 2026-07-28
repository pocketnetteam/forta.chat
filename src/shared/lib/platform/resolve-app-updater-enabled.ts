import { Capacitor, registerPlugin } from "@capacitor/core";

interface AppUpdaterPlugin {
  isEnabled(): Promise<{ enabled: boolean }>;
  checkForUpdate(): Promise<void>;
}

/**
 * True only on Android sideload builds where the native AppUpdater plugin
 * is registered (Play flavor strips REQUEST_INSTALL_PACKAGES and does not
 * register the plugin).
 */
export async function resolveAppUpdaterEnabled(): Promise<boolean> {
  if (Capacitor.getPlatform() !== "android") {
    return false;
  }

  try {
    const plugin = registerPlugin<AppUpdaterPlugin>("AppUpdater");
    const result = await plugin.isEnabled();
    return result.enabled === true;
  } catch {
    // Plugin missing on Play builds (not registered in MainActivity).
    return false;
  }
}
