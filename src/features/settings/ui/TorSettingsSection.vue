<script setup lang="ts">
import type { TorMode } from "@/entities/tor";
import { useTorStore } from "@/entities/tor";
import { formatBytes } from "@/entities/tor/lib/format-bytes";
import { SettingsSection } from "@/shared/ui/settings-section";
import { Toggle } from "@/shared/ui/toggle";
import { isNative } from "@/shared/lib/platform";

const { t } = useI18n();
const torStore = useTorStore();

const showDisableWarning = ref(false);
const pendingMode = ref<TorMode | null>(null);

const MODES = [
  { value: "neveruse", labelKey: "tor.modeNever", hintKey: "tor.modeNeverHint" },
  { value: "auto", labelKey: "tor.modeAuto", hintKey: "tor.modeAutoHint" },
  { value: "always", labelKey: "tor.modeAlways", hintKey: "tor.modeAlwaysHint" },
] as const;

const activeModeHint = computed(() => {
  const entry = MODES.find((m) => m.value === torStore.mode);
  return entry ? t(entry.hintKey) : "";
});

const statusDisplay = computed(() => {
  switch (torStore.hintState) {
    case "off":
      return { text: t("tor.off"), color: "text-text-on-main-bg-color", pulse: false };
    case "loading":
      if (torStore.isVerifying) {
        return { text: t("tor.verifying"), color: "text-text-on-main-bg-color", pulse: true };
      }
      if (torStore.info) {
        return { text: torStore.info, color: "text-color-star-yellow", pulse: true };
      }
      return { text: t("tor.connecting"), color: "text-color-star-yellow", pulse: true };
    case "failed":
      return { text: t("tor.error"), color: "text-color-bad", pulse: false };
    case "on": {
      const r = torStore.verifyResult;
      if (isNative && r?.isTor) {
        return { text: r.ip, color: "text-color-good", pulse: false };
      }
      if (isNative && r && !r.isTor) {
        return { text: t("tor.notUsingTor"), color: "text-color-bad", pulse: false };
      }
      return { text: t("tor.connected"), color: "text-color-good", pulse: false };
    }
    default:
      return null;
  }
});

const handleModeSelect = (newMode: TorMode) => {
  if (newMode === torStore.mode) return;

  if (newMode === "neveruse" && torStore.isEnabled) {
    pendingMode.value = newMode;
    showDisableWarning.value = true;
    return;
  }

  torStore.setMode(newMode);
};

const confirmDisableTor = () => {
  showDisableWarning.value = false;
  if (pendingMode.value) {
    torStore.setMode(pendingMode.value);
    pendingMode.value = null;
  } else {
    torStore.setMode("neveruse");
  }
};

const cancelDisableTor = () => {
  showDisableWarning.value = false;
  pendingMode.value = null;
};
const handleSnowflakeToggle = (enabled: boolean) => {
  torStore.setBridgeType(enabled ? "snowflake" : "none");
};
</script>

