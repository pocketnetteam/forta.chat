<script setup lang="ts">
/** Settings → Local AI (roadmap 6.3) — model info, eligibility badge,
 *  download/update, "check for updates", pause/resume, delete. Same
 *  `useLocalAiStore` state as `AiModelGate.vue` inside an open AI chat —
 *  one progress bar, two renderers, never two `onProgress` subscriptions
 *  (plan §8 p.4). */
import { computed, onMounted, ref } from "vue";
import type { ModelArtifact } from "local-ai";
import { useLocalAiStore, downloadErrorMessage, downloadPhaseLabel, type EligibilityReport } from "@/entities/local-ai";
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
const models = computed(() => localAiStore.availableModels);
/** Per-model eligibility badges (multi-model plan §9) — populated by
 *  {@link refreshModelEligibility}, one entry per {@link models} row.
 *  `null` means the check itself failed (readable as "unknown" in
 *  {@link modelBadge}); a key simply absent means it hasn't been checked
 *  yet this mount. */
const modelEligibilityMap = ref<Record<string, EligibilityReport | null>>({});
const downloadState = computed(() => localAiStore.downloadState.model);
const percent = computed(() => Math.round(downloadState.value.progress?.percent ?? 0));
const isDownloading = computed(() => downloadState.value.progress !== null);
/** A previous download was interrupted before finishing — real bytes to
 *  resume, not just "never started". `0%` isn't shown as a resume (nothing
 *  meaningful to distinguish from a fresh download yet). */
const resumePercent = computed(() => {
  const p = localAiStore.partialDownload?.percent ?? 0;
  return p > 0 ? p : null;
});
/** Translated, human-readable text for `downloadState.error` — never the
 *  raw exception message (e.g. "download of model__x__v1.gguf failed after
 *  5 attempts: ..."), see `downloadErrorMessage`'s own doc comment.
 *  Suppressed once the model is actually ready: observed live
 *  (2026-08-19) that a concurrent downloadModel() call — the automatic
 *  background restore check racing an explicit user tap — can leave a
 *  stale error sitting in the store even after a DIFFERENT call already
 *  reached ready. Showing "download failed" right next to a fully
 *  populated, working model card is confusing regardless of root cause;
 *  "the model is ready" is the fact that actually matters to the user. */
const downloadErrorText = computed(() =>
  !localAiStore.modelReady && downloadState.value.error ? downloadErrorMessage(t, downloadState.value.errorCode) : null,
);
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

const isCheckingUpdates = ref(false);
const isDeleting = ref(false);
const showDeleteConfirm = ref(false);
/** An active, un-paused transfer — the one state where Delete must stay
 *  hidden entirely (not just disabled): showing a "delete the downloaded
 *  model" button while bytes are still actively streaming in is confusing
 *  (nothing is "downloaded" yet, and its own confirm text would be wrong —
 *  see `isModelFullyInstalled`/`deleteLabel` below), and the same
 *  affordance is one tap away via Pause → Delete anyway. */
const isActivelyDownloading = computed(() => isDownloading.value && !localAiStore.isPaused);
/** Anything on disk (or in the registry) worth offering to delete — a
 *  completed model, a paused download (real partial bytes), a failed one
 *  (ditto — DownloadEngine only deletes the file itself on a checksum
 *  mismatch, not a network failure), or an interrupted download from a
 *  previous session that hasn't been resumed yet. Hidden on a genuinely
 *  fresh device where there's nothing to clean up, and while actively
 *  downloading (see `isActivelyDownloading`). */
const canDelete = computed(
  () =>
    !isActivelyDownloading.value &&
    (localAiStore.modelReady || isDownloading.value || resumePercent.value !== null || downloadState.value.error !== null),
);
/** Whether there's a genuinely complete, installed model — as opposed to
 *  only a partial/paused/failed download. Drives which pair of
 *  delete/confirm strings is shown: "Удалить модель" ("delete the
 *  downloaded model") is simply false advertising for a download that
 *  never finished — `ai.discardDownload` says what's actually happening
 *  in that case. */
const isModelFullyInstalled = computed(() => localAiStore.modelReady);

