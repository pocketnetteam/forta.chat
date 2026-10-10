<script setup lang="ts">
import { ref, watch } from "vue";
import { useAuthStore } from "@/entities/auth";
import { useI18n } from "@/shared/lib/i18n";
import { isAndroid, isNative } from "@/shared/lib/platform";
import { PushData } from "@/shared/lib/push/push-data-plugin";
import { classifyVendor, type VendorEnergySaverId } from "@/shared/lib/push/vendor-energy-saver";
import { isIncomingCallsEnabled } from "@/shared/lib/push/incoming-calls-setting";
import { shouldShowBatteryHint } from "../model/battery-hint-policy";
import {
  isBatteryHintDisabled,
  readBatteryHintLastShownAt,
  writeBatteryHintLastShownAt,
} from "@/shared/lib/push/battery-hint-storage";

/** Brand names for the autostart line; the ids come from vendor-energy-saver. */
const VENDOR_NAMES: Record<VendorEnergySaverId, string> = {
  samsung: "Samsung",
  huawei: "Huawei",
  honor: "HONOR",
  xiaomi: "Xiaomi",
  oppo: "OPPO",
  oneplus: "OnePlus",
  vivo: "vivo",
  realme: "realme",
};

const { t } = useI18n();
const authStore = useAuthStore();
const visible = ref(false);
const vendorName = ref<string | null>(null);
/** Checked for this sign-in: the hint is a once-per-session question at most. */
let checkedThisSession = false;

const evaluate = async () => {
  if (checkedThisSession || !isNative || !isAndroid) return;
  checkedThisSession = true;
  let ignoring: boolean | null = null;
  try {
    ignoring = (await PushData.getBatteryOptimizationStatus()).ignoring;
  } catch (e) {
    console.warn("[battery-hint] battery optimization status unavailable:", e);
  }
  const now = Date.now();
  const show = shouldShowBatteryHint({
    isAndroidNative: true,
    signedIn: authStore.isAuthenticated,
    incomingCallsEnabled: isIncomingCallsEnabled(),
    ignoringOptimizations: ignoring,
    disabled: isBatteryHintDisabled(),
    lastShownAt: readBatteryHintLastShownAt(),
    now,
  });
  if (!show) return;
  try {
    const { manufacturer } = await PushData.getDeviceManufacturer();
    const id = classifyVendor(manufacturer)?.id;
    vendorName.value = id ? VENDOR_NAMES[id] : null;
  } catch (e) {
    console.warn("[battery-hint] vendor detection failed:", e);
  }
  writeBatteryHintLastShownAt(now);
  visible.value = true;
};

watch(
  () => authStore.isAuthenticated && authStore.matrixReady,
  (ready) => {
    if (ready) void evaluate();
    else {
      // Signed out: the next sign-in asks again (still at most every 30 days).
      checkedThisSession = false;
      visible.value = false;
    }
  },
  { immediate: true },
);

const allow = async () => {
  visible.value = false;
  try {
    await PushData.requestIgnoreBatteryOptimizations();
  } catch (e) {
    console.warn("[battery-hint] could not open the battery dialog:", e);
  }
};

const later = () => {
  visible.value = false;
};
</script>

<template>
  <div
    v-if="visible"
    data-testid="battery-hint"
    class="mx-3 mt-2 rounded-xl border border-neutral-grad-0 bg-background-secondary-theme p-3 text-text-color shadow-md"
  >
    <p class="text-sm font-semibold">{{ t("batteryHint.title") }}</p>
    <p class="mt-1 text-xs leading-snug">{{ t("batteryHint.text") }}</p>
    <p v-if="vendorName" data-testid="battery-hint-vendor" class="mt-1 text-xs leading-snug opacity-80">
      {{ t("batteryHint.vendorAutostart", { vendor: vendorName }) }}
    </p>
    <div class="mt-2 flex justify-end gap-2">
      <button
        type="button"
        data-testid="battery-hint-later"
        class="rounded-lg px-3 py-1.5 text-xs font-medium text-text-color transition-opacity hover:opacity-80"
        @click="later"
      >
        {{ t("batteryHint.later") }}
      </button>
      <button
        type="button"
        data-testid="battery-hint-allow"
        class="rounded-lg bg-color-bg-ac px-3 py-1.5 text-xs font-medium text-text-on-bg-ac-color transition-opacity hover:opacity-90"
        @click="allow"
      >
        {{ t("batteryHint.allow") }}
      </button>
    </div>
  </div>
</template>