<template>
  <div class="mx-auto max-w-2xl space-y-6 p-6 pb-safe">
    <!-- Tor mode -->
    <SettingsSection
      :title="t('tor.useTor')"
      :description="activeModeHint"
    >
      <div class="flex rounded-lg bg-background-secondary-theme p-1">
        <button
          v-for="m in MODES"
          :key="m.value"
          class="flex-1 rounded-md px-2 py-2.5 text-sm font-medium transition-all"
          :class="torStore.mode === m.value
            ? 'bg-color-bg-ac text-text-on-bg-ac-color shadow-sm'
            : 'text-text-on-main-bg-color hover:text-text-color'"
          @click="handleModeSelect(m.value)"
        >
          {{ t(m.labelKey) }}
        </button>
      </div>
    </SettingsSection>

    <!-- Snowflake bridge -->
    <SettingsSection
      v-if="torStore.isEnabled"
      :title="t('tor.useSnowflake')"
      :description="t('tor.useSnowflakeHint')"
    >
      <div class="flex items-center justify-between rounded-xl bg-background-secondary-theme px-4 py-3">
        <span class="text-sm text-text-color">{{ t("tor.useSnowflake") }}</span>
        <Toggle
          :model-value="torStore.isSnowflakeEnabled"
          @update:model-value="handleSnowflakeToggle"
        />
      </div>
    </SettingsSection>

    <!-- Status -->
    <SettingsSection
      v-if="torStore.isEnabled"
      :title="t('tor.status')"
      :description="t('tor.statusHint')"
    >
      <div class="rounded-xl bg-background-secondary-theme px-4 py-3">
        <div class="flex items-center justify-between gap-3">
          <div class="min-w-0 flex-1">
            <p
              v-if="statusDisplay"
              class="truncate text-sm font-medium"
              :class="[statusDisplay.color, statusDisplay.pulse ? 'animate-pulse' : '']"
            >
              {{ statusDisplay.text }}
            </p>
            <p v-else class="text-sm text-text-on-main-bg-color">{{ t("tor.off") }}</p>
          </div>

          <button
            v-if="isNative && torStore.isConnected"
            class="shrink-0 rounded-lg border border-neutral-grad-0 px-3 py-1.5 text-xs font-medium text-text-color transition-colors hover:bg-neutral-grad-0"
            :disabled="torStore.isVerifying"
            @click="torStore.verify()"
          >
            {{ torStore.isVerifying ? t("tor.verifying") : t("tor.verify") }}
          </button>
        </div>
      </div>
    </SettingsSection>

    <!-- Network statistics -->
    <SettingsSection
      :title="t('tor.stats')"
      :description="t('tor.statsHint')"
    >
      <div class="grid grid-cols-2 gap-3">
        <div class="rounded-xl bg-background-secondary-theme px-4 py-3">
          <p class="text-xs text-text-on-main-bg-color">{{ t("tor.statCurrentDirect") }}</p>
          <p class="mt-1 text-sm font-semibold text-text-color">
            {{ formatBytes(torStore.networkStats.directBytes) }}
          </p>
        </div>
        <div class="rounded-xl bg-background-secondary-theme px-4 py-3">
          <p class="text-xs text-text-on-main-bg-color">{{ t("tor.statCurrentTor") }}</p>
          <p class="mt-1 text-sm font-semibold text-color-good">
            {{ formatBytes(torStore.networkStats.torBytes) }}
          </p>
        </div>
        <div class="rounded-xl bg-background-secondary-theme px-4 py-3">
          <p class="text-xs text-text-on-main-bg-color">{{ t("tor.statTotalDirect") }}</p>
          <p class="mt-1 text-sm font-semibold text-text-color">
            {{ formatBytes(torStore.networkStats.totalDirectBytes) }}
          </p>
        </div>
        <div class="rounded-xl bg-background-secondary-theme px-4 py-3">
          <p class="text-xs text-text-on-main-bg-color">{{ t("tor.statTotalTor") }}</p>
          <p class="mt-1 text-sm font-semibold text-color-good">
            {{ formatBytes(torStore.networkStats.totalTorBytes) }}
          </p>
        </div>
      </div>
    </SettingsSection>
  </div>

  <!-- Disable confirm -->
  <Teleport to="body">
    <div
      v-if="showDisableWarning"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      @click.self="cancelDisableTor()"
    >
      <div class="mx-4 max-w-sm rounded-xl bg-background-secondary-theme p-6 shadow-xl">
        <p class="mb-4 text-sm text-text-color">
          {{ t("tor.disableWarning") }}
        </p>
        <div class="flex justify-end gap-3">
          <button
            class="rounded-lg px-4 py-2 text-sm text-text-on-main-bg-color transition-colors hover:bg-neutral-grad-0"
            @click="cancelDisableTor()"
          >
            {{ t("common.cancel") }}
          </button>
          <button
            class="rounded-lg bg-color-bad px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-80"
            @click="confirmDisableTor()"
          >
            {{ t("tor.modeNever") }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