/** Whether `modelId` is the one actually loaded in the runtime right now —
 *  at most one row can be (multi-model plan §2: one model on disk at a
 *  time). Deliberately `loadedModelId`, not `currentModel`/`selectedModelId`
 *  — those flip to a new choice the instant `selectModel()` resolves,
 *  before anything has actually downloaded/loaded; using them here would
 *  show the new (not-yet-ready) row as "Активна" and the still-genuinely-
 *  loaded old row as "not downloaded" for the whole switch window, and
 *  permanently if the switch then fails (code review finding). */
function isModelActive(modelId: string): boolean {
  return localAiStore.loadedModelId === modelId;
}

/** Only ever true for the selected model's row — `downloadState.model`
 *  (and its progress bar below) always tracks whatever `ensureModelReady()`/
 *  `switchModel()` is currently acting on, which is always the selection. */
function isRowDownloading(modelId: string): boolean {
  return isDownloading.value && localAiStore.currentModel?.id === modelId;
}

// Same eligibility-badge pattern as `torStatusInfo` in SettingsPanel.vue
// (plan §8 p.2), now per-model-row (plan §9): color + short text, hidden
// entirely when 'ok'.
function modelBadge(modelId: string): { text: string; color: string } | null {
  switch (modelEligibilityMap.value[modelId]?.verdict) {
    case "tight": return { text: t("ai.eligibilityTight"), color: "text-color-star-yellow" };
    case "no": return { text: t("ai.eligibilityBlocked"), color: "text-color-bad" };
    case "unknown": return { text: t("ai.eligibilityUnknown"), color: "text-text-on-main-bg-color" };
    default: return null;
  }
}

function rowStatusLabel(modelId: string): string {
  if (isRowDownloading(modelId)) return phaseLabel.value;
  if (isModelActive(modelId)) return t("ai.active");
  return t("ai.notDownloaded");
}

/** Action-button label for a not-yet-active row — "Скачать" for a
 *  genuinely fresh device, "Докачать (X%)" if this is the selected model
 *  and there's a real interrupted download to resume, or "Скачать и
 *  переключиться" when a *different* model is already installed (plan §9:
 *  selectModel() + downloadModel() as one user action — `downloadModel()`
 *  itself already resolves/switches to whatever's now selected, see
 *  `LocalAiClient.ensureModelReady()`'s own doc comment). */
function downloadLabel(modelId: string): string {
  if (resumePercent.value !== null && modelId === localAiStore.currentModel?.id) {
    return t("ai.resumeDownload", { percent: resumePercent.value });
  }
  return localAiStore.modelReady ? t("ai.downloadAndSwitch") : t("ai.download");
}

/** Runs `modelEligibility()` for every row in {@link models} — called on
 *  mount and after every manifest refresh (plan §9); cached per-modelId by
 *  the store itself (`modelEligibilityCache`), so re-running this after a
 *  `selectModel()` call (which doesn't change the manifest) is cheap. */
async function refreshModelEligibility(): Promise<void> {
  const address = authStore.address;
  if (!address) return;
  await Promise.all(
    models.value.map(async (m: ModelArtifact) => {
      modelEligibilityMap.value[m.id] = await localAiStore.modelEligibility(address, m.id).catch(() => null);
    }),
  );
}

onMounted(async () => {
  await localAiStore.checkSupportOnce();
  const address = authStore.address;
  if (!address || supportReport.value?.capabilities.inference === false) return;
  await localAiStore.refreshManifest(address).catch(() => {});
  await refreshModelEligibility();
  // Silently re-verify an already-downloaded model on a fresh session — see
  // `restoreModelIfPreviouslyDownloaded`'s doc comment. Never blocks/replaces
  // the explicit "Скачать" click for a device that hasn't downloaded before.
  await localAiStore.restoreModelIfPreviouslyDownloaded(address).catch(() => {});
  // "докачать модель (X%)" instead of "Скачать модель" when there's a real
  // interrupted download to resume — see AiModelGate.vue's matching call.
  if (!localAiStore.modelReady) await localAiStore.checkPartialDownload(address).catch(() => {});
});

