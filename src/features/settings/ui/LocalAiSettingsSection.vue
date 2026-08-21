<script setup lang="ts">
/** Settings → Local AI (roadmap 6.3, multi-model UI rework 2026-08-21) —
 *  a picker list, one row per model in the manifest: eligibility badge,
 *  contextual action (Скачать/Докачать/Переключиться/Обновить/Активна),
 *  and a per-row overflow menu for delete. Same `useLocalAiStore` state as
 *  `AiModelGate.vue` inside an open AI chat — one shared progress bar
 *  (only one model action can be in flight at a time), never two
 *  `onProgress` subscriptions (plan §8 p.4).
 *
 *  Design notes (self-review, 2026-08-21 rework):
 *  - "Скачать и переключиться" (one merged label for two different things)
 *    is gone — the label is now driven by real per-model disk state
 *    (`modelDiskState`, `LocalAiClient.getDownloadProgress(target, modelId)`):
 *    "Скачать" for a genuinely absent file, "Докачать X%" for a real
 *    interrupted transfer, "Переключиться" for a model that's already
 *    fully resident (config.retainInactiveModels keeps every downloaded
 *    model's file on disk now, product decision made 2026-08-21 — see
 *    create-client.ts's matching comment).
 *  - "Обновить модель"/"Проверить обновления" as two adjacent, overlapping
 *    global buttons are gone. Update-checking is automatic on mount
 *    (refreshManifest() already ran here before this rework too — the
 *    only change is no longer requiring a manual click to *act* on what
 *    it found); "Обновить" now lives contextually in the active row's own
 *    action slot, replacing "Активна" only when a newer version is
 *    actually available (`activeModelUpdateAvailable`). A small icon-only
 *    refresh button remains next to the section title for a user who
 *    wants to force a re-check without waiting for a natural remount —
 *    good practice for a network op that can transiently fail, not a
 *    second "Проверить обновления" in disguise (no label, no separate
 *    "is there an update" state of its own).
 *  - Delete moved from one global button (implicitly "delete whatever's
 *    ready") to a small overflow ("⋮") menu on every row that actually has
 *    a file to remove — resident or partially-downloaded, active or not.
 *    A kebab menu for a single item is arguably one tap more than
 *    necessary, but keeps the row visually calm (no permanent red trash
 *    icon sitting next to every model) and was the explicitly requested
 *    shape. The confirm dialog itself is unchanged, just parametrized by
 *    which model triggered it. */
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
/** Per-model eligibility badges — populated by {@link refreshModelEligibility},
 *  one entry per {@link models} row. `null` means the check itself failed
 *  (readable as "unknown" in {@link modelBadge}); a key simply absent means
 *  it hasn't been checked yet this mount. */
const modelEligibilityMap = ref<Record<string, EligibilityReport | null>>({});
const downloadState = computed(() => localAiStore.downloadState.model);
const percent = computed(() => Math.round(downloadState.value.progress?.percent ?? 0));
const isDownloading = computed(() => downloadState.value.progress !== null);
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
/** The display name of whichever model the shared progress bar is
 *  currently tracking — prefixed onto {@link phaseLabel} so a multi-row
 *  list doesn't leave the user guessing which row a lone "Скачивание…
 *  42%" belongs to. */
const downloadingModelName = computed(
  () => models.value.find((m: ModelArtifact) => m.id === localAiStore.currentModel?.id)?.displayName ?? null,
);
/** Pausing only means anything while bytes are actually still in flight —
 *  verification (local hashing) and loading (into the LLM runtime) don't
 *  go through the download transport at all, so "Пауза" during either
 *  would be a confusing no-op. */
const canPause = computed(() => {
  const status = downloadState.value.progress?.status;
  return status === "pending" || status === "downloading";
});

const isRefreshing = ref(false);
const isDeleting = ref(false);
const openMenuModelId = ref<string | null>(null);
const modelPendingDelete = ref<ModelArtifact | null>(null);

