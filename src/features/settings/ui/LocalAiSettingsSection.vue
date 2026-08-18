<script setup lang="ts">
/** Settings → Local AI (roadmap 6.3) — model info, eligibility badge,
 *  download/update, "check for updates". Same `useLocalAiStore` state as
 *  `AiModelGate.vue` inside an open AI chat — one progress bar, two
 *  renderers, never two `onProgress` subscriptions (plan §8 p.4). No
 *  "Delete model" control in v1 — see docs/plans/llama2/decisions.md
 *  "Фаза 6.5", `LocalAiClient` has no public "delete file only" API. */
import { computed, onMounted, ref } from "vue";
import { useLocalAiStore } from "@/entities/local-ai";
import { useAuthStore } from "@/entities/auth";
import { useTorStore } from "@/entities/tor";
import { formatBytes } from "@/entities/tor/lib/format-bytes";
import { SettingsSection } from "@/shared/ui/settings-section";

const localAiStore = useLocalAiStore();
const authStore = useAuthStore();
const torStore = useTorStore();
const { t } = useI18n();

// roadmap 7.3 — @capgo/capacitor-downloader's Android implementation is
// built on android.app.DownloadManager (system service, outside the app
// process), which never routes through tor-service.ts's local proxy — the
// model download always bypasses Tor, even in 'always' mode. Surfaced here
// rather than fixed (DownloadManager has no arbitrary-proxy support without
// an OS-level VPN service — a separate, larger task).
const downloadBypassesTor = computed(() => torStore.mode === "always");

const supportReport = computed(() => localAiStore.supportReport);
const eligibility = computed(() => localAiStore.eligibilityReport);
const model = computed(() => localAiStore.currentModel);
const downloadState = computed(() => localAiStore.downloadState.model);
const percent = computed(() => Math.round(downloadState.value.progress?.percent ?? 0));
const isDownloading = computed(() => downloadState.value.progress !== null);

const isCheckingUpdates = ref(false);

// Same eligibility-badge pattern as `torStatusInfo` in SettingsPanel.vue
// (plan §8 p.2): color + short text, hidden entirely when 'ok'.
const eligibilityBadge = computed(() => {
  switch (eligibility.value?.verdict) {
    case "tight": return { text: t("ai.eligibilityTight"), color: "text-color-star-yellow" };
    case "no": return { text: t("ai.eligibilityBlocked"), color: "text-color-bad" };
    case "unknown": return { text: t("ai.eligibilityUnknown"), color: "text-text-on-main-bg-color" };
    default: return null;
  }
});

const statusLabel = computed(() => {
  if (isDownloading.value) return t("ai.downloading", { percent: percent.value });
  if (!localAiStore.modelReady) return t("ai.notDownloaded");
  return t("ai.ready");
});

onMounted(async () => {
  await localAiStore.checkSupportOnce();
  const address = authStore.address;
  if (!address || supportReport.value?.capabilities.inference === false) return;
  await localAiStore.refreshManifest(address).catch(() => {});
  await localAiStore.checkEligibility(address).catch(() => {});
  // Silently re-verify an already-downloaded model on a fresh session — see
  // `restoreModelIfPreviouslyDownloaded`'s doc comment. Never blocks/replaces
  // the explicit "Скачать" click for a device that hasn't downloaded before.
  await localAiStore.restoreModelIfPreviouslyDownloaded(address).catch(() => {});
});

async function handleDownload(): Promise<void> {
  const address = authStore.address;
  if (!address) return;
  await localAiStore.downloadModel(address).catch((e) => {
    console.warn("[LocalAiSettingsSection] downloadModel failed:", e);
  });
}

async function handleUpdate(): Promise<void> {
  const address = authStore.address;
  if (!address) return;
  await localAiStore.switchModel(address).catch((e) => {
    console.warn("[LocalAiSettingsSection] switchModel failed:", e);
  });
}