/** Downloads `modelId` — selects it first if it isn't already the current
 *  selection (plan §9's "Скачать и переключиться" — one tap, two library
 *  calls: `downloadModel()`'s `ensureModelReady()` already resolves/
 *  switches to whatever's selected on its own, so selecting first is all
 *  this needs to do differently from the single-model "Скачать" flow). */
async function handleSelectAndDownload(modelId: string): Promise<void> {
  const address = authStore.address;
  if (!address) return;
  if (localAiStore.selectedModelId !== modelId) {
    try {
      await localAiStore.selectModel(address, modelId);
    } catch (e) {
      // Surfaced the same way downloadModel()'s own failures are — a bare
      // console.warn here left the button silently reverting with zero
      // user-visible feedback (code review finding); downloadModel()'s own
      // catch below already reports through downloadState.model.error via
      // the store's applyDownloadFailure(), this mirrors that for the
      // selectModel()-specific failure window that precedes it.
      const err = e instanceof Error ? e : new Error(String(e));
      localAiStore.downloadState.model.error = err.message;
      localAiStore.downloadState.model.errorCode = null;
      console.warn("[LocalAiSettingsSection] selectModel failed:", e);
      return;
    }
  }
  localAiStore.markDownloadStarting();
  await localAiStore.downloadModel(address).catch((e: unknown) => {
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
    await refreshModelEligibility();
  } catch (e) {
    console.warn("[LocalAiSettingsSection] refreshManifest failed:", e);
  } finally {
    isCheckingUpdates.value = false;
  }
}

async function handlePauseResume(): Promise<void> {
  const address = authStore.address;
  if (!address) return;
  if (localAiStore.isPaused) {
    await localAiStore.resumeDownload(address).catch((e: unknown) => console.warn("[LocalAiSettingsSection] resumeDownload failed:", e));
  } else {
    await localAiStore.pauseDownload(address).catch((e: unknown) => console.warn("[LocalAiSettingsSection] pauseDownload failed:", e));
  }
}

async function handleDeleteConfirmed(): Promise<void> {
  const address = authStore.address;
  showDeleteConfirm.value = false;
  if (!address || isDeleting.value) return;
  isDeleting.value = true;
  try {
    await localAiStore.deleteModel(address);
  } catch (e) {
    console.warn("[LocalAiSettingsSection] deleteModel failed:", e);
  } finally {
    isDeleting.value = false;
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
        <!-- Model list — one row per available model (multi-model plan §9);
             at most one row is ever "active" (plan §2: one model on disk
             at a time). -->
        <div class="space-y-2">
          <div
            v-for="m in models"
            :key="m.id"
            class="space-y-0.5 rounded-xl bg-background-secondary-theme"
          >
            <div class="flex items-center justify-between px-4 py-3">
              <div>
                <p class="text-sm font-medium text-text-color">
                  {{ m.displayName }} · {{ m.quant }}
                  <span v-if="m.recommended" class="text-xs font-normal text-color-bg-ac">({{ t("ai.recommended") }})</span>
                </p>
                <p class="font-mono text-xs text-text-on-main-bg-color">{{ formatBytes(m.sizeBytes) }}</p>
              </div>
              <span
                class="flex items-center gap-1.5 text-sm"
                :class="modelBadge(m.id)?.color ?? 'text-text-on-main-bg-color'"
              >{{ modelBadge(m.id)?.text ?? rowStatusLabel(m.id) }}</span>
            </div>
            <div v-if="!isRowDownloading(m.id)" class="px-4 pb-3">
              <button
                v-if="isModelActive(m.id)"
                disabled
                class="btn-press w-full rounded-lg border border-color-bg-ac/40 px-4 py-1.5 text-sm font-medium text-color-bg-ac disabled:opacity-80"
              >
                {{ t("ai.active") }}
              </button>
              <button
                v-else
                class="btn-press w-full rounded-lg bg-color-bg-ac px-4 py-1.5 text-sm font-medium text-white transition-all hover:bg-color-bg-ac/90 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-60"
                :disabled="modelEligibilityMap[m.id]?.verdict === 'no' || isDownloading"
                @click="handleSelectAndDownload(m.id)"
              >
                {{ downloadLabel(m.id) }}
              </button>
            </div>
          </div>
        </div>

        <!-- Progress bar — same downloadState as AiModelGate.vue, always the
             selected model's row (see isRowDownloading) -->
        <div v-if="isDownloading" class="mt-3">
          <p class="mb-1.5 text-sm text-text-on-main-bg-color">{{ phaseLabel }}</p>
          <div class="h-2 w-full overflow-hidden rounded-full bg-neutral-grad-0">
            <div
              class="h-full rounded-full bg-color-bg-ac transition-all duration-200"
              :class="{ 'animate-pulse': downloadState.progress?.status === 'loading' }"
              :style="{ width: `${percent}%` }"
            />
          </div>
          <button
            v-if="canPause"
            class="btn-press mt-2 rounded-lg border border-color-bg-ac px-4 py-1.5 text-sm font-medium text-color-bg-ac transition-all active:scale-[0.97]"
            @click="handlePauseResume"
          >
            {{ localAiStore.isPaused ? t("ai.resume") : t("ai.pause") }}
          </button>
        </div>

        <p v-if="downloadErrorText" class="mt-2 text-xs text-color-bad">{{ downloadErrorText }}</p>
        <p v-else-if="localAiStore.initError" class="mt-2 text-xs text-color-bad">
          {{ t("ai.initError", { error: localAiStore.initError }) }}
        </p>
        <p v-if="downloadBypassesTor && !localAiStore.modelReady" class="mt-2 text-xs text-color-star-yellow">
          {{ t("ai.downloadBypassesTor") }}
        </p>

        <!-- Actions — "Обновить" relates to the already-selected model's
             own version (roadmap 6.3), never a model switch; "Проверить
             обновления" is manifest-wide, independent of how many models
             are on offer (plan §9). -->
        <div v-if="!isDownloading" class="mt-3 flex flex-wrap gap-2">
          <button
            v-if="localAiStore.modelReady"
            class="btn-press rounded-lg bg-color-bg-ac px-4 py-2 text-sm font-medium text-white transition-all hover:bg-color-bg-ac/90 active:scale-[0.97]"
            @click="handleUpdate"
          >
            {{ t("ai.update") }}
          </button>
          <button
            class="btn-press rounded-lg border border-neutral-grad-0 px-4 py-2 text-sm font-medium text-text-color transition-all hover:bg-neutral-grad-0 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-60"
            :disabled="isCheckingUpdates"
            @click="handleCheckUpdates"
          >
            {{ isCheckingUpdates ? t("ai.checkingUpdates") : t("ai.checkUpdates") }}
          </button>
        </div>

        <!-- Delete — available whenever there's something on disk to clean up
             (installed, paused, or failed-with-partial-bytes), but never
             while actively downloading — see isActivelyDownloading. -->
        <button
          v-if="canDelete"
          class="btn-press mt-3 w-full rounded-lg border border-color-bad/30 px-4 py-2 text-sm font-medium text-color-bad transition-colors hover:bg-color-bad/5 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-60"
          :disabled="isDeleting"
          @click="showDeleteConfirm = true"
        >
          {{ isDeleting ? t("ai.deleting") : isModelFullyInstalled ? t("ai.delete") : t("ai.discardDownload") }}
        </button>
      </template>
    </SettingsSection>

    <!-- Confirm: delete the model -->
    <Teleport to="body">
      <div
        v-if="showDeleteConfirm"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
        @click.self="showDeleteConfirm = false"
      >
        <div class="mx-4 max-w-sm rounded-xl bg-background-secondary-theme p-6 shadow-xl">
          <p class="mb-4 text-sm text-text-on-main-bg-color">
            {{ isModelFullyInstalled ? t("ai.deleteConfirm") : t("ai.discardDownloadConfirm") }}
          </p>
          <div class="flex justify-end gap-3">
            <button
              class="rounded-lg px-4 py-2 text-sm text-text-on-main-bg-color transition-colors hover:bg-neutral-grad-0"
              @click="showDeleteConfirm = false"
            >
              {{ t('common.cancel') }}
            </button>
            <button
              class="rounded-lg bg-color-bad px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-80"
              @click="handleDeleteConfirmed"
            >
              {{ isModelFullyInstalled ? t("ai.delete") : t("ai.discardDownload") }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