/** Whether `modelId` is the one actually loaded in the runtime right now —
 *  at most one row can be (only one model can be loaded into the LLM
 *  runtime at a time — a memory/compute constraint, unlike disk residency
 *  which `config.retainInactiveModels` now allows for more than one).
 *  Deliberately `loadedModelId`, not `currentModel`/`selectedModelId` —
 *  those flip to a new choice the instant `selectModel()` resolves, before
 *  anything has actually downloaded/loaded; using them here would show the
 *  new (not-yet-ready) row as "Активна" and the still-genuinely-loaded old
 *  row as "not downloaded" for the whole switch window, and permanently if
 *  the switch then fails (code review finding, 2026-08-21). */
function isModelActive(modelId: string): boolean {
  return localAiStore.loadedModelId === modelId;
}

/** Only ever true for the selected model's row — `downloadState.model`
 *  (and its progress bar below) always tracks whatever `ensureModelReady()`/
 *  `switchModel()` is currently acting on, which is always the selection. */
function isRowDownloading(modelId: string): boolean {
  return isDownloading.value && localAiStore.currentModel?.id === modelId;
}

/** `percent === 100` in {@link localAiStore}'s per-model disk cache — a
 *  real file already fully on disk for this specific model, independent of
 *  whether it's the *active* one (multi-model UI rework). */
function isModelResident(modelId: string): boolean {
  return localAiStore.modelDiskState[modelId]?.percent === 100;
}

/** A real, partial (interrupted) download to resume for this specific
 *  model — `0 < percent < 100`. `0`/absent isn't shown as a resume
 *  (nothing meaningful to distinguish from a fresh download yet). */
function modelResumePercent(modelId: string): number | null {
  const p = localAiStore.modelDiskState[modelId]?.percent ?? 0;
  return p > 0 && p < 100 ? p : null;
}

/** Anything genuinely on disk for this model worth offering to delete — a
 *  completed file, a paused/failed download with real partial bytes. Never
 *  offered while that same row is actively (un-paused) downloading — see
 *  the matching reasoning on the old global `canDelete`, now per-row. */
function canDeleteModel(modelId: string): boolean {
  const onDisk = (localAiStore.modelDiskState[modelId]?.percent ?? 0) > 0;
  const activelyDownloadingThisRow = isRowDownloading(modelId) && !localAiStore.isPaused;
  return onDisk && !activelyDownloadingThisRow;
}

// Same eligibility-badge pattern as `torStatusInfo` in SettingsPanel.vue
// (plan §8 p.2), per-model-row: color + short text, hidden entirely when
// eligibility is 'ok'.
function modelBadge(modelId: string): { text: string; color: string } | null {
  switch (modelEligibilityMap.value[modelId]?.verdict) {
    case "tight": return { text: t("ai.eligibilityTight"), color: "text-color-star-yellow" };
    case "no": return { text: t("ai.eligibilityBlocked"), color: "text-color-bad" };
    case "unknown": return { text: t("ai.eligibilityUnknown"), color: "text-text-on-main-bg-color" };
    default: return null;
  }
}

/** Status text next to a row, when there's nothing more specific (an
 *  eligibility badge, an in-progress phase) to show. `null` for a
 *  resident-but-inactive or partially-downloaded row — the action button
 *  itself ("Переключиться"/"Докачать X%") already says what's going on,
 *  a second label would just repeat it. */
function rowStatusLabel(modelId: string): string | null {
  if (isRowDownloading(modelId)) return phaseLabel.value;
  if (isModelActive(modelId)) return localAiStore.activeModelUpdateAvailable ? t("ai.updateAvailable") : t("ai.active");
  if (isModelResident(modelId) || modelResumePercent(modelId) !== null) return null;
  return t("ai.notDownloaded");
}

