<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useLocalAiStore } from "@/entities/local-ai";
import { useAuthStore } from "@/entities/auth";

/**
 * Shared "model not ready" widget (roadmap 5.1) — three states: not
 * downloaded (button + description), downloading (progress bar),
 * eligibility-blocked (red, no "download anyway" — `eligibilityPolicy`
 * default is `no: 'block'`, plan §9 item 5, not bypassed here). Reused by
 * both `AiChatView.vue` (in-chat banner) and `LocalAiSettingsSection.vue`
 * (Settings → Local AI) — one `useLocalAiStore()`, one `downloadState`, no
 * duplicated `onProgress` subscriptions (plan §8 p.4).
 */
const localAiStore = useLocalAiStore();
const authStore = useAuthStore();
const { t } = useI18n();

const supportReport = computed(() => localAiStore.supportReport);
const eligibility = computed(() => localAiStore.eligibilityReport);
const downloadState = computed(() => localAiStore.downloadState.model);
const percent = computed(() => Math.round(downloadState.value.progress?.percent ?? 0));

const isSupported = computed(() => supportReport.value?.capabilities.inference !== false);
const isBlocked = computed(() => eligibility.value?.verdict === "no");
const isDownloading = computed(() => downloadState.value.progress !== null);

onMounted(async () => {
  await localAiStore.checkSupportOnce();
  const address = authStore.address;
  if (!address || !isSupported.value) return;
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
    console.warn("[AiModelGate] downloadModel failed:", e);
  });
}
</script>

<template>
  <div class="flex flex-col items-center gap-3 px-6 py-8 text-center">
    <!-- checkSupport() failed on a native build (e.g. forgot `cap sync`) -->
    <template v-if="!isSupported">
      <p class="text-sm text-text-on-main-bg-color">{{ t("ai.unsupported") }}</p>
    </template>

    <!-- Eligibility policy default: no -> block. Never a "download anyway" -->
    <template v-else-if="isBlocked">
      <p class="text-sm text-color-bad">{{ t("ai.eligibilityBlocked") }}</p>
    </template>

    <template v-else-if="isDownloading">
      <p class="text-sm text-text-on-main-bg-color">{{ t("ai.downloading", { percent }) }}</p>
      <div class="h-2 w-full max-w-xs overflow-hidden rounded-full bg-neutral-grad-0">
        <div
          class="h-full rounded-full bg-color-bg-ac transition-all duration-200"
          :style="{ width: `${percent}%` }"
        />
      </div>
    </template>

    <template v-else-if="!localAiStore.modelReady">
      <p v-if="eligibility?.verdict === 'tight'" class="text-xs text-color-star-yellow">
        {{ t("ai.eligibilityTight") }}
      </p>
      <p v-else-if="eligibility?.verdict === 'unknown'" class="text-xs text-text-on-main-bg-color/60">
        {{ t("ai.eligibilityUnknown") }}
      </p>
      <p v-if="downloadState.error" class="text-xs text-color-bad">{{ downloadState.error }}</p>
      <button
        class="rounded-lg bg-color-bg-ac px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-color-bg-ac/90"
        @click="handleDownload"
      >
        {{ t("ai.download") }}
      </button>
    </template>
  </div>
</template>
