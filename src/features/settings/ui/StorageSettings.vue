<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { SettingsSection } from "@/shared/ui/settings-section";
import Avatar from "@/shared/ui/avatar/Avatar.vue";
import {
  getMediaCache,
  applyCacheLimitMb,
  getStoredCacheLimitMb,
  MIN_LIMIT_MB,
  MAX_LIMIT_MB,
  type MediaCacheBreakdown,
  type MediaCacheRoomUsage,
} from "@/shared/lib/media-cache";
import { useChatStore } from "@/entities/chat";
import type { MediaCacheIndexEntry } from "@/shared/lib/local-db";
import ChatStorageDetail from "./ChatStorageDetail.vue";
import StoragePreview from "./StoragePreview.vue";
import { displayName } from "../lib/storage-display";
import { useMediaThumbnails } from "../model/use-media-thumbnails";

const { t } = useI18n();
const chatStore = useChatStore();

type Tab = "chats" | "media" | "file" | "voice";

const activeTab = ref<Tab>("chats");
const cacheLimitMb = ref<number>(getStoredCacheLimitMb());
const clearing = ref(false);
const showClearConfirm = ref(false);

const selectedRoom = ref<MediaCacheRoomUsage | null>(null);
const previewEntry = ref<MediaCacheIndexEntry | null>(null);

const breakdown = ref<MediaCacheBreakdown>({
  image: 0, video: 0, audio: 0, other: 0, total: 0,
});

const roomUsage = ref<MediaCacheRoomUsage[]>([]);
const mediaEntries = ref<MediaCacheIndexEntry[]>([]);
const fileEntries = ref<MediaCacheIndexEntry[]>([]);
const voiceEntries = ref<MediaCacheIndexEntry[]>([]);

// Aggregate sizes by the TAB categories (media/file/voice) so the header
// breakdown labels match the tabs the user clicks. Computing this from the
// already-loaded per-category lists keeps everything in one source of truth.
const tabBreakdown = computed(() => {
  const sum = (xs: MediaCacheIndexEntry[]) => xs.reduce((a, e) => a + e.size, 0);
  const media = sum(mediaEntries.value);
  const file = sum(fileEntries.value);
  const voice = sum(voiceEntries.value);
  const total = media + file + voice;
  return { media, file, voice, total };
});

let refreshTimer: ReturnType<typeof setInterval> | null = null;

const refreshAll = async () => {
  const cache = getMediaCache();
  if (!cache) return;
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  try {
    const snap = await cache.snapshot();
    breakdown.value = snap.breakdown;
    roomUsage.value = snap.byRoom;
    mediaEntries.value = snap.byCategory.media;
    fileEntries.value = snap.byCategory.file;
    voiceEntries.value = snap.byCategory.voice;
    if (selectedRoom.value) {
      const fresh = snap.byRoom.find((r) => r.roomId === selectedRoom.value!.roomId);
      selectedRoom.value = fresh ?? null;
    }
  } catch {
    /* show last snapshot */
  }
};

