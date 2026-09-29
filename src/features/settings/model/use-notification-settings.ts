import { ref, computed, type Ref, type ComputedRef } from "vue";
import { PushData } from "@/shared/lib/push/push-data-plugin";
import {
  classifyVendor,
  type VendorEnergySaverId,
} from "@/shared/lib/push/vendor-energy-saver";
import { isAndroid, isNative } from "@/shared/lib/platform";
import {
  isIncomingCallsEnabled,
  setIncomingCallsEnabled as storeIncomingCallsEnabled,
} from "@/shared/lib/push/incoming-calls-setting";

/**
 * Notification settings surface (WEE-75 / forta-bugs#942).
 *
 * On Android O+ the per-channel sound and vibration toggles are owned by the
 * OS — the app cannot mutate an already-created NotificationChannel. So the
 * honest "manage notification sound" control is a deep-link into the system
 * notification settings. For OEMs with aggressive notification management
 * (Xiaomi/MIUI, Samsung, etc.) we additionally surface a hint, since those
 * vendors can silence a channel that the app configured correctly.
 *
 * This composable wires the native deep-link and classifies the device so the
 * UI can decide whether to show vendor guidance. The classification itself is
 * the pure `classifyVendor` helper, kept testable on its own.
 */
export interface UseNotificationSettings {
  /** True when the OS exposes a notification-settings deep-link (native Android). */
  canOpenSystemSettings: ComputedRef<boolean>;
  /** Aggressive-OEM id (e.g. `xiaomi`) when guidance applies, else null. */
  vendorGuidanceId: Ref<VendorEnergySaverId | null>;
  /** Open the OS notification settings for this app. Resolves to false when
   *  the platform can't honour it or the native call fails. */
  openSystemNotificationSettings: () => Promise<boolean>;
  /** Detect the device vendor so the UI can show targeted guidance. */
  detectVendor: () => Promise<void>;
  /**
   * O10: false when Android has revoked the full-screen incoming-call
   * surface for this app (Android 14+ sideloads), true when it is allowed,
   * null while unknown or where the question does not apply.
   */
  fullScreenIntentAllowed: Ref<boolean | null>;
  /** Ask the OS whether the full-screen intent is still granted. */
  detectFullScreenIntent: () => Promise<void>;
  /** Open the system screen that grants it. False when unavailable. */
  openFullScreenIntentSettings: () => Promise<boolean>;
  /** "Incoming calls" switch (#1388): off, Forta does not ring at all. */
  incomingCallsEnabled: Ref<boolean>;
  setIncomingCallsEnabled: (enabled: boolean) => Promise<void>;
}

export function useNotificationSettings(): UseNotificationSettings {
  const vendorGuidanceId = ref<VendorEnergySaverId | null>(null);

  const canOpenSystemSettings = computed(() => isNative && isAndroid);

  const detectVendor = async (): Promise<void> => {
    if (!isNative || !isAndroid) return;
    try {
      const { manufacturer } = await PushData.getDeviceManufacturer();
      vendorGuidanceId.value = classifyVendor(manufacturer)?.id ?? null;
    } catch (e) {
      console.warn("[notification-settings] vendor detection failed:", e);
      vendorGuidanceId.value = null;
    }
  };

  const fullScreenIntentAllowed = ref<boolean | null>(null);

  const detectFullScreenIntent = async (): Promise<void> => {
    if (!isNative || !isAndroid) return;
    try {
      const status = await PushData.getFullScreenIntentStatus();
      // Before Android 14 there is nothing to manage, so nothing to show.
      fullScreenIntentAllowed.value = status.manageable ? status.allowed : null;
    } catch (e) {
      console.warn("[notification-settings] full-screen intent status failed:", e);
      fullScreenIntentAllowed.value = null;
    }
  };

  const openFullScreenIntentSettings = async (): Promise<boolean> => {
    if (!canOpenSystemSettings.value) return false;
    try {
      await PushData.openFullScreenIntentSettings();
      return true;
    } catch (e) {
      console.warn("[notification-settings] openFullScreenIntentSettings failed:", e);
      return false;
    }
  };

  const openSystemNotificationSettings = async (): Promise<boolean> => {
    if (!canOpenSystemSettings.value) return false;
    try {
      await PushData.openNotificationSettings();
      return true;
    } catch (e) {
      console.warn("[notification-settings] openNotificationSettings failed:", e);
      return false;
    }
  };

  const incomingCallsEnabled = ref(isIncomingCallsEnabled());
  const setIncomingCallsEnabled = async (enabled: boolean): Promise<void> => {
    incomingCallsEnabled.value = enabled;
    await storeIncomingCallsEnabled(enabled);
  };

  return {
    incomingCallsEnabled,
    setIncomingCallsEnabled,
    canOpenSystemSettings,
    vendorGuidanceId,
    openSystemNotificationSettings,
    detectVendor,
    fullScreenIntentAllowed,
    detectFullScreenIntent,
    openFullScreenIntentSettings,
  };
}
