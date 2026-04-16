<script setup lang="ts">
import { useContacts } from "../model/use-contacts";
import { useChatStore } from "@/entities/chat";
import type { ChatRoom } from "@/entities/chat";
import { UserAvatar } from "@/entities/user";
import Avatar from "@/shared/ui/avatar/Avatar.vue";
import { splitByQuery } from "@/shared/lib/utils/highlight";
import { useSearch, type MessageSearchResult } from "@/features/search";
import { formatRelativeTime } from "@/shared/lib/format";
import { useFormatPreview } from "@/shared/lib/utils/format-preview";
import { useResolvedRoomName } from "@/entities/chat/lib/use-resolved-room-name";
import { isUnresolvedName } from "@/entities/chat/lib/chat-helpers";

const props = defineProps<{ query: string }>();

const emit = defineEmits<{
  roomCreated: [roomId: string];
  selectMessage: [payload: { roomId: string; messageId: string }];
  clear: [];
}>();

const { searchResults, searchError, isSearching, isCreatingRoom, debouncedSearch, getOrCreateRoom } = useContacts();
const chatStore = useChatStore();
const { t } = useI18n();
const { formatPreview } = useFormatPreview();
const { resolve: resolveRoomName } = useResolvedRoomName();

// Use the shared search composable for chat and message results
const search = useSearch();

// Sync query prop into the search composable
watch(() => props.query, (q) => {
  search.query.value = q;
  debouncedSearch(q);  // triggers user API search
}, { immediate: true });

// Section expansion
const showAllChats = ref(false);
const showAllUsers = ref(false);
const showAllMessages = ref(false);

// Reset expansion when query changes
watch(() => props.query, () => {
  showAllChats.value = false;
  showAllUsers.value = false;
  showAllMessages.value = false;
});

const visibleChats = computed(() =>
  showAllChats.value ? search.chatResults.value : search.chatResults.value.slice(0, 5)
);

const visibleUsers = computed(() =>
  showAllUsers.value ? searchResults.value : searchResults.value.slice(0, 5)
);

const visibleMessages = computed(() =>
  showAllMessages.value ? search.messageResults.value : search.messageResults.value.slice(0, 5)
);

const handleSelectRoom = (room: ChatRoom) => {
  chatStore.setActiveRoom(room.id);
  emit("roomCreated", room.id);
};

const handleSelectUser = async (address: string) => {
  const roomId = await getOrCreateRoom(address);
  if (roomId) {
    emit("roomCreated", roomId);
  }
};

const handleSelectMessage = (result: MessageSearchResult) => {
  emit("selectMessage", { roomId: result.room.id, messageId: result.message.id });
};
</script>

