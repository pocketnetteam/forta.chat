<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import Avatar from "@/shared/ui/avatar/Avatar.vue";
import { getMediaCache, type MediaCacheRoomUsage } from "@/shared/lib/media-cache";
import type { MediaCacheIndexEntry } from "@/shared/lib/media-cache";
import { useChatStore } from "@/entities/chat";
import { displayName } from "../lib/storage-display";
import { useMediaThumbnails } from "../model/use-media-thumbnails";

interface Props {
  room: MediaCacheRoomUsage;
  globalTotal: number;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  back: [];
  cleared: [];
  preview: [entry: MediaCacheIndexEntry];
}>();

const { t } = useI18n();
const chatStore = useChatStore();

type DetailTab = "media" | "file" | "voice";
const activeTab = ref<DetailTab>("media");

const entries = ref<MediaCacheIndexEntry[]>([]);
const showClearConfirm = ref(false);
/** Set while `deleteByRoom` is in flight so the periodic `refresh()`
 *  doesn't race it. Without this guard the list could observe the index
 *  mid-`bulkDelete` and surface entries whose storage blob has already
 *  been removed — tapping one would just show "Preview unavailable". */
const clearing = ref(false);

const refresh = async () => {
  if (clearing.value) return;
  const cache = getMediaCache();
  if (!cache) return;
  try {
    entries.value = await cache.listByRoom(props.room.roomId);
  } catch {
    /* keep last snapshot */
  }
};

let refreshTimer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  refresh();
  refreshTimer = setInterval(refresh, 5000);
});
onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer);
});

watch(() => props.room.roomId, refresh);

const displayRoom = computed(() => {
  const found = chatStore.rooms.find((r) => r.id === props.room.roomId);
  return found ?? {
    id: props.room.roomId,
    name: t("storage.unknownChat"),
    avatar: undefined,
    isGroup: false,
  };
});

const mediaList = computed(() => entries.value.filter((e: MediaCacheIndexEntry) => e.category === "media"));
const fileList = computed(() => entries.value.filter((e: MediaCacheIndexEntry) => e.category === "file"));
const voiceList = computed(() => entries.value.filter((e: MediaCacheIndexEntry) => e.category === "voice"));

const { thumbnails } = useMediaThumbnails(mediaList);

const formatBytes = (bytes: number): string => {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
};

const truncate = (s: string, max = 32): string => {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
};

const sharePercent = computed(() => {
  if (props.globalTotal === 0) return 0;
  return Math.round((props.room.totalBytes / props.globalTotal) * 100);
});

const percentInRoom = (bytes: number): number => {
  if (props.room.totalBytes === 0) return 0;
  return Math.min(100, Math.round((bytes / props.room.totalBytes) * 100));
};

const handleClearChat = async () => {
  showClearConfirm.value = false;
  clearing.value = true;
  // Clear the local list immediately so the UI doesn't render rows whose
  // backing blobs are about to disappear. The detail view will unmount
  // when the parent reacts to `cleared`, but if the bulkDelete is slow
  // (1k entries on a low-end Android) the snap-to-empty avoids a stale
  // tappable row that would resolve to a "Preview unavailable" toast.
  entries.value = [];
  try {
    const cache = getMediaCache();
    if (cache) await cache.deleteByRoom(props.room.roomId);
    emit("cleared");
  } catch (e) {
    console.warn("[ChatStorageDetail] clear failed:", e);
  } finally {
    clearing.value = false;
  }
};

const DETAIL_TABS: Array<{ id: DetailTab; labelKey: "storage.tabs.media" | "storage.tabs.files" | "storage.tabs.voice" }> = [
  { id: "media", labelKey: "storage.tabs.media" },
  { id: "file",  labelKey: "storage.tabs.files" },
  { id: "voice", labelKey: "storage.tabs.voice" },
];

const activeList = computed(() => {
  switch (activeTab.value) {
    case "media": return mediaList.value;
    case "file":  return fileList.value;
    case "voice": return voiceList.value;
    default: return [];
  }
});
</script>

