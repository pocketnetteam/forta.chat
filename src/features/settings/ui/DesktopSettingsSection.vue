<script setup lang="ts">
import { SettingsSection } from "@/shared/ui/settings-section";
import { Toggle } from "@/shared/ui/toggle";
import { useDesktopSettings } from "../model/use-desktop-settings";
import { useAutoUpdate } from "../model/use-auto-update";

const { t } = useI18n();
const {
  isAvailable,
  closeToTray,
  openAtLogin,
  setCloseToTray,
  setOpenAtLogin,
} = useDesktopSettings();

const {
  isAvailable: updateAvailable,
  enabled: updateEnabled,
  status: updateStatus,
  version: updateVersion,
  percent: updatePercent,
  error: updateError,
  isBusy: updateBusy,
  canInstall,
  checkForUpdates,
  quitAndInstall,
} = useAutoUpdate();

const updateStatusText = computed(() => {
  switch (updateStatus.value) {
    case "checking":
      return t("desktopSettings.updateChecking");
    case "available":
      return t("desktopSettings.updateAvailable", {
        version: updateVersion.value ?? "",
      });
    case "not-available":
      return updateVersion.value
        ? t("desktopSettings.updateUpToDate", { version: updateVersion.value })
        : t("desktopSettings.updateIdle");
    case "downloading":
      return t("desktopSettings.updateDownloading", {
        percent: Math.round(updatePercent.value ?? 0),
      });
    case "downloaded":
      return t("desktopSettings.updateReady", {
        version: updateVersion.value ?? "",
      });
    case "error":
      return t("desktopSettings.updateError", {
        message: updateError.value ?? "",
      });
    default:
      return t("desktopSettings.updateIdle");
  }
});
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

    <SettingsSection
      v-if="updateAvailable"
      :title="t('desktopSettings.updates')"
      :description="t('desktopSettings.updatesDesc')"
    >
      <div class="space-y-3 rounded-xl bg-background-secondary-theme px-4 py-3">
        <p class="text-sm text-text-color">
          {{ updateStatusText }}
        </p>
        <p
          v-if="!updateEnabled"
          class="text-xs text-text-on-main-bg-color"
        >
          {{ t('desktopSettings.updateDisabledHint') }}
        </p>
        <div class="flex flex-wrap gap-2">
          <button
            type="button"
            class="rounded-lg bg-color-bg-ac px-4 py-2 text-sm font-medium text-text-on-bg-ac-color transition-colors hover:bg-color-bg-ac-1 disabled:pointer-events-none disabled:opacity-50"
            :disabled="!updateEnabled || updateBusy"
            @click="checkForUpdates"
          >
            {{ t('desktopSettings.checkForUpdates') }}
          </button>
          <button
            v-if="canInstall"
            type="button"
            class="rounded-lg bg-color-bg-ac px-4 py-2 text-sm font-medium text-text-on-bg-ac-color transition-colors hover:bg-color-bg-ac-1"
            @click="quitAndInstall"
          >
            {{ t('desktopSettings.restartAndInstall') }}
          </button>
        </div>
      </div>
    </SettingsSection>

    <p class="text-xs text-text-on-main-bg-color">
      {{ t('desktopSettings.zoomHint') }}
    </p>
  </div>
</template>