<template>
  <div class="flex flex-col gap-1 overflow-y-auto px-1">
    <!-- Loading -->
    <div v-if="isSearching" class="flex items-center justify-center gap-2 p-3 text-sm text-text-on-main-bg-color">
      <svg class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
      </svg>
      {{ t("contactSearch.searching") }}
    </div>

    <!-- Creating room -->
    <div v-if="isCreatingRoom" class="flex items-center justify-center gap-2 p-3 text-sm text-text-on-main-bg-color">
      <svg class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
      </svg>
      {{ t("contactSearch.openingChat") }}
    </div>

    <!-- CHATS section -->
    <div v-if="visibleChats.length">
      <div class="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-on-main-bg-color">
        {{ t("contactSearch.chats") }}
      </div>
      <button
        v-for="room in visibleChats"
        :key="room.id"
        class="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-all hover:bg-neutral-grad-0 active:scale-[0.98]"
        @click="handleSelectRoom(room)"
      >
        <UserAvatar
          v-if="room.avatar?.startsWith('__pocketnet__:')"
          :address="room.avatar.replace('__pocketnet__:', '')"
          size="sm"
        />
        <Avatar v-else :src="room.avatar" :name="resolveRoomName(room)" size="sm" />
        <div class="min-w-0 flex-1">
          <div class="truncate text-[15px] font-medium text-text-color">
            <span v-if="isUnresolvedName(resolveRoomName(room))" class="inline-block h-4 w-24 animate-pulse rounded bg-neutral-grad-2" />
            <template v-else v-for="(part, j) in splitByQuery(resolveRoomName(room), query.trim())" :key="j">
              <mark v-if="part.highlight" class="rounded-sm bg-color-txt-ac/20 font-semibold text-color-txt-ac">{{ part.text }}</mark>
              <span v-else>{{ part.text }}</span>
            </template>
          </div>
          <div class="truncate text-xs text-text-on-main-bg-color">
            {{ formatPreview(room.lastMessage, room) }}
          </div>
        </div>
        <span v-if="room.lastMessage" class="shrink-0 text-xs text-text-on-main-bg-color">
          {{ formatRelativeTime(new Date(room.lastMessage.timestamp)) }}
        </span>
      </button>
      <button
        v-if="search.chatResults.value.length > 5 && !showAllChats"
        class="w-full px-3 py-1.5 text-left text-xs font-medium text-color-txt-ac hover:underline"
        @click="showAllChats = true"
      >
        {{ t("contactSearch.showMore") }}
      </button>
    </div>

    <!-- USERS section -->
    <div v-if="visibleUsers.length">
      <div class="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-on-main-bg-color">
        {{ t("contactSearch.users") }}
      </div>
      <button
        v-for="user in visibleUsers"
        :key="user.address"
        class="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-all hover:bg-neutral-grad-0 active:scale-[0.98]"
        :disabled="isCreatingRoom"
        @click="handleSelectUser(user.address)"
      >
        <UserAvatar :address="user.address" size="sm" />
        <div class="min-w-0 flex-1">
          <div class="truncate text-sm font-medium text-text-color">
            <template v-for="(part, j) in splitByQuery(user.name, query.trim())" :key="j">
              <mark v-if="part.highlight" class="rounded-sm bg-color-txt-ac/20 font-semibold text-color-txt-ac">{{ part.text }}</mark>
              <span v-else>{{ part.text }}</span>
            </template>
          </div>
          <div class="truncate text-xs text-text-on-main-bg-color">{{ user.address }}</div>
        </div>
      </button>
      <button
        v-if="searchResults.length > 5 && !showAllUsers"
        class="w-full px-3 py-1.5 text-left text-xs font-medium text-color-txt-ac hover:underline"
        @click="showAllUsers = true"
      >
        {{ t("contactSearch.showMore") }}
      </button>
    </div>

    <!-- MESSAGES section -->
    <div v-if="visibleMessages.length">
      <div class="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-on-main-bg-color">
        {{ t("contactSearch.messages") }}
      </div>
      <button
        v-for="result in visibleMessages"
        :key="result.message.id"
        class="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-all hover:bg-neutral-grad-0 active:scale-[0.98]"
        @click="handleSelectMessage(result)"
      >
        <UserAvatar
          v-if="result.room.avatar?.startsWith('__pocketnet__:')"
          :address="result.room.avatar.replace('__pocketnet__:', '')"
          size="sm"
        />
        <Avatar v-else :src="result.room.avatar" :name="resolveRoomName(result.room)" size="sm" />
        <div class="min-w-0 flex-1">
          <div v-if="isUnresolvedName(resolveRoomName(result.room))" class="h-3 w-20 animate-pulse rounded bg-neutral-grad-2" />
          <div v-else class="truncate text-xs font-medium text-text-on-main-bg-color">{{ resolveRoomName(result.room) }}</div>
          <div class="truncate text-sm text-text-color">
            <template v-for="(part, j) in splitByQuery(result.message.content, query.trim())" :key="j">
              <mark v-if="part.highlight" class="rounded-sm bg-color-txt-ac/20 font-semibold text-color-txt-ac">{{ part.text }}</mark>
              <span v-else>{{ part.text }}</span>
            </template>
          </div>
        </div>
        <span class="shrink-0 text-xs text-text-on-main-bg-color">
          {{ formatRelativeTime(new Date(result.message.timestamp)) }}
        </span>
      </button>
      <button
        v-if="search.messageResults.value.length > 5 && !showAllMessages"
        class="w-full px-3 py-1.5 text-left text-xs font-medium text-color-txt-ac hover:underline"
        @click="showAllMessages = true"
      >
        {{ t("contactSearch.showMore") }}
      </button>
    </div>

    <!-- No results / service error -->
    <div
      v-if="!visibleChats.length && !visibleUsers.length && !visibleMessages.length && !isSearching"
      class="flex flex-col items-center gap-2 py-8 text-sm text-text-on-main-bg-color"
    >
      <span>{{ searchError ? t(searchError) : t("contactSearch.noResults") }}</span>
      <button
        class="text-color-txt-ac hover:underline"
        @click="emit('clear')"
      >
        {{ t("contactSearch.clearSearch") }}
      </button>
    </div>
  </div>
</template>
