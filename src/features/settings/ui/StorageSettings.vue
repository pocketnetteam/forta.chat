<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { SettingsSection } from "@/shared/ui/settings-section";
import {
  getMediaCache,
  applyCacheLimitMb,
  getStoredCacheLimitMb,
  MIN_LIMIT_MB,
  MAX_LIMIT_MB,
  type MediaCacheBreakdown,
} from "@/shared/lib/media-cache";

const { t } = useI18n();

const breakdown = ref<MediaCacheBreakdown>({
  image: 0,
  video: 0,
  audio: 0,
  other: 0,
  total: 0,
});

const cacheLimitMb = ref<number>(getStoredCacheLimitMb());
const clearing = ref(false);
const showClearConfirm = ref(false);

// Periodically refresh the breakdown so the number reflects ongoing cache
// writes without the user having to leave + re-open the page. 5 s strikes a
// balance between latency and CPU cost — the full-table scan over the index
// is cheap (entries are bounded by maxBytes / avg-blob-size).
let refreshTimer: ReturnType<typeof setInterval> | null = null;

const refreshBreakdown = async () => {
  const cache = getMediaCache();
  if (!cache) return;
  try {
    breakdown.value = await cache.sizeBreakdown();
  } catch {
    // Non-fatal — just show whatever we last had.
  }
};

onMounted(() => {
  refreshBreakdown();
  refreshTimer = setInterval(refreshBreakdown, 5000);
});

onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer);
});

const formatBytes = (bytes: number): string => {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
};

const totalFormatted = computed(() => formatBytes(breakdown.value.total));
const limitFormatted = computed(() => `${cacheLimitMb.value} MB`);

const percentByCategory = (bytes: number): number => {
  if (breakdown.value.total === 0) return 0;
  return Math.min(100, Math.round((bytes / breakdown.value.total) * 100));
};

const handleClear = async () => {
  showClearConfirm.value = false;
  clearing.value = true;
  try {
    const cache = getMediaCache();
    if (cache) await cache.clearAll();
    await refreshBreakdown();
  } catch (e) {
    console.warn("[StorageSettings] clear failed:", e);
  } finally {
    clearing.value = false;
  }
};

// Persist + apply the new budget every time the slider commits (mouseup /
// touchend / keyup-arrow). `applyCacheLimitMb` clamps internally, so we
// don't bother re-validating here.
const handleLimitCommit = async () => {
  await applyCacheLimitMb(cacheLimitMb.value);
  await refreshBreakdown();
};
</script>