/** Action-button label for a not-yet-active row, driven by real per-model
 *  disk state — "Скачать" (genuinely nothing on disk), "Докачать X%" (a
 *  real interrupted transfer), or "Переключиться" (already fully resident,
 *  `config.retainInactiveModels` — instant, no network). */
function downloadLabel(modelId: string): string {
  const resume = modelResumePercent(modelId);
  if (resume !== null) return t("ai.resumeDownload", { percent: resume });
  return isModelResident(modelId) ? t("ai.switchTo") : t("ai.download");
}

/** Runs `modelEligibility()` for every row in {@link models} — cached
 *  per-modelId by the store itself (`modelEligibilityCache`), so
 *  re-running this after a `selectModel()` call (which doesn't change the
 *  manifest) is cheap. */
async function refreshModelEligibility(): Promise<void> {
  const address = authStore.address;
  if (!address) return;
  await Promise.all(
    models.value.map(async (m: ModelArtifact) => {
      modelEligibilityMap.value[m.id] = await localAiStore.modelEligibility(address, m.id).catch(() => null);
    }),
  );
}

/** Refreshes {@link localAiStore}'s per-model disk-residency cache for
 *  every row — this is what makes `downloadLabel()`/`canDeleteModel()`
 *  reflect truth rather than a guess. */
async function refreshModelDiskState(): Promise<void> {
  const address = authStore.address;
  if (!address) return;
  await Promise.all(models.value.map((m: ModelArtifact) => localAiStore.checkModelDiskState(address, m.id).catch(() => null)));
}

onMounted(async () => {
  await localAiStore.checkSupportOnce();
  const address = authStore.address;
  if (!address || supportReport.value?.capabilities.inference === false) return;
  // Automatic check-for-updates — no manual button needed for this part
  // anymore, see this file's own top-of-file design note.
  await localAiStore.refreshManifest(address).catch(() => {});
  await Promise.all([refreshModelEligibility(), refreshModelDiskState()]);
  // Silently re-verify an already-downloaded model on a fresh session — see
  // `restoreModelIfPreviouslyDownloaded`'s doc comment. Never blocks/replaces
  // the explicit "Скачать" click for a device that hasn't downloaded before.
  await localAiStore.restoreModelIfPreviouslyDownloaded(address).catch(() => {});
  if (!localAiStore.modelReady) await localAiStore.checkPartialDownload(address).catch(() => {});
  await refreshModelDiskState(); // re-sync — the silent restore above may have changed what's actually on disk/active
});

/** Manual force-recheck (small icon button, not a labeled "Проверить
 *  обновления" button) — for a user who doesn't want to wait for a fresh
 *  mount, or whose automatic check on mount hit a transient network blip. */
async function handleManualRefresh(): Promise<void> {
  const address = authStore.address;
  if (!address || isRefreshing.value) return;
  isRefreshing.value = true;
  try {
    await localAiStore.refreshManifest(address);
    await Promise.all([refreshModelEligibility(), refreshModelDiskState()]);
  } catch (e) {
    console.warn("[LocalAiSettingsSection] manual refresh failed:", e);
  } finally {
    isRefreshing.value = false;
  }
}

/** Row action for a not-yet-active model — selects it first if it isn't
 *  already the current selection, then downloads/switches
 *  (`downloadModel()`'s `ensureModelReady()` already resolves against
 *  whatever's selected and short-circuits the network step entirely for a
 *  model that's already resident, so this one call correctly covers both
 *  "Скачать" and "Переключиться"). */