<template>
  <div class="flex h-full flex-col bg-background-total-theme">
    <!-- Header -->
    <div class="flex items-center gap-3 border-b border-neutral-grad-0 px-4 py-3">
      <button
        class="flex h-9 w-9 items-center justify-center rounded-full text-text-on-main-bg-color transition-colors hover:bg-neutral-grad-0"
        @click="emit('back')"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M19 12H5" /><path d="M12 19l-7-7 7-7" />
        </svg>
      </button>
      <h1 class="truncate text-lg font-bold text-text-color">{{ displayRoom.name }}</h1>
    </div>

    <div class="flex-1 overflow-y-auto pb-safe">
      <!-- Chat header: just avatar + name + share — no donut wrapping -->
      <div class="flex flex-col items-center px-4 pb-2 pt-6">
        <Avatar :src="displayRoom.avatar" :name="displayRoom.name" size="xl" />
        <h2 class="mt-3 truncate text-lg font-semibold text-text-color">{{ displayRoom.name }}</h2>
        <p class="mt-1 text-center text-xs text-text-on-main-bg-color">
          {{ t('storage.chatShareOfTotal', { pct: sharePercent }) }}
        </p>
      </div>

      <!-- Per-category bars + stacked bar (mirrors the main screen) -->
      <div class="mx-4 mt-4 rounded-xl border border-neutral-grad-0 bg-background-secondary-theme p-4">
        <div class="flex items-baseline justify-between">
          <span class="text-sm text-text-on-main-bg-color">{{ t('storage.totalForChat') }}</span>
          <span class="text-base font-semibold text-text-color">{{ formatBytes(room.totalBytes) }}</span>
        </div>

        <div class="mt-3 flex h-2 w-full overflow-hidden rounded-full bg-neutral-grad-0">
          <div
            v-if="room.byCategory.media > 0"
            class="h-full bg-color-bg-ac transition-all"
            :style="{ width: percentInRoom(room.byCategory.media) + '%' }"
          />
          <div
            v-if="room.byCategory.voice > 0"
            class="h-full bg-color-star-yellow transition-all"
            :style="{ width: percentInRoom(room.byCategory.voice) + '%' }"
          />
          <div
            v-if="room.byCategory.file > 0"
            class="h-full bg-text-on-main-bg-color/40 transition-all"
            :style="{ width: percentInRoom(room.byCategory.file) + '%' }"
          />
        </div>

        <div class="mt-4 space-y-2">
          <div class="flex items-center gap-2 text-sm">
            <span class="inline-block h-2.5 w-2.5 rounded-full bg-color-bg-ac" />
            <span class="text-text-color">{{ t('storage.tabs.media') }}</span>
            <span class="text-xs text-text-on-main-bg-color">{{ percentInRoom(room.byCategory.media) }}%</span>
            <span class="ml-auto text-text-color">{{ formatBytes(room.byCategory.media) }}</span>
          </div>
          <div class="flex items-center gap-2 text-sm">
            <span class="inline-block h-2.5 w-2.5 rounded-full bg-color-star-yellow" />
            <span class="text-text-color">{{ t('storage.tabs.voice') }}</span>
            <span class="text-xs text-text-on-main-bg-color">{{ percentInRoom(room.byCategory.voice) }}%</span>
            <span class="ml-auto text-text-color">{{ formatBytes(room.byCategory.voice) }}</span>
          </div>
          <div class="flex items-center gap-2 text-sm">
            <span class="inline-block h-2.5 w-2.5 rounded-full bg-text-on-main-bg-color/40" />
            <span class="text-text-color">{{ t('storage.tabs.files') }}</span>
            <span class="text-xs text-text-on-main-bg-color">{{ percentInRoom(room.byCategory.file) }}%</span>
            <span class="ml-auto text-text-color">{{ formatBytes(room.byCategory.file) }}</span>
          </div>
        </div>
      </div>

      <!-- Tabs (same style as the main screen — underline) -->
      <div class="mt-4 px-4">
        <div class="flex gap-1 overflow-x-auto border-b border-neutral-grad-0">
          <button
            v-for="tab in DETAIL_TABS"
            :key="tab.id"
            class="shrink-0 px-4 py-2.5 text-sm font-medium transition-colors"
            :class="activeTab === tab.id
              ? 'border-b-2 border-color-bg-ac text-color-bg-ac'
              : 'border-b-2 border-transparent text-text-on-main-bg-color hover:text-text-color'"
            @click="activeTab = tab.id"
          >
            {{ t(tab.labelKey) }}
          </button>
        </div>

        <ul v-if="activeList.length > 0" class="mt-3 overflow-hidden rounded-xl bg-background-secondary-theme">
          <li
            v-for="(entry, idx) in activeList"
            :key="entry.mxc"
            class="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-neutral-grad-0/50 cursor-pointer"
            :class="idx > 0 ? 'border-t border-neutral-grad-0' : ''"
            role="button"
            @click="emit('preview', entry)"
          >
            <!-- Image thumbnail or category icon -->
            <div
              v-if="thumbnails[entry.mxc]"
              class="h-10 w-10 shrink-0 overflow-hidden rounded-lg bg-neutral-grad-0"
            >
              <img :src="thumbnails[entry.mxc]" alt="" class="h-full w-full object-cover" />
            </div>
            <div
              v-else-if="entry.category === 'media'"
              class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-color-bg-ac/15 text-color-bg-ac"
            >
              <svg v-if="entry.mime.startsWith('video/')" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polygon points="23 7 16 12 23 17 23 7" />
                <rect x="1" y="5" width="15" height="14" rx="2" />
              </svg>
              <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <polyline points="21 15 16 10 5 21" />
              </svg>
            </div>
            <div
              v-else-if="entry.category === 'voice'"
              class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-color-bg-ac/15 text-color-bg-ac"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
            </div>
            <div
              v-else
              class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-text-on-main-bg-color/15 text-text-on-main-bg-color"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
            </div>
            <div class="min-w-0 flex-1 truncate text-sm font-medium text-text-color">
              {{ truncate(displayName(entry, t)) }}
            </div>
            <div class="text-sm text-text-color">{{ formatBytes(entry.size) }}</div>
          </li>
        </ul>
        <div v-else class="mt-3 rounded-xl bg-background-secondary-theme py-8 text-center text-sm text-text-on-main-bg-color">
          {{ t('storage.empty') }}
        </div>
      </div>

      <!-- Clear button -->
      <div class="mt-6 px-4 pb-2">
        <button
          class="w-full rounded-lg bg-color-bg-ac px-4 py-3 text-sm font-medium text-text-on-bg-ac-color transition-opacity hover:opacity-90"
          @click="showClearConfirm = true"
        >
          {{ t('storage.clearAll') }}
          <span class="ml-1 opacity-80">· {{ formatBytes(room.totalBytes) }}</span>
        </button>
      </div>
    </div>

    <Teleport to="body">
      <div
        v-if="showClearConfirm"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
        @click.self="showClearConfirm = false"
      >
        <div class="mx-4 max-w-sm rounded-xl bg-background-secondary-theme p-6 shadow-xl">
          <h3 class="mb-2 text-base font-semibold text-text-color">
            {{ t('storage.confirmRoomTitle', { name: displayRoom.name }) }}
          </h3>
          <p class="mb-4 text-sm text-text-on-main-bg-color">{{ t('storage.confirmRoomBody') }}</p>
          <div class="flex justify-end gap-3">
            <button
              class="rounded-lg px-4 py-2 text-sm text-text-on-main-bg-color transition-colors hover:bg-neutral-grad-0"
              @click="showClearConfirm = false"
            >
              {{ t('common.cancel') }}
            </button>
            <button
              class="rounded-lg bg-color-bad px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-80"
              @click="handleClearChat"
            >
              {{ t('storage.deleteFromChat') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