async function handleCheckUpdates(): Promise<void> {
  const address = authStore.address;
  if (!address || isCheckingUpdates.value) return;
  isCheckingUpdates.value = true;
  try {
    await localAiStore.refreshManifest(address);
    await localAiStore.checkEligibility(address);
  } catch (e) {
    console.warn("[LocalAiSettingsSection] refreshManifest failed:", e);
  } finally {
    isCheckingUpdates.value = false;
  }
}
</script>

<template>
  <div class="space-y-6 p-4">
    <p class="text-sm text-text-on-main-bg-color">{{ t("ai.settingsDescription") }}</p>

    <SettingsSection :title="t('ai.settingsTitle')">
      <div v-if="supportReport && !supportReport.capabilities.inference" class="rounded-lg bg-color-bad/10 px-3 py-2.5 text-sm text-color-bad">
        {{ t("ai.unsupported") }}
      </div>

      <template v-else>
        <!-- Model info -->
        <div class="space-y-0.5 rounded-xl bg-background-secondary-theme">
          <div class="flex items-center justify-between px-4 py-3">
            <span class="text-sm text-text-on-main-bg-color">{{ t("ai.settingsTitle") }}</span>
            <span class="text-sm font-medium text-text-color">
              {{ model ? `${model.displayName} · ${model.quant}` : "—" }}
            </span>
          </div>
          <div class="mx-4 border-t border-neutral-grad-0" />
          <div class="flex items-center justify-between px-4 py-3">
            <span class="text-sm text-text-on-main-bg-color">{{ t("ai.modelSize") }}</span>
            <span class="font-mono text-sm font-medium text-text-color">
              {{ model ? formatBytes(model.sizeBytes) : "—" }}
            </span>
          </div>
          <div class="mx-4 border-t border-neutral-grad-0" />
          <div class="flex items-center justify-between px-4 py-3">
            <span class="text-sm text-text-on-main-bg-color">{{ t("ai.status") }}</span>
            <span
              class="flex items-center gap-1.5 text-sm"
              :class="eligibilityBadge?.color ?? 'text-text-color'"
            >{{ eligibilityBadge?.text ?? statusLabel }}</span>
          </div>
        </div>

        <!-- Progress bar — same downloadState as AiModelGate.vue -->
        <div v-if="isDownloading" class="mt-3">
          <p class="mb-1.5 text-sm text-text-on-main-bg-color">{{ t("ai.downloading", { percent }) }}</p>
          <div class="h-2 w-full overflow-hidden rounded-full bg-neutral-grad-0">
            <div class="h-full rounded-full bg-color-bg-ac transition-all duration-200" :style="{ width: `${percent}%` }" />
          </div>
        </div>

        <p v-if="downloadState.error" class="mt-2 text-xs text-color-bad">{{ downloadState.error }}</p>
        <p v-else-if="localAiStore.initError" class="mt-2 text-xs text-color-bad">
          {{ t("ai.initError", { error: localAiStore.initError }) }}
        </p>
        <p v-if="downloadBypassesTor && !localAiStore.modelReady" class="mt-2 text-xs text-color-star-yellow">
          {{ t("ai.downloadBypassesTor") }}
        </p>

        <!-- Actions -->
        <div v-if="!isDownloading" class="mt-3 flex flex-wrap gap-2">
          <button
            v-if="!localAiStore.modelReady"
            class="rounded-lg bg-color-bg-ac px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-color-bg-ac/90"
            :disabled="eligibility?.verdict === 'no'"
            @click="handleDownload"
          >
            {{ t("ai.download") }}
          </button>
          <button
            v-else
            class="rounded-lg bg-color-bg-ac px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-color-bg-ac/90"
            @click="handleUpdate"
          >
            {{ t("ai.update") }}
          </button>
          <button
            class="rounded-lg border border-neutral-grad-0 px-4 py-2 text-sm font-medium text-text-color transition-colors hover:bg-neutral-grad-0"
            :disabled="isCheckingUpdates"
            @click="handleCheckUpdates"
          >
            {{ isCheckingUpdates ? t("ai.checkingUpdates") : t("ai.checkUpdates") }}
          </button>
        </div>
      </template>
    </SettingsSection>
  </div>
</template>
