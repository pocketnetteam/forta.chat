<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useLocalAiStore, downloadErrorMessage, downloadPhaseLabel } from "@/entities/local-ai";
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
/** What's actually happening right now, in words — download/verify/load
 *  are three genuinely different phases (see `downloadPhaseLabel`'s own
 *  doc comment for why this matters: showing "Скачивание… 100%" through
 *  all of them read as a hang once verification/loading a GB-scale file
 *  took real, invisible time). */
const phaseLabel = computed(() => downloadPhaseLabel(t, downloadState.value.progress, localAiStore.isPaused));
/** Pausing only means anything while bytes are actually still in flight —
 *  verification (local hashing) and loading (into the LLM runtime) don't
 *  go through the download transport at all, so "Пауза" during either
 *  would be a confusing no-op. */
const canPause = computed(() => {
  const status = downloadState.value.progress?.status;
  return status === "pending" || status === "downloading";
});
/** A previous download was interrupted before finishing — real bytes to
 *  resume, not just "never started". `0%` isn't shown as a resume (nothing
 *  meaningful to distinguish from a fresh download yet). */
const resumePercent = computed(() => {
  const p = localAiStore.partialDownload?.percent ?? 0;
  return p > 0 ? p : null;
});
/** Translated, human-readable text for `downloadState.error` — never the
 *  raw exception message (e.g. "download of model__x__v1.gguf failed after
 *  5 attempts: ..."), see `downloadErrorMessage`'s own doc comment. */
const downloadErrorText = computed(() =>
  downloadState.value.error ? downloadErrorMessage(t, downloadState.value.errorCode) : null,
);

onMounted(async () => {
  await localAiStore.checkSupportOnce();
  const address = authStore.address;
  if (!address || !isSupported.value) return;
  // Refresh before checking eligibility, not after — checkEligibility() only
  // ever reads whatever manifest is already cached, so without this the
  // eligibility badge flashed "Не удалось определить..." on every first-ever
  // mount (no manifest cached yet) even on devices with a fine connection.
  // Matches LocalAiSettingsSection.vue's onMounted, which already did this.
  await localAiStore.refreshManifest(address).catch(() => {});
  await localAiStore.checkEligibility(address).catch(() => {});
  // Silently re-verify an already-downloaded model on a fresh session — see
  // `restoreModelIfPreviouslyDownloaded`'s doc comment. Never blocks/replaces
  // the explicit "Скачать" click for a device that hasn't downloaded before.
  await localAiStore.restoreModelIfPreviouslyDownloaded(address).catch(() => {});
  // After the restore attempt — restoreModelIfPreviouslyDownloaded() may
  // have just finished the model, in which case there's nothing partial left
  // to report. "докачать модель (X%)" instead of "Скачать модель" (roadmap:
  // this was a real complaint — resume happens correctly but was invisible,
  // read like every retry restarted from scratch).
  if (!localAiStore.modelReady) await localAiStore.checkPartialDownload(address).catch(() => {});
});

async function handleDownload(): Promise<void> {
  const address = authStore.address;
  if (!address) return;
  localAiStore.markDownloadStarting();
  await localAiStore.downloadModel(address).catch((e) => {
    console.warn("[AiModelGate] downloadModel failed:", e);
  });
}

async function handlePauseResume(): Promise<void> {
  const address = authStore.address;
  if (!address) return;
  if (localAiStore.isPaused) {
    await localAiStore.resumeDownload(address).catch((e: unknown) => console.warn("[AiModelGate] resumeDownload failed:", e));
  } else {
    await localAiStore.pauseDownload(address).catch((e: unknown) => console.warn("[AiModelGate] pauseDownload failed:", e));
  }
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
      <p class="text-sm text-text-on-main-bg-color">{{ phaseLabel }}</p>
      <div class="h-2 w-full max-w-xs overflow-hidden rounded-full bg-neutral-grad-0">
        <div
          class="h-full rounded-full bg-color-bg-ac transition-all duration-200"
          :class="{ 'animate-pulse': downloadState.progress?.status === 'loading' }"
          :style="{ width: `${percent}%` }"
        />
      </div>
      <button
        v-if="canPause"
        class="btn-press rounded-lg border border-color-bg-ac px-4 py-1.5 text-sm font-medium text-color-bg-ac transition-all active:scale-[0.97]"
        @click="handlePauseResume"
      >
        {{ localAiStore.isPaused ? t("ai.resume") : t("ai.pause") }}
      </button>
    </template>

    <template v-else-if="!localAiStore.modelReady">
      <p v-if="eligibility?.verdict === 'tight'" class="text-xs text-color-star-yellow">
        {{ t("ai.eligibilityTight") }}
      </p>
      <p v-else-if="eligibility?.verdict === 'unknown'" class="text-xs text-text-on-main-bg-color/60">
        {{ t("ai.eligibilityUnknown") }}
      </p>
      <p v-if="downloadErrorText" class="text-xs text-color-bad">{{ downloadErrorText }}</p>
      <p v-else-if="localAiStore.initError" class="text-xs text-color-bad">
        {{ t("ai.initError", { error: localAiStore.initError }) }}
      </p>
      <button
        class="btn-press rounded-lg bg-color-bg-ac px-4 py-2 text-sm font-medium text-white transition-all hover:bg-color-bg-ac/90 active:scale-[0.97]"
        @click="handleDownload"
      >
        {{ resumePercent !== null ? t("ai.resumeDownload", { percent: resumePercent }) : t("ai.download") }}
      </button>
    </template>
  </div>
</template>
