<script setup lang="ts">
import { onMounted } from "vue";
import { SettingsSection } from "@/shared/ui/settings-section";
import { isNative } from "@/shared/lib/platform";
import { useNotificationSettings } from "../model/use-notification-settings";

/**
 * Notification settings (WEE-75 / forta-bugs#942).
 *
 * Message notifications now ship with an explicit sound on a fresh channel
 * (see MessageNotificationConfig on the native side). The per-channel
 * sound/vibration toggles are owned by the OS on Android O+, so this screen
 * deep-links into the system notification settings rather than faking an
 * in-app toggle that can't actually change the immutable channel. For
 * aggressive OEMs (Xiaomi/MIUI, Samsung, …) we add a targeted hint.
 */
const { t } = useI18n();
const {
  canOpenSystemSettings,
  vendorGuidanceId,
  openSystemNotificationSettings,
  detectVendor,
} = useNotificationSettings();

onMounted(detectVendor);
</script>

<template>
  <div class="mx-auto max-w-2xl space-y-6 p-6 pb-safe">
    <!-- What changed -->
    <SettingsSection
      :title="t('notificationsSettings.soundTitle')"
      :description="t('notificationsSettings.soundDesc')"
    >
      <div class="flex items-start gap-3 rounded-xl bg-background-secondary-theme p-4">
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="mt-0.5 shrink-0 text-color-bg-ac"
        >
          <path d="M11 5 6 9H2v6h4l5 4z" />
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
          <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
        </svg>
        <p class="text-sm text-text-color">{{ t("notificationsSettings.soundOnHint") }}</p>
      </div>
    </SettingsSection>

    <!-- Manage in system settings (native Android) -->
    <SettingsSection
      v-if="canOpenSystemSettings"
      :title="t('notificationsSettings.manageTitle')"
      :description="t('notificationsSettings.manageDesc')"
    >
      <button
        class="flex w-full items-center gap-3 rounded-xl border border-neutral-grad-0 px-4 py-3 text-left transition-colors hover:bg-neutral-grad-0"
        @click="openSystemNotificationSettings"
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="shrink-0 text-text-on-main-bg-color"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
        <span class="flex-1 text-sm font-medium text-text-color">
          {{ t("notificationsSettings.openSystem") }}
        </span>
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          class="shrink-0 text-text-on-main-bg-color"
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>
    </SettingsSection>

    <!-- Aggressive-OEM guidance (Xiaomi/MIUI & friends) -->
    <SettingsSection
      v-if="vendorGuidanceId"
      :title="t('notificationsSettings.vendorTitle')"
    >
      <div class="space-y-3 rounded-xl border border-color-star-yellow/30 bg-color-star-yellow/5 p-4">
        <div class="flex items-start gap-3">
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="mt-0.5 shrink-0 text-color-star-yellow"
          >
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <p class="text-sm text-text-color">{{ t("notificationsSettings.vendorHint") }}</p>
        </div>
        <button
          v-if="canOpenSystemSettings"
          class="w-full rounded-lg bg-color-bg-ac px-4 py-2.5 text-sm font-medium text-text-on-bg-ac-color transition-opacity hover:opacity-90"
          @click="openSystemNotificationSettings"
        >
          {{ t("notificationsSettings.openSystem") }}
        </button>
      </div>
    </SettingsSection>

    <!-- Non-native fallback note -->
    <p v-if="!isNative" class="text-center text-xs text-text-on-main-bg-color">
      {{ t("notificationsSettings.webNote") }}
    </p>
  </div>
</template>
