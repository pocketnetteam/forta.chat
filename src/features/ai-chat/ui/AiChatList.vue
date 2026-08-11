<script setup lang="ts">
import { useAiChatStore } from "@/entities/ai-chat";
import { useChatStore } from "@/entities/chat";
import { useChannelStore } from "@/entities/channel";
import { formatRelativeTime } from "@/shared/lib/format";
import { RecycleScroller } from "vue-virtual-scroller";
import "vue-virtual-scroller/dist/vue-virtual-scroller.css";
import type { AiChat } from "@/entities/ai-chat";

const aiChatStore = useAiChatStore();
const chatStore = useChatStore();
const channelStore = useChannelStore();
const { t } = useI18n();

const emit = defineEmits<{ selectChat: [chatId: string] }>();

const ITEM_HEIGHT = 68;

const handleSelect = (chat: AiChat) => {
  aiChatStore.selectChat(chat.id);
  // Only one content pane can be active at a time — mirrors
  // ContactList/ChannelList's own cross-clearing (ChatWindow's own watch is
  // defense-in-depth, not the only clear point).
  chatStore.setActiveRoom(null);
  channelStore.clearActiveChannel();
  emit("selectChat", chat.id);
};
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Empty state — mirrors ChannelList's, plain text since AI chats are
         locally-created (no server error/loading states to render here). -->
    <div
      v-if="aiChatStore.chats.length === 0"
      class="flex flex-col items-center gap-3 px-6 py-12 text-center"
    >
      <div class="flex h-14 w-14 items-center justify-center rounded-full bg-neutral-grad-0">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="text-text-on-main-bg-color">
          <path d="M12 8V4H8" />
          <rect width="16" height="12" x="4" y="8" rx="2" />
          <path d="M2 14h2m16 0h2M9 13v2m6-2v2" />
        </svg>
      </div>
      <p class="text-sm text-text-on-main-bg-color">{{ t("ai.emptyState") }}</p>
      <p class="text-xs text-text-on-main-bg-color/60">{{ t("ai.emptyStateHint") }}</p>
    </div>

    <RecycleScroller
      v-else
      :items="aiChatStore.chats"
      :item-size="ITEM_HEIGHT"
      :style="{ '--recycle-item-size': `${ITEM_HEIGHT}px` }"
      key-field="id"
      class="h-full"
    >
      <template #default="{ item: chat }">
        <button
          class="flex h-[68px] w-full cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors hover:bg-neutral-grad-0 active:bg-neutral-grad-0"
          :class="chat.id === aiChatStore.activeChatId ? 'bg-color-bg-ac/10' : ''"
          @click="handleSelect(chat)"
        >
          <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-color-bg-ac/15 text-color-bg-ac">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 8V4H8" />
              <rect width="16" height="12" x="4" y="8" rx="2" />
              <path d="M2 14h2m16 0h2M9 13v2m6-2v2" />
            </svg>
          </div>

          <div class="min-w-0 flex-1">
            <div class="flex items-center justify-between gap-2">
              <span class="truncate text-[15px] font-medium text-text-color">{{ chat.title }}</span>
              <span
                v-if="chat.lastMessageTimestamp"
                class="shrink-0 text-xs text-text-on-main-bg-color"
              >{{ formatRelativeTime(new Date(chat.lastMessageTimestamp)) }}</span>
            </div>
            <div class="mt-0.5 truncate text-sm text-text-on-main-bg-color">
              {{ chat.lastMessagePreview }}
            </div>
          </div>
        </button>
      </template>
    </RecycleScroller>
  </div>
</template>