<template>
  <div class="space-y-6 p-4">
    <!-- Total usage card -->
    <SettingsSection :title="t('storage.title')" :description="t('storage.description')">
      <div class="rounded-xl border border-neutral-grad-0 bg-background-secondary-theme p-4">
        <div class="flex items-baseline justify-between">
          <span class="text-sm text-text-on-main-bg-color">{{ t('storage.used') }}</span>
          <span class="text-base font-semibold text-text-color">{{ totalFormatted }}</span>
        </div>

        <!-- Stacked bar showing category breakdown -->
        <div class="mt-3 flex h-2 w-full overflow-hidden rounded-full bg-neutral-grad-0">
          <div
            v-if="breakdown.image > 0"
            class="h-full bg-color-bg-ac transition-all"
            :style="{ width: percentByCategory(breakdown.image) + '%' }"
          />
          <div
            v-if="breakdown.video > 0"
            class="h-full bg-color-star-yellow transition-all"
            :style="{ width: percentByCategory(breakdown.video) + '%' }"
          />
          <div
            v-if="breakdown.audio > 0"
            class="h-full bg-color-good transition-all"
            :style="{ width: percentByCategory(breakdown.audio) + '%' }"
          />
          <div
            v-if="breakdown.other > 0"
            class="h-full bg-text-on-main-bg-color/40 transition-all"
            :style="{ width: percentByCategory(breakdown.other) + '%' }"
          />
        </div>

        <!-- Per-category rows -->
        <div class="mt-4 space-y-2 text-sm">
          <div class="flex items-center justify-between">
            <span class="flex items-center gap-2 text-text-color">
              <span class="inline-block h-2 w-2 rounded-full bg-color-bg-ac" />
              {{ t('storage.photos') }}
            </span>
            <span class="text-text-on-main-bg-color">{{ formatBytes(breakdown.image) }}</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="flex items-center gap-2 text-text-color">
              <span class="inline-block h-2 w-2 rounded-full bg-color-star-yellow" />
              {{ t('storage.videos') }}
            </span>
            <span class="text-text-on-main-bg-color">{{ formatBytes(breakdown.video) }}</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="flex items-center gap-2 text-text-color">
              <span class="inline-block h-2 w-2 rounded-full bg-color-good" />
              {{ t('storage.audio') }}
            </span>
            <span class="text-text-on-main-bg-color">{{ formatBytes(breakdown.audio) }}</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="flex items-center gap-2 text-text-color">
              <span class="inline-block h-2 w-2 rounded-full bg-text-on-main-bg-color/40" />
              {{ t('storage.other') }}
            </span>
            <span class="text-text-on-main-bg-color">{{ formatBytes(breakdown.other) }}</span>
          </div>
        </div>
      </div>
    </SettingsSection>

    <!-- Cache limit slider -->
    <SettingsSection :title="t('storage.limitTitle')" :description="t('storage.limitDescription')">
      <div class="rounded-xl border border-neutral-grad-0 bg-background-secondary-theme p-4">
        <div class="flex items-baseline justify-between">
          <span class="text-sm text-text-on-main-bg-color">{{ t('storage.currentLimit') }}</span>
          <span class="text-base font-semibold text-text-color">{{ limitFormatted }}</span>
        </div>
        <input
          v-model.number="cacheLimitMb"
          type="range"
          :min="MIN_LIMIT_MB"
          :max="MAX_LIMIT_MB"
          step="100"
          class="mt-3 h-2 w-full appearance-none rounded-full bg-neutral-grad-0 accent-color-bg-ac"
          @change="handleLimitCommit"
        />
        <div class="mt-1 flex justify-between text-xs text-text-on-main-bg-color">
          <span>{{ MIN_LIMIT_MB }} MB</span>
          <span>{{ MAX_LIMIT_MB }} MB</span>
        </div>
      </div>
    </SettingsSection>

    <!-- Danger zone: clear cache -->
    <SettingsSection :title="t('storage.clearTitle')" :description="t('storage.clearDescription')">
      <button
        class="w-full rounded-lg border border-color-bad/30 px-4 py-3 text-sm font-medium text-color-bad transition-colors hover:bg-color-bad/5 disabled:opacity-50"
        :disabled="clearing || breakdown.total === 0"
        @click="showClearConfirm = true"
      >
        {{ clearing ? t('storage.clearing') : t('storage.clearAll') }}
      </button>
    </SettingsSection>

    <!-- Confirmation dialog -->
    <Teleport to="body">
      <div
        v-if="showClearConfirm"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
        @click.self="showClearConfirm = false"
      >
        <div class="mx-4 max-w-sm rounded-xl bg-background-secondary-theme p-6 shadow-xl">
          <h3 class="mb-2 text-base font-semibold text-text-color">{{ t('storage.confirmTitle') }}</h3>
          <p class="mb-4 text-sm text-text-on-main-bg-color">{{ t('storage.confirmBody') }}</p>
          <div class="flex justify-end gap-3">
            <button
              class="rounded-lg px-4 py-2 text-sm text-text-on-main-bg-color transition-colors hover:bg-neutral-grad-0"
              @click="showClearConfirm = false"
            >
              {{ t('common.cancel') }}
            </button>
            <button
              class="rounded-lg bg-color-bad px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-80"
              @click="handleClear"
            >
              {{ t('storage.clearAll') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
