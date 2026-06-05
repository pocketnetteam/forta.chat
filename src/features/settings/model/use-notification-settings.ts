import { ref, computed, type Ref, type ComputedRef } from "vue";
import { PushData } from "@/shared/lib/push/push-data-plugin";
import {
  classifyVendor,
  type VendorEnergySaverId,
} from "@/shared/lib/push/vendor-energy-saver";
import { isAndroid, isNative } from "@/shared/lib/platform";

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

  return {
    canOpenSystemSettings,
    vendorGuidanceId,
    openSystemNotificationSettings,
    detectVendor,
  };
}
