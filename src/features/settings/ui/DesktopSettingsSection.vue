<script setup lang="ts">
import { SettingsSection } from "@/shared/ui/settings-section";
import { Toggle } from "@/shared/ui/toggle";
import { useDesktopSettings } from "../model/use-desktop-settings";

const { t } = useI18n();
const {
  isAvailable,
  closeToTray,
  openAtLogin,
  setCloseToTray,
  setOpenAtLogin,
} = useDesktopSettings();
</script>

<template>
  <div v-if="isAvailable" class="mx-auto max-w-2xl space-y-6 p-6 pb-safe">
    <SettingsSection
      :title="t('desktopSettings.closeToTray')"
      :description="t('desktopSettings.closeToTrayDesc')"
    >
      <div class="flex items-center justify-between gap-4 rounded-xl bg-background-secondary-theme px-4 py-3">
        <p class="text-sm text-text-color">{{ t('desktopSettings.closeToTray') }}</p>
        <Toggle
          :model-value="closeToTray"
          @update:model-value="setCloseToTray"
        />
      </div>
    </SettingsSection>

    <SettingsSection
      :title="t('desktopSettings.openAtLogin')"
      :description="t('desktopSettings.openAtLoginDesc')"
    >
      <div class="flex items-center justify-between gap-4 rounded-xl bg-background-secondary-theme px-4 py-3">
        <p class="text-sm text-text-color">{{ t('desktopSettings.openAtLogin') }}</p>
        <Toggle
          :model-value="openAtLogin"
          @update:model-value="setOpenAtLogin"
        />
      </div>
    </SettingsSection>

    <p class="text-xs text-text-on-main-bg-color">
      {{ t('desktopSettings.zoomHint') }}
    </p>
  </div>
</template>