onMounted(() => {
  refreshAll();
  refreshTimer = setInterval(refreshAll, 5000);
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

const totalFormatted = computed(() => formatBytes(tabBreakdown.value.total));
const limitFormatted = computed(() => `${cacheLimitMb.value} MB`);

const percentBy = (bytes: number): number => {
  if (tabBreakdown.value.total === 0) return 0;
  return Math.min(100, Math.round((bytes / tabBreakdown.value.total) * 100));
};

const roomLookup = computed(() => {
  const map = new Map<string, { id: string; name: string; avatar?: string; isGroup: boolean }>();
  for (const room of chatStore.rooms) {
    map.set(room.id, { id: room.id, name: room.name, avatar: room.avatar, isGroup: room.isGroup });
  }
  return map;
});

const displayRoom = (roomId: string) => {
  return roomLookup.value.get(roomId) ?? {
    id: roomId,
    name: t("storage.unknownChat"),
    avatar: undefined,
    isGroup: false,
  };
};

const handleClearAll = async () => {
  showClearConfirm.value = false;
  clearing.value = true;
  try {
    const cache = getMediaCache();
    if (cache) await cache.clearAll();
    await refreshAll();
  } catch (e) {
    console.warn("[StorageSettings] clear failed:", e);
  } finally {
    clearing.value = false;
  }
};

const handleLimitCommit = async () => {
  await applyCacheLimitMb(cacheLimitMb.value);
  await refreshAll();
};

const handleChatCleared = async () => {
  selectedRoom.value = null;
  await refreshAll();
};

const handleEntryDeleted = async () => {
  previewEntry.value = null;
  await refreshAll();
};

const TABS: Array<{ id: Tab; labelKey: "storage.tabs.chats" | "storage.tabs.media" | "storage.tabs.files" | "storage.tabs.voice" }> = [
  { id: "chats", labelKey: "storage.tabs.chats" },
  { id: "media", labelKey: "storage.tabs.media" },
  { id: "file", labelKey: "storage.tabs.files" },
  { id: "voice", labelKey: "storage.tabs.voice" },
];

const truncateName = (s: string, max = 32): string => {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
};

const { thumbnails: mediaThumbnails } = useMediaThumbnails(mediaEntries);
</script>

<template>
  <ChatStorageDetail
    v-if="selectedRoom"
    :room="selectedRoom"
    :global-total="tabBreakdown.total"
    @back="selectedRoom = null"
    @cleared="handleChatCleared"
    @preview="previewEntry = $event"
  />

  <div v-else class="space-y-6 p-4 pb-safe">
    <!-- ════════ Header: total usage + breakdown matching tabs ════════ -->
    <SettingsSection :title="t('storage.title')" :description="t('storage.description')">
      <div class="rounded-xl border border-neutral-grad-0 bg-background-secondary-theme p-4">
        <div class="flex items-baseline justify-between">
          <span class="text-sm text-text-on-main-bg-color">{{ t('storage.used') }}</span>
          <span class="text-base font-semibold text-text-color">{{ totalFormatted }}</span>
        </div>

        <!-- Stacked bar by tab category (media / file / voice) -->
        <div class="mt-3 flex h-2 w-full overflow-hidden rounded-full bg-neutral-grad-0">
          <div
            v-if="tabBreakdown.media > 0"
            class="h-full bg-color-bg-ac transition-all"
            :style="{ width: percentBy(tabBreakdown.media) + '%' }"
          />
          <div
            v-if="tabBreakdown.voice > 0"
            class="h-full bg-color-star-yellow transition-all"
            :style="{ width: percentBy(tabBreakdown.voice) + '%' }"
          />
          <div
            v-if="tabBreakdown.file > 0"
            class="h-full bg-text-on-main-bg-color/40 transition-all"
            :style="{ width: percentBy(tabBreakdown.file) + '%' }"
          />
        </div>

        <!-- Per-category rows matching the tab labels exactly -->
        <div class="mt-4 space-y-2">
          <div class="flex items-center gap-2 text-sm">
            <span class="inline-block h-2.5 w-2.5 rounded-full bg-color-bg-ac" />
            <span class="text-text-color">{{ t('storage.tabs.media') }}</span>
            <span class="text-xs text-text-on-main-bg-color">{{ percentBy(tabBreakdown.media) }}%</span>
            <span class="ml-auto text-text-color">{{ formatBytes(tabBreakdown.media) }}</span>
          </div>
          <div class="flex items-center gap-2 text-sm">
            <span class="inline-block h-2.5 w-2.5 rounded-full bg-color-star-yellow" />
            <span class="text-text-color">{{ t('storage.tabs.voice') }}</span>
            <span class="text-xs text-text-on-main-bg-color">{{ percentBy(tabBreakdown.voice) }}%</span>
            <span class="ml-auto text-text-color">{{ formatBytes(tabBreakdown.voice) }}</span>
          </div>
          <div class="flex items-center gap-2 text-sm">
            <span class="inline-block h-2.5 w-2.5 rounded-full bg-text-on-main-bg-color/40" />
            <span class="text-text-color">{{ t('storage.tabs.files') }}</span>
            <span class="text-xs text-text-on-main-bg-color">{{ percentBy(tabBreakdown.file) }}%</span>
            <span class="ml-auto text-text-color">{{ formatBytes(tabBreakdown.file) }}</span>
          </div>
        </div>
      </div>
    </SettingsSection>

    <!-- ════════ Tabs ════════ -->
    <div>
      <div class="flex gap-1 overflow-x-auto border-b border-neutral-grad-0">
        <button
          v-for="tab in TABS"
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

      <!-- ─── Chats tab ─── -->
      <div v-if="activeTab === 'chats'" class="mt-3">
        <div v-if="roomUsage.length === 0" class="rounded-xl bg-background-secondary-theme py-10 text-center text-sm text-text-on-main-bg-color">
          {{ t('storage.empty') }}
        </div>
        <ul v-else class="overflow-hidden rounded-xl bg-background-secondary-theme">
          <li
            v-for="(room, idx) in roomUsage"
            :key="room.roomId"
            class="flex w-full items-center gap-3 px-3 py-2.5 transition-colors hover:bg-neutral-grad-0/50 cursor-pointer"
            :class="idx > 0 ? 'border-t border-neutral-grad-0' : ''"
            role="button"
            @click="selectedRoom = room"
          >
            <Avatar
              :src="displayRoom(room.roomId).avatar"
              :name="displayRoom(room.roomId).name"
              size="md"
            />
            <div class="min-w-0 flex-1">
              <div class="truncate text-sm font-medium text-text-color">
                {{ displayRoom(room.roomId).name }}
              </div>
              <div class="mt-0.5 text-xs text-text-on-main-bg-color">
                {{ t('storage.itemCount', { n: room.count }) }}
              </div>
            </div>
            <div class="text-sm font-medium text-text-color">{{ formatBytes(room.totalBytes) }}</div>
            <svg
              width="16" height="16" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2"
              class="shrink-0 text-text-on-main-bg-color"
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </li>
        </ul>
      </div>

      <!-- ─── Media tab (real thumbnails, tap to preview) ─── -->
      <div v-else-if="activeTab === 'media'" class="mt-3">
        <div v-if="mediaEntries.length === 0" class="rounded-xl bg-background-secondary-theme py-10 text-center text-sm text-text-on-main-bg-color">
          {{ t('storage.empty') }}
        </div>
        <ul v-else class="overflow-hidden rounded-xl bg-background-secondary-theme">
          <li
            v-for="(entry, idx) in mediaEntries"
            :key="entry.mxc"
            class="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-neutral-grad-0/50 cursor-pointer"
            :class="idx > 0 ? 'border-t border-neutral-grad-0' : ''"
            role="button"
            @click="previewEntry = entry"
          >
            <div
              v-if="mediaThumbnails[entry.mxc]"
              class="h-10 w-10 shrink-0 overflow-hidden rounded-lg bg-neutral-grad-0"
            >
              <img :src="mediaThumbnails[entry.mxc]" alt="" class="h-full w-full object-cover" />
            </div>
            <div
              v-else
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
            <div class="min-w-0 flex-1">
              <div class="truncate text-sm font-medium text-text-color">{{ truncateName(displayName(entry, t)) }}</div>
              <div class="mt-0.5 truncate text-xs text-text-on-main-bg-color">{{ displayRoom(entry.roomId).name }}</div>
            </div>
            <div class="text-sm font-medium text-text-color">{{ formatBytes(entry.size) }}</div>
          </li>
        </ul>
      </div>

      <!-- ─── Files tab ─── -->
      <div v-else-if="activeTab === 'file'" class="mt-3">
        <div v-if="fileEntries.length === 0" class="rounded-xl bg-background-secondary-theme py-10 text-center text-sm text-text-on-main-bg-color">
          {{ t('storage.empty') }}
        </div>
        <ul v-else class="overflow-hidden rounded-xl bg-background-secondary-theme">
          <li
            v-for="(entry, idx) in fileEntries"
            :key="entry.mxc"
            class="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-neutral-grad-0/50 cursor-pointer"
            :class="idx > 0 ? 'border-t border-neutral-grad-0' : ''"
            role="button"
            @click="previewEntry = entry"
          >
            <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-text-on-main-bg-color/15 text-text-on-main-bg-color">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
            </div>
            <div class="min-w-0 flex-1">
              <div class="truncate text-sm font-medium text-text-color">{{ truncateName(displayName(entry, t)) }}</div>
              <div class="mt-0.5 truncate text-xs text-text-on-main-bg-color">{{ displayRoom(entry.roomId).name }}</div>
            </div>
            <div class="text-sm font-medium text-text-color">{{ formatBytes(entry.size) }}</div>
          </li>
        </ul>
      </div>

      <!-- ─── Voice tab (neutral icon, tap to play) ─── -->
      <div v-else-if="activeTab === 'voice'" class="mt-3">
        <div v-if="voiceEntries.length === 0" class="rounded-xl bg-background-secondary-theme py-10 text-center text-sm text-text-on-main-bg-color">
          {{ t('storage.empty') }}
        </div>
        <ul v-else class="overflow-hidden rounded-xl bg-background-secondary-theme">
          <li
            v-for="(entry, idx) in voiceEntries"
            :key="entry.mxc"
            class="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-neutral-grad-0/50 cursor-pointer"
            :class="idx > 0 ? 'border-t border-neutral-grad-0' : ''"
            role="button"
            @click="previewEntry = entry"
          >
            <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-color-bg-ac/15 text-color-bg-ac">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
            </div>
            <div class="min-w-0 flex-1">
              <div class="truncate text-sm font-medium text-text-color">{{ truncateName(displayName(entry, t)) }}</div>
              <div class="mt-0.5 truncate text-xs text-text-on-main-bg-color">{{ displayRoom(entry.roomId).name }}</div>
            </div>
            <div class="text-sm font-medium text-text-color">{{ formatBytes(entry.size) }}</div>
          </li>
        </ul>
      </div>
    </div>

    <!-- ════════ Cache limit slider ════════ -->
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

    <!-- ════════ Danger zone ════════ -->
    <SettingsSection :title="t('storage.clearTitle')" :description="t('storage.clearDescription')">
      <button
        class="w-full rounded-lg border border-color-bad/30 px-4 py-3 text-sm font-medium text-color-bad transition-colors hover:bg-color-bad/5 disabled:opacity-50"
        :disabled="clearing || tabBreakdown.total === 0"
        @click="showClearConfirm = true"
      >
        {{ clearing ? t('storage.clearing') : t('storage.clearAll') }}
      </button>
    </SettingsSection>

    <!-- Confirm: clear everything -->
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
              @click="handleClearAll"
            >
              {{ t('storage.clearAll') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>

  <!-- Global preview overlay (image / video viewer, audio player, file opener) -->
  <StoragePreview
    v-if="previewEntry"
    :entry="previewEntry"
    @close="previewEntry = null"
    @deleted="handleEntryDeleted"
  />
</template>
