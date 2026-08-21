<script setup lang="ts">
import { useAiChatStore } from "@/entities/ai-chat";
import { useChatStore } from "@/entities/chat";
import { useChannelStore } from "@/entities/channel";
import { useLocalAiStore } from "@/entities/local-ai";
import { useAuthStore } from "@/entities/auth";
import { formatRelativeTime } from "@/shared/lib/format";
import { RecycleScroller } from "vue-virtual-scroller";
import "vue-virtual-scroller/dist/vue-virtual-scroller.css";
import type { AiChat } from "@/entities/ai-chat";
import { useLongPress } from "@/shared/lib/gestures";
import { ContextMenu } from "@/shared/ui/context-menu";
import type { ContextMenuItem } from "@/shared/ui/context-menu";
import { hapticImpact } from "@/shared/lib/haptics";

const aiChatStore = useAiChatStore();
const chatStore = useChatStore();
const channelStore = useChannelStore();
const localAiStore = useLocalAiStore();
const authStore = useAuthStore();
const { t } = useI18n();

const emit = defineEmits<{ selectChat: [chatId: string]; modelNotReady: [] }>();

const ITEM_HEIGHT = 68;

const handleSelect = async (chat: AiChat) => {
  // modelReady only reflects "already downloaded" once something has run
  // restoreModelIfPreviouslyDownloaded() this session — if this is the very
  // first AI-related tap this session, check it here first so an
  // already-set-up device doesn't get redirected to Settings by mistake.
  // Cheap/fast when there's nothing to restore (see that function's own doc
  // comment).
  if (!localAiStore.modelReady && authStore.address) {
    await localAiStore.restoreModelIfPreviouslyDownloaded(authStore.address).catch(() => {});
  }
  // The model isn't configured/downloaded yet — send the user to the setup
  // screen (Settings → Local AI) instead of an AI chat that can't answer
  // anything yet. The widget layer owns the actual navigation (it needs
  // sidebar tab state this feature doesn't depend on) — this just signals it.
  if (!localAiStore.modelReady) {
    emit("modelNotReady");
    return;
  }
  aiChatStore.selectChat(chat.id);
  // Only one content pane can be active at a time — mirrors
  // ContactList/ChannelList's own cross-clearing (ChatWindow's own watch is
  // defense-in-depth, not the only clear point).
  chatStore.setActiveRoom(null);
  channelStore.clearActiveChannel();
  emit("selectChat", chat.id);
};

// Delete-chat menu (right-click or long-press) — mirrors ContactList's
// per-room ContextMenu pattern. AI chats only need a single action, so no
// selection mode is needed here, just the direct menu → confirm flow.
const deleteIcon =
  '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>';

const ctxMenu = ref<{ show: boolean; x: number; y: number; chatId: string | null }>({
  show: false,
  x: 0,
  y: 0,
  chatId: null,
});

// Menu item stays the plain imperative "Delete" (contactList.delete, reused
// from ContactList's own context menu) — the "Delete chat?" question belongs
// on the confirmation dialog's title, not the trigger action.
const ctxMenuItems: ContextMenuItem[] = [
  { label: t("contactList.delete"), icon: deleteIcon, action: "delete", danger: true },
];

const openCtxMenu = (e: MouseEvent, chat: AiChat) => {
  ctxMenu.value = { show: true, x: e.clientX, y: e.clientY, chatId: chat.id };
};

const deleteConfirm = ref<{ show: boolean; chatId: string | null }>({ show: false, chatId: null });

const handleCtxAction = (action: string) => {
  const chatId = ctxMenu.value.chatId;
  if (!chatId) return;
  if (action === "delete") deleteConfirm.value = { show: true, chatId };
  ctxMenu.value.show = false;
};

const closeDeleteConfirm = () => {
  deleteConfirm.value = { show: false, chatId: null };
};

const confirmDeleteChat = async () => {
  const chatId = deleteConfirm.value.chatId;
  closeDeleteConfirm();
  if (chatId) await aiChatStore.deleteChat(chatId);
};

// Per-chat long press: one cached handler per chat id, same pattern as
// ContactList's `longPressCache` — opens the menu directly (no selection
// mode, unlike ContactList, since delete is the only action here).
const longPressCache = new Map<string, ReturnType<typeof useLongPress>>();
let suppressContextMenu = false;

const getChatLongPress = (chat: AiChat) => {
  let handlers = longPressCache.get(chat.id);
  if (!handlers) {
    handlers = useLongPress({
      onTrigger: (e: PointerEvent) => {
        suppressContextMenu = true;
        ctxMenu.value = { show: true, x: e.clientX, y: e.clientY, chatId: chat.id };
        hapticImpact("MEDIUM").catch(() => {});
        setTimeout(() => { suppressContextMenu = false; }, 50);
      },
    });
    longPressCache.set(chat.id, handlers);
  }
  return handlers;
};

const onChatContextMenu = (e: MouseEvent, chat: AiChat) => {
  if (suppressContextMenu) return;
  openCtxMenu(e, chat);
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
          @contextmenu.prevent="(e: MouseEvent) => onChatContextMenu(e, chat as AiChat)"
          @pointerdown="(e: PointerEvent) => getChatLongPress(chat as AiChat).onPointerdown(e)"
          @pointermove="(e: PointerEvent) => getChatLongPress(chat as AiChat).onPointermove(e)"
          @pointerup="() => getChatLongPress(chat as AiChat).onPointerup()"
          @pointerleave="() => getChatLongPress(chat as AiChat).onPointerleave()"
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

    <!-- AI chat context menu (right-click / long-press) -->
    <ContextMenu
      :show="ctxMenu.show"
      :x="ctxMenu.x"
      :y="ctxMenu.y"
      :items="ctxMenuItems"
      @close="ctxMenu.show = false"
      @select="handleCtxAction"
    />

    <!-- Delete chat confirmation modal -->
    <Teleport to="body">
      <transition name="fade">
        <div
          v-if="deleteConfirm.show"
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          @click.self="closeDeleteConfirm"
        >
          <div class="w-full max-w-xs rounded-xl bg-background-total-theme p-5 shadow-xl">
            <h3 class="mb-3 text-base font-semibold text-text-color">{{ t("ai.deleteChat") }}</h3>
            <p class="mb-4 text-sm text-text-on-main-bg-color">{{ t("ai.deleteChatConfirm") }}</p>
            <div class="flex gap-2">
              <button
                class="flex-1 rounded-lg bg-neutral-grad-0 px-4 py-2.5 text-sm font-medium text-text-color transition-colors hover:bg-neutral-grad-2"
                @click="closeDeleteConfirm"
              >
                {{ t("contactList.cancel") }}
              </button>
              <button
                class="flex-1 rounded-lg bg-color-bad px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-color-bad/90"
                @click="confirmDeleteChat"
              >
                {{ t("contactList.delete") }}
              </button>
            </div>
          </div>
        </div>
      </transition>
    </Teleport>
  </div>
</template>
