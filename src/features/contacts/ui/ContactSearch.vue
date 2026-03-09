<script setup lang="ts">
import { useContacts } from "../model/use-contacts";
import { useChatStore } from "@/entities/chat";
import type { ChatRoom } from "@/entities/chat";
import { UserAvatar } from "@/entities/user";
import { formatRelativeTime } from "@/shared/lib/format";
import Avatar from "@/shared/ui/avatar/Avatar.vue";

const { searchQuery, searchResults, isSearching, isCreatingRoom, debouncedSearch, getOrCreateRoom } = useContacts();
const chatStore = useChatStore();
const { t } = useI18n();
const searchInputRef = ref<HTMLInputElement>();

onMounted(() => {
  nextTick(() => searchInputRef.value?.focus());
});

const emit = defineEmits<{
  select: [address: string];
  roomCreated: [roomId: string];
}>();

const handleInput = () => {
  debouncedSearch(searchQuery.value);
};

const handleSelectUser = async (address: string) => {
  emit("select", address);
  const roomId = await getOrCreateRoom(address);
  if (roomId) {
    emit("roomCreated", roomId);
    searchQuery.value = "";
    searchResults.value = [];
  }
};

const handleSelectRoom = (room: ChatRoom) => {
  chatStore.setActiveRoom(room.id);
  emit("roomCreated", room.id);
  searchQuery.value = "";
  searchResults.value = [];
};

/** Rooms matching the search query — searches by name, resolved name, and member address */
const matchingRooms = computed(() => {
  const q = searchQuery.value.toLowerCase().trim();
  if (!q) return [];
  return chatStore.sortedRooms.filter(r => {
    // Match by stored room name
    if (r.name.toLowerCase().includes(q)) return true;
    // Match by member address (from avatar for 1:1 chats)
    if (r.avatar?.startsWith("__pocketnet__:")) {
      const addr = r.avatar.slice("__pocketnet__:".length);
      if (addr.toLowerCase().includes(q)) return true;
    }
    // Match by any member address
    if (r.members.some(m => m.toLowerCase().includes(q))) return true;
    return false;
  });
});
</script>

<template>
  <div class="flex flex-col gap-2">
    <input
      ref="searchInputRef"
      v-model="searchQuery"
      :placeholder="t('contactSearch.placeholder')"
      class="rounded-lg bg-chat-input-bg px-3 py-2 text-sm text-text-color outline-none placeholder:text-neutral-grad-2"
      @input="handleInput"
    />

    <div v-if="isSearching" class="flex items-center justify-center gap-2 p-3 text-sm text-text-on-main-bg-color">
      <svg class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
      </svg>
      {{ t("contactSearch.searching") }}
    </div>

    <div v-else-if="isCreatingRoom" class="flex items-center justify-center gap-2 p-3 text-sm text-text-on-main-bg-color">
      <svg class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
      </svg>
      {{ t("contactSearch.openingChat") }}
    </div>

    <template v-else-if="searchQuery">
      <!-- Matching chats section -->
      <div v-if="matchingRooms.length" class="max-h-48 space-y-0.5 overflow-y-auto">
        <div class="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-text-on-main-bg-color">{{ t("contactSearch.chats") }}</div>
        <button
          v-for="room in matchingRooms"
          :key="room.id"
          class="flex w-full items-center gap-3 rounded-lg p-2 text-left transition-all hover:bg-neutral-grad-0 active:scale-[0.98] active:bg-neutral-grad-0"
          @click="handleSelectRoom(room)"
        >
          <UserAvatar
            v-if="room.avatar?.startsWith('__pocketnet__:')"
            :address="room.avatar.replace('__pocketnet__:', '')"
            size="sm"
          />
          <Avatar v-else :src="room.avatar" :name="room.name" size="sm" />
          <div class="min-w-0 flex-1">
            <div class="truncate text-[15px] font-medium text-text-color">{{ room.name }}</div>
            <div class="truncate text-xs text-text-on-main-bg-color">
              {{ room.lastMessage?.content || "" }}
            </div>
          </div>
          <span
            v-if="room.lastMessage"
            class="shrink-0 text-xs text-text-on-main-bg-color"
          >
            {{ formatRelativeTime(new Date(room.lastMessage.timestamp)) }}
          </span>
        </button>
      </div>

      <!-- User search results section -->
      <div v-if="searchResults.length" class="max-h-48 space-y-0.5 overflow-y-auto">
        <div class="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-text-on-main-bg-color">{{ t("contactSearch.users") }}</div>
        <button
          v-for="user in searchResults"
          :key="user.address"
          class="flex w-full items-center gap-3 rounded-lg p-2 text-left transition-all hover:bg-neutral-grad-0 active:scale-[0.98] active:bg-neutral-grad-0"
          :disabled="isCreatingRoom"
          @click="handleSelectUser(user.address)"
        >
          <UserAvatar :address="user.address" size="sm" />
          <div class="min-w-0 flex-1">
            <div class="truncate text-sm font-medium text-text-color">{{ user.name }}</div>
            <div class="truncate text-xs text-text-on-main-bg-color">{{ user.address }}</div>
          </div>
        </button>
      </div>

      <!-- No results -->
      <div
        v-if="!matchingRooms.length && !searchResults.length && !isSearching"
        class="p-3 text-center text-sm text-text-on-main-bg-color"
      >
        {{ t("contactSearch.noResults") }}
      </div>
    </template>
  </div>
</template>