async function handleModelAction(modelId: string): Promise<void> {
  const address = authStore.address;
  if (!address) return;
  if (localAiStore.selectedModelId !== modelId) {
    try {
      await localAiStore.selectModel(address, modelId);
    } catch (e) {
      // Surfaced the same way downloadModel()'s own failures are — a bare
      // console.warn here left the button silently reverting with zero
      // user-visible feedback (code review finding, 2026-08-21).
      const err = e instanceof Error ? e : new Error(String(e));
      localAiStore.downloadState.model.error = err.message;
      localAiStore.downloadState.model.errorCode = null;
      console.warn("[LocalAiSettingsSection] selectModel failed:", e);
      return;
    }
  }
  // Only seed the "starting" progress placeholder for a real download — an
  // instant switch (already 100% resident) has no network lag to paper
  // over, and ensureModelReady() fires its own 'loading' onProgress tick
  // almost immediately regardless (see LocalAiClient.ensureModelReady()'s
  // doc comment) — a fake 0%→X% bar for a switch would just be noise.
  if (!isModelResident(modelId)) localAiStore.markDownloadStarting(modelId);
  await localAiStore.downloadModel(address).catch((e: unknown) => {
    console.warn("[LocalAiSettingsSection] downloadModel failed:", e);
  });
  await refreshModelDiskState();
}

/** The active row's own "Обновить" action — unchanged underlying call,
 *  now triggered from that row's action slot instead of a global button. */
