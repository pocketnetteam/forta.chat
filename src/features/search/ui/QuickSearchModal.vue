<script setup lang="ts">
import { useChatStore, getRoomTitleForUI, RoomAvatar, roomTitleGaveUpIds } from "@/entities/chat";
import type { ChatRoom } from "@/entities/chat";
import { useResolvedRoomName } from "@/entities/chat/lib/use-resolved-room-name";
import { splitByQuery } from "@/shared/lib/utils/highlight";
import { useSearch } from "../model/use-search";
import { useFormatPreview } from "@/shared/lib/utils/format-preview";

const emit = defineEmits<{ close: []; selectRoom: [roomId: string] }>();

const chatStore = useChatStore();
const { query, chatResults, clearSearch } = useSearch();
const { t } = useI18n();
const { formatPreview } = useFormatPreview();
const { resolve: resolveRoomName } = useResolvedRoomName();

function roomTitleText(room: ChatRoom): string {
  return getRoomTitleForUI(resolveRoomName(room), {
    gaveUp: roomTitleGaveUpIds.value.has(room.id),
    roomId: room.id,
    fallbackPrefix: t("common.encryptedChat"),
  }).text;
}

const inputRef = ref<HTMLInputElement>();
const listRef = ref<HTMLElement>();
const selectedIndex = ref(0);

// Recent chats when query is empty
const recentRooms = computed(() => chatStore.sortedRooms.slice(0, 8));

// Active list: filtered or recent
const displayRooms = computed(() =>
  query.value.trim() ? chatResults.value : recentRooms.value
);

// Reset selection when results change
watch(displayRooms, () => {
  selectedIndex.value = 0;
});

// Scroll selected item into view
watch(selectedIndex, (idx) => {
  if (!listRef.value) return;
  // +1 offset for the section label div
  const el = listRef.value.children[idx + 1] as HTMLElement;
  el?.scrollIntoView({ block: "nearest" });
});

onMounted(() => {
  nextTick(() => inputRef.value?.focus());
});

const handleKeydown = (e: KeyboardEvent) => {
  const len = displayRooms.value.length;
  if (!len) return;

  if (e.key === "ArrowDown") {
    e.preventDefault();
    selectedIndex.value = (selectedIndex.value + 1) % len;
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    selectedIndex.value = (selectedIndex.value - 1 + len) % len;
  } else if (e.key === "Enter") {
    e.preventDefault();
    const room = displayRooms.value[selectedIndex.value];
    if (room) selectRoom(room);
  }
};

const selectRoom = (room: ChatRoom) => {
  chatStore.setActiveRoom(room.id);
  clearSearch();
  emit("selectRoom", room.id);
  emit("close");
};

const handleBackdropClick = () => {
  clearSearch();
  emit("close");
};
</script>

<template>
  <Teleport to="body">
    <transition name="modal-fade">
      <div
        class="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
        @keydown.escape="handleBackdropClick"
      >
        <!-- Backdrop -->
        <div class="absolute inset-0 bg-black/50" @click="handleBackdropClick" />

        <!-- Modal -->
        <div
          class="relative w-full max-w-[480px] overflow-hidden rounded-xl border border-neutral-grad-0 bg-chat-sidebar shadow-2xl"
          @keydown="handleKeydown"
        >
          <!-- Search input -->
          <div class="flex items-center gap-3 border-b border-neutral-grad-0 px-4 py-3">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="shrink-0 text-text-on-main-bg-color">
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              ref="inputRef"
              v-model="query"
              :placeholder="t('quickSearch.placeholder')"
              class="min-w-0 flex-1 bg-transparent text-sm text-text-color outline-none placeholder:text-neutral-grad-2"
            />
            <kbd class="hidden rounded bg-neutral-grad-0 px-1.5 py-0.5 text-[10px] text-text-on-main-bg-color sm:inline">ESC</kbd>
          </div>

          <!-- Results -->
          <div ref="listRef" class="max-h-[340px] overflow-y-auto py-1">
            <div class="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-on-main-bg-color">
              {{ query.trim() ? t('quickSearch.chats') : t('quickSearch.recent') }}
            </div>

            <button
              v-for="(room, i) in displayRooms"
              :key="room.id"
              class="flex w-full items-center gap-3 px-4 py-2 text-left transition-colors"
              :class="i === selectedIndex ? 'bg-neutral-grad-0' : 'hover:bg-neutral-grad-0/50'"
              @click="selectRoom(room)"
              @mouseenter="selectedIndex = i"
            >
              <RoomAvatar
                :room="room"
                :initials-name="roomTitleText(room)"
                size="sm"
                eager
              />
              <div class="min-w-0 flex-1">
                <div class="truncate text-sm font-medium text-text-color">
                  <template v-if="query.trim()">
                    <template v-for="(part, j) in splitByQuery(roomTitleText(room), query.trim())" :key="j">
                      <mark v-if="part.highlight" class="rounded-sm bg-color-txt-ac/20 font-semibold text-color-txt-ac">{{ part.text }}</mark>
                      <span v-else>{{ part.text }}</span>
                    </template>
                  </template>
                  <span v-else>{{ roomTitleText(room) }}</span>
                </div>
                <div class="truncate text-xs text-text-on-main-bg-color">
                  {{ formatPreview(room.lastMessage, room) }}
                </div>
              </div>
            </button>

            <!-- No results -->
            <div
              v-if="query.trim() && !displayRooms.length"
              class="px-4 py-6 text-center text-sm text-text-on-main-bg-color"
            >
              {{ t('quickSearch.noResults') }}
            </div>
          </div>
        </div>
      </div>
    </transition>
  </Teleport>
</template>

<style scoped>
.modal-fade-enter-active {
  transition: opacity 0.15s ease-out;
}
.modal-fade-enter-active > :last-child {
  transition: transform 0.15s ease-out, opacity 0.15s ease-out;
}
.modal-fade-leave-active {
  transition: opacity 0.1s ease-in;
}
.modal-fade-enter-from {
  opacity: 0;
}
.modal-fade-enter-from > :last-child {
  transform: scale(0.95);
  opacity: 0;
}
.modal-fade-leave-to {
  opacity: 0;
}
</style>