async function handleUpdateActive(): Promise<void> {
  const address = authStore.address;
  if (!address) return;
  await localAiStore.switchModel(address).catch((e: unknown) => {
    console.warn("[LocalAiSettingsSection] switchModel failed:", e);
  });
  await refreshModelDiskState();
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

function toggleModelMenu(modelId: string): void {
  openMenuModelId.value = openMenuModelId.value === modelId ? null : modelId;
}

function requestDelete(model: ModelArtifact): void {
  openMenuModelId.value = null;
  modelPendingDelete.value = model;
}

async function handleDeleteConfirmed(): Promise<void> {
  const address = authStore.address;
  const model = modelPendingDelete.value;
  modelPendingDelete.value = null;
  if (!address || !model || isDeleting.value) return;
  isDeleting.value = true;
  try {
    await localAiStore.deleteModel(address, model.id);
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
        <div class="mb-1 flex items-center justify-end">
          <button
            class="btn-press rounded-lg p-1.5 text-text-on-main-bg-color transition-all hover:bg-neutral-grad-0 disabled:pointer-events-none disabled:opacity-60"
            :disabled="isRefreshing"
            :title="t('ai.checkUpdates')"
            :aria-label="t('ai.checkUpdates')"
            @click="handleManualRefresh"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" :class="{ 'animate-spin': isRefreshing }">
              <path d="M23 4v6h-6" /><path d="M1 20v-6h6" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
          </button>
        </div>

        <!-- Model list — one row per available model; at most one row is
             ever "active" (loaded), but with retainInactiveModels more
             than one can be genuinely resident on disk. -->
        <div class="space-y-2">
          <div
            v-for="m in models"
            :key="m.id"
            class="space-y-0.5 rounded-xl bg-background-secondary-theme"
          >
            <div class="flex items-center justify-between gap-2 px-4 py-3">
              <div class="min-w-0">
                <p class="truncate text-sm font-medium text-text-color">
                  {{ m.displayName }} · {{ m.quant }}
                  <span v-if="m.recommended" class="text-xs font-normal text-color-bg-ac">({{ t("ai.recommended") }})</span>
                </p>
                <p class="font-mono text-xs text-text-on-main-bg-color">{{ formatBytes(m.sizeBytes) }}</p>
              </div>
              <div class="flex shrink-0 items-center gap-1">
                <span
                  v-if="modelBadge(m.id) || rowStatusLabel(m.id)"
                  class="flex items-center gap-1.5 whitespace-nowrap text-sm"
                  :class="modelBadge(m.id)?.color ?? 'text-text-on-main-bg-color'"
                >{{ modelBadge(m.id)?.text ?? rowStatusLabel(m.id) }}</span>

                <!-- Per-row overflow menu — delete, only offered when
                     there's actually something on disk for this row. -->
                <div v-if="canDeleteModel(m.id)" class="relative">
                  <button
                    class="btn-press flex h-7 w-7 items-center justify-center rounded-lg text-text-on-main-bg-color transition-all hover:bg-neutral-grad-0"
                    :aria-label="t('ai.delete')"
                    @click="toggleModelMenu(m.id)"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                      <circle cx="12" cy="5" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="12" cy="19" r="1.6" />
                    </svg>
                  </button>
                  <template v-if="openMenuModelId === m.id">
                    <!-- Backdrop — closes the menu on any outside tap. -->
                    <div class="fixed inset-0 z-10" @click="openMenuModelId = null" />
                    <div class="absolute right-0 top-full z-20 mt-1 min-w-[10rem] overflow-hidden rounded-lg bg-background-secondary-theme shadow-lg ring-1 ring-neutral-grad-0">
                      <button
                        class="btn-press w-full px-3 py-2.5 text-left text-sm text-color-bad transition-colors hover:bg-color-bad/10"
                        @click="requestDelete(m)"
                      >
                        {{ isModelResident(m.id) ? t("ai.delete") : t("ai.discardDownload") }}
                      </button>
                    </div>
                  </template>
                </div>
              </div>
            </div>

            <div v-if="!isRowDownloading(m.id)" class="px-4 pb-3">
              <button
                v-if="isModelActive(m.id) && !localAiStore.activeModelUpdateAvailable"
                disabled
                class="btn-press w-full rounded-lg border border-color-bg-ac/40 px-4 py-1.5 text-sm font-medium text-color-bg-ac disabled:opacity-80"
              >
                {{ t("ai.active") }}
              </button>
              <button
                v-else-if="isModelActive(m.id)"
                class="btn-press w-full rounded-lg bg-color-bg-ac px-4 py-1.5 text-sm font-medium text-white transition-all hover:bg-color-bg-ac/90 active:scale-[0.97]"
                @click="handleUpdateActive"
              >
                {{ t("ai.update") }}
              </button>
              <button
                v-else
                class="btn-press w-full rounded-lg bg-color-bg-ac px-4 py-1.5 text-sm font-medium text-white transition-all hover:bg-color-bg-ac/90 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-60"
                :disabled="modelEligibilityMap[m.id]?.verdict === 'no' || isDownloading"
                @click="handleModelAction(m.id)"
              >
                {{ downloadLabel(m.id) }}
              </button>
            </div>
          </div>
        </div>

        <!-- Shared progress bar — only one model action can be in flight at
             a time; downloadingModelName names which row it belongs to. -->
        <div v-if="isDownloading" class="mt-3">
          <p class="mb-1.5 text-sm text-text-on-main-bg-color">
            <span v-if="downloadingModelName" class="font-medium text-text-color">{{ downloadingModelName }}: </span>{{ phaseLabel }}
          </p>
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
      </template>
    </SettingsSection>

    <!-- Confirm: delete one specific model -->
    <Teleport to="body">
      <div
        v-if="modelPendingDelete"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
        @click.self="modelPendingDelete = null"
      >
        <div class="mx-4 max-w-sm rounded-xl bg-background-secondary-theme p-6 shadow-xl">
          <p class="mb-4 text-sm text-text-on-main-bg-color">
            {{ isModelResident(modelPendingDelete.id) ? t("ai.deleteConfirm") : t("ai.discardDownloadConfirm") }}
          </p>
          <div class="flex justify-end gap-3">
            <button
              class="rounded-lg px-4 py-2 text-sm text-text-on-main-bg-color transition-colors hover:bg-neutral-grad-0"
              @click="modelPendingDelete = null"
            >
              {{ t('common.cancel') }}
            </button>
            <button
              class="rounded-lg bg-color-bad px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-80"
              @click="handleDeleteConfirmed"
            >
              {{ isModelResident(modelPendingDelete.id) ? t("ai.delete") : t("ai.discardDownload") }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
