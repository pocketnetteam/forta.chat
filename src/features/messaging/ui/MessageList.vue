<script setup lang="ts">
import { ref, computed, watch, onMounted, nextTick, onUnmounted, provide } from "vue";
import { useChatStore, MessageType } from "@/entities/chat";
import { useAuthStore } from "@/entities/auth";
import { useThemeStore } from "@/entities/theme";
import { isConsecutiveMessage } from "@/entities/chat/lib/message-utils";
import { formatDate } from "@/shared/lib/format";
import { UserAvatar } from "@/entities/user";
import { useMessages } from "../model/use-messages";
import { useToast } from "@/shared/lib/use-toast";
import MessageBubble from "./MessageBubble.vue";
import CallEventCard from "./CallEventCard.vue";
import { MessageSkeleton } from "@/shared/ui/skeleton";
import MessageContextMenu from "./MessageContextMenu.vue";
import EmojiPicker from "./EmojiPicker.vue";
import MediaViewer from "./MediaViewer.vue";
import { DynamicScroller, DynamicScrollerItem } from "vue-virtual-scroller";
import "vue-virtual-scroller/dist/vue-virtual-scroller.css";

const chatStore = useChatStore();
const authStore = useAuthStore();
const themeStore = useThemeStore();
const { loadMessages, toggleReaction, deleteMessage } = useMessages();
const { toast } = useToast();

// Provide search query for MessageContent highlighting
const searchQuery = ref("");
provide("searchQuery", searchQuery);

const handleDeleteForMe = () => {
  if (chatStore.deletingMessage) {
    deleteMessage(chatStore.deletingMessage.id, false);
    chatStore.deletingMessage = null;
  }
};

const handleDeleteForEveryone = () => {
  if (chatStore.deletingMessage) {
    deleteMessage(chatStore.deletingMessage.id, true);
    chatStore.deletingMessage = null;
  }
};

const contextMenu = ref<{ show: boolean; x: number; y: number; message: import("@/entities/chat").Message | null; isOwn: boolean }>({
  show: false, x: 0, y: 0, message: null, isOwn: false,
});

const openContextMenu = (payload: { message: import("@/entities/chat").Message; x: number; y: number }) => {
  contextMenu.value = {
    show: true,
    x: payload.x,
    y: payload.y,
    message: payload.message,
    isOwn: payload.message.senderId === authStore.address,
  };
};

const closeContextMenu = () => {
  contextMenu.value.show = false;
};

const handleContextAction = (action: string, message: import("@/entities/chat").Message) => {
  switch (action) {
    case "reply":
      chatStore.replyingTo = { id: message.id, senderId: message.senderId, content: message.content.slice(0, 150), type: message.type };
      break;
    case "copy":
      navigator.clipboard.writeText(message.content).then(() => toast("Copied to clipboard"));
      break;
    case "edit":
      chatStore.editingMessage = { id: message.id, content: message.content };
      break;
    case "delete":
      chatStore.deletingMessage = message;
      break;
    case "select":
      chatStore.enterSelectionMode(message.id);
      break;
    case "forward":
      chatStore.enterSelectionMode(message.id);
      chatStore.forwardingMessages = true;
      break;
    case "pin":
      chatStore.pinMessage?.(message.id);
      break;
  }
  closeContextMenu();
};

const handleContextReaction = (emoji: string, message: import("@/entities/chat").Message) => {
  toggleReaction(message.id, emoji);
  themeStore.addRecentEmoji(emoji);
};

const emojiPickerTarget = ref<import("@/entities/chat").Message | null>(null);
const emojiPicker = ref<{ show: boolean; x: number; y: number; mode: "reaction" | "input" }>({ show: false, x: 0, y: 0, mode: "reaction" });

const showMediaViewer = ref(false);
const mediaViewerMessageId = ref<string | null>(null);

const handleOpenMedia = (message: import("@/entities/chat").Message) => {
  mediaViewerMessageId.value = message.id;
  showMediaViewer.value = true;
};

const handleOpenEmojiPicker = (message: import("@/entities/chat").Message) => {
  emojiPickerTarget.value = message;
  emojiPicker.value = { show: true, x: contextMenu.value.x, y: contextMenu.value.y, mode: "reaction" };
};

const handleEmojiSelect = (emoji: string) => {
  if (emojiPickerTarget.value) {
    toggleReaction(emojiPickerTarget.value.id, emoji);
  }
  themeStore.addRecentEmoji(emoji);
  emojiPicker.value.show = false;
  emojiPickerTarget.value = null;
};

const listRef = ref<HTMLElement>();
const scrollerRef = ref<InstanceType<typeof DynamicScroller>>();
const isNearBottom = ref(true);
const showScrollFab = ref(false);
const loading = ref(false);
const loadingMore = ref(false);
const switching = ref(false); // true during room switch — suppresses watchers
const settled = ref(false); // false until messages loaded + scrolled — hides scroller to prevent flicker
const hasMore = ref(true);
const newMessageCount = ref(0);

/** Flatten messages + date separators into a single virtual list */
interface VirtualItem {
  id: string;
  type: "message" | "date-separator" | "typing";
  message?: import("@/entities/chat").Message;
  label?: string;
  index?: number;
}

const virtualItems = computed<VirtualItem[]>(() => {
  const msgs = chatStore.activeMessages;
  const items: VirtualItem[] = [];

  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i];
    const prevMsg = msgs[i - 1];
    const dateLabel = getDateLabel(msg.timestamp, prevMsg?.timestamp);

    if (dateLabel) {
      items.push({ id: `date-${msg.id}`, type: "date-separator", label: dateLabel });
    }

    items.push({ id: msg.id, type: "message", message: msg, index: i });
  }

  // Typing indicator
  if (typingText.value) {
    items.push({ id: "typing-indicator", type: "typing" });
  }

  return items;
});

/** Get the actual scroll container.
 *  DynamicScroller's $el IS the scrollable element (it has overflow-y: auto). */
const getScrollContainer = (): HTMLElement | null => {
  const el = scrollerRef.value?.$el as HTMLElement | undefined;
  if (el) return el;
  return listRef.value ?? null;
};

/** Check if user is scrolled near the bottom */
const checkScroll = () => {
  const el = getScrollContainer();
  if (!el) return;
  const { scrollTop, scrollHeight, clientHeight } = el;
  const distFromBottom = scrollHeight - scrollTop - clientHeight;
  isNearBottom.value = distFromBottom < 100;
  showScrollFab.value = distFromBottom > 300;
  if (isNearBottom.value) newMessageCount.value = 0;
};

const scrollToBottom = (smooth = false) => {
  newMessageCount.value = 0;
  const doScroll = () => {
    if (scrollerRef.value) {
      scrollerRef.value.scrollToBottom();
    } else if (listRef.value) {
      listRef.value.scrollTo({
        top: listRef.value.scrollHeight,
        behavior: smooth ? "smooth" : "instant",
      });
    }
  };
  nextTick(doScroll);
};

// --- Message entrance animation ---
const recentMessageIds = ref(new Set<string>());

// --- Floating date header (declared early so watches below can reference it) ---
const currentDateLabel = ref("");
const showDateHeader = ref(false);
let dateHideTimer: ReturnType<typeof setTimeout> | undefined;

// Load messages when active room changes
watch(
  () => chatStore.activeRoomId,
  async (roomId) => {
    if (roomId) {
      // Suppress length watcher + hide scroller during the whole switch
      switching.value = true;
      settled.value = false;
      newMessageCount.value = 0;
      hasMore.value = true;
      showScrollFab.value = false;
      showDateHeader.value = false;
      recentMessageIds.value.clear();
      isNearBottom.value = true;

      // Pre-load cached messages so they're ready when skeleton hides
      await chatStore.loadCachedMessages(roomId);
      loading.value = true;

      try {
        await loadMessages(roomId);
      } finally {
        loading.value = false;
      }

      // Scroll to bottom, then reveal once the DOM has painted
      scrollToBottom();
      await nextTick();
      requestAnimationFrame(() => {
        settled.value = true;
        switching.value = false;
      });
    }
  },
  { immediate: true },
);

// Auto-scroll only if user is near bottom; otherwise increment new message count
// Also track new real-time messages for entrance animation
watch(
  () => chatStore.activeMessages.length,
  (newLen, oldLen) => {
    // Skip during room switch, pagination, or bulk loads (search)
    if (switching.value || loadingMore.value) return;

    const delta = oldLen !== undefined ? newLen - oldLen : 0;
    if (delta > 10) return;

    if (isNearBottom.value) {
      scrollToBottom();
    } else if (delta > 0) {
      newMessageCount.value += delta;
    }
    // Track newly arrived messages for entrance animation (only appended, not paginated)
    if (!loading.value && oldLen !== undefined && delta > 0) {
      const msgs = chatStore.activeMessages;
      for (let i = oldLen; i < newLen; i++) {
        if (msgs[i]) recentMessageIds.value.add(msgs[i].id);
      }
      setTimeout(() => {
        const ids = chatStore.activeMessages.slice(oldLen, newLen).map(m => m.id);
        ids.forEach(id => recentMessageIds.value.delete(id));
      }, 350);
    }
  },
);

const getMsgEnterClass = (message: import("@/entities/chat").Message): string => {
  if (!recentMessageIds.value.has(message.id)) return "";
  return message.senderId === authStore.address ? "msg-enter-own" : "msg-enter-other";
};

const updateFloatingDate = () => {
  // Use first visible virtual item to determine date
  const scroller = scrollerRef.value;
  if (!scroller) return;

  // The scroller exposes $el which is the scroll container
  const scrollEl = scroller.$el as HTMLElement;
  if (!scrollEl) return;

  // Find the first date separator that's visible or just above viewport
  const dateSeps = scrollEl.querySelectorAll("[data-date-label]");
  const containerTop = scrollEl.getBoundingClientRect().top;
  let bestLabel = "";
  let bestTop = -Infinity;

  for (const el of dateSeps) {
    const rect = el.getBoundingClientRect();
    const relTop = rect.top - containerTop;
    if (relTop <= 8 && relTop > bestTop) {
      bestTop = relTop;
      bestLabel = (el as HTMLElement).dataset.dateLabel ?? "";
    }
  }

  if (bestLabel) {
    currentDateLabel.value = bestLabel;
  }

  // Show on scroll, hide after inactivity
  showDateHeader.value = true;
  clearTimeout(dateHideTimer);
  dateHideTimer = setTimeout(() => {
    showDateHeader.value = false;
  }, 1500);
};

const onScroll = () => {
  if (switching.value) return; // Ignore scroll events during room transition
  checkScroll();
  updateFloatingDate();

  // Load more when scrolled near the top
  const container = getScrollContainer();
  if (!container) return;
  const { scrollTop } = container;
  if (scrollTop < 200 && !loadingMore.value && hasMore.value) {
    const roomId = chatStore.activeRoomId;
    if (!roomId) return;
    const prevScrollHeight = container.scrollHeight;
    loadingMore.value = true;
    chatStore.loadMoreMessages(roomId).then((more) => {
      hasMore.value = more;
      loadingMore.value = false;
      nextTick(() => {
        const el = getScrollContainer();
        if (el) {
          const newScrollHeight = el.scrollHeight;
          el.scrollTop += newScrollHeight - prevScrollHeight;
        }
      });
    });
  }
};

let scrollListenEl: HTMLElement | null = null;

const attachScrollListener = () => {
  // Detach from old element if any
  if (scrollListenEl) {
    scrollListenEl.removeEventListener("scroll", onScroll);
    scrollListenEl = null;
  }
  nextTick(() => {
    scrollListenEl = getScrollContainer();
    scrollListenEl?.addEventListener("scroll", onScroll, { passive: true });
  });
};

onMounted(() => {
  scrollToBottom();
  attachScrollListener();
});

// Re-attach scroll listener when scroller appears/changes (e.g. room switch from empty → messages)
watch(
  () => scrollerRef.value,
  () => attachScrollListener(),
);

onUnmounted(() => {
  if (scrollListenEl) {
    scrollListenEl.removeEventListener("scroll", onScroll);
  }
  clearTimeout(dateHideTimer);
});

const getDateLabel = (
  timestamp: number,
  prevTimestamp?: number,
): string | null => {
  const date = new Date(timestamp);
  if (!prevTimestamp) return formatDate(date);
  const prevDate = new Date(prevTimestamp);
  if (date.toDateString() !== prevDate.toDateString()) {
    return formatDate(date);
  }
  return null;
};

const isGroup = computed(() => chatStore.activeRoom?.isGroup ?? false);

/** Typing indicator */
const typingText = computed(() => {
  const roomId = chatStore.activeRoomId;
  if (!roomId) return "";
  const typingUsers = chatStore.getTypingUsers(roomId);
  const myAddr = authStore.address ?? "";
  const others = typingUsers.filter(id => id !== myAddr);
  if (others.length === 0) return "";
  if (others.length === 1) return `${chatStore.getDisplayName(others[0])} is typing`;
  return `${others.length} people are typing`;
});

/** Scroll to a specific message and flash highlight */
const scrollToMessage = (messageId: string) => {
  const idx = virtualItems.value.findIndex(item => item.id === messageId);
  if (idx >= 0 && scrollerRef.value) {
    scrollerRef.value.scrollToItem(idx);
    // Flash highlight after scroll completes
    nextTick(() => {
      setTimeout(() => {
        const container = getScrollContainer();
        const el = container?.querySelector(`[data-message-id="${messageId}"]`) as HTMLElement | null;
        if (el) {
          el.classList.add("search-highlight");
          setTimeout(() => el.classList.remove("search-highlight"), 1500);
        }
      }, 100);
    });
  }
};

/** Expose setSearchQuery for ChatSearch integration */
const setSearchQuery = (q: string) => {
  searchQuery.value = q;
};

defineExpose({ scrollToMessage, setSearchQuery });
</script>

<template>
  <div ref="listRef" class="relative min-h-0 flex-1" :style="themeStore.chatWallpaper ? { background: themeStore.chatWallpaper } : {}">
    <!-- Floating date header (single, non-stacking) -->
    <div
      v-if="currentDateLabel && !loading"
      class="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center pt-2 transition-opacity duration-150"
      :class="showDateHeader ? 'opacity-100' : 'opacity-0'"
    >
      <span class="rounded-full bg-neutral-grad-0/80 px-3 py-1 text-xs text-text-on-main-bg-color backdrop-blur-sm">
        {{ currentDateLabel }}
      </span>
    </div>

    <!-- Loading state -->
    <MessageSkeleton v-if="loading" />

    <!-- Empty state -->
    <div
      v-else-if="chatStore.activeMessages.length === 0"
      class="flex h-full flex-col items-center justify-center gap-2 text-text-on-main-bg-color"
    >
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" class="opacity-20">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
      <span class="text-sm">No messages yet. Start a conversation!</span>
    </div>

    <!-- Virtualized Messages -->
    <DynamicScroller
      v-else
      ref="scrollerRef"
      :items="virtualItems"
      :min-item-size="48"
      key-field="id"
      class="h-full overflow-y-auto px-4 py-3"
      :style="{ opacity: settled ? 1 : 0 }"
    >
      <template #default="{ item, index, active }">
        <DynamicScrollerItem
          :item="item"
          :active="active"
          :data-index="index"
          :size-dependencies="[
            item.type === 'message' ? item.message?.content : item.label,
            item.message?.fileInfo?.w,
            item.message?.reactions ? Object.keys(item.message.reactions).length : 0,
          ]"
        >
          <!-- Pagination happens silently (Telegram-style, no spinner) -->

          <!-- Date separator (use padding instead of margin — DynamicScroller ignores margins) -->
          <div
            v-if="item.type === 'date-separator'"
            class="flex justify-center py-3"
            :data-date-label="item.label"
          >
            <span class="rounded-full bg-neutral-grad-0/80 px-3 py-1 text-xs text-text-on-main-bg-color backdrop-blur-sm">
              {{ item.label }}
            </span>
          </div>

          <!-- Call event card (bubble-style, aligned like a message) -->
          <div
            v-else-if="item.type === 'message' && item.message?.callInfo"
            :data-message-id="item.message.id"
            :style="(item.index ?? 0) > 0 ? { paddingTop: 'var(--message-spacing)' } : {}"
          >
            <div
              class="flex gap-2"
              :class="item.message.senderId === authStore.address ? 'flex-row-reverse' : 'flex-row'"
            >
              <!-- Avatar (incoming only) -->
              <div v-if="item.message.senderId !== authStore.address && themeStore.showAvatarsInChat" class="shrink-0 self-end">
                <UserAvatar :address="item.message.senderId" size="sm" />
              </div>
              <div class="min-w-0 max-w-[70%]">
                <CallEventCard
                  :message="item.message"
                  :is-own="item.message.senderId === authStore.address"
                  :tail-class="item.message.senderId === authStore.address ? 'rounded-br-bubble-sm' : 'rounded-bl-bubble-sm'"
                />
              </div>
            </div>
          </div>

          <!-- System message (join/leave/kick/name change) -->
          <div
            v-else-if="item.type === 'message' && item.message && item.message.type === MessageType.system"
            class="flex justify-center py-2"
            :data-message-id="item.message.id"
          >
            <span class="rounded-full bg-neutral-grad-0/60 px-3 py-1 text-center text-[11px] text-text-on-main-bg-color">
              {{ item.message.content }}
            </span>
          </div>

          <!-- Message (wrapped with padding — DynamicScroller ignores margins for height calc) -->
          <div
            v-else-if="item.type === 'message' && item.message"
            :class="getMsgEnterClass(item.message)"
            :style="(item.index ?? 0) > 0 ? { paddingTop: 'var(--message-spacing)' } : {}"
            :data-message-id="item.message.id"
          >
            <MessageBubble
              :message="item.message"
              :is-own="item.message.senderId === authStore.address"
              :is-group="isGroup"
              :show-avatar="themeStore.messageGrouping ? !isConsecutiveMessage(item.message, chatStore.activeMessages[(item.index ?? 0) + 1]) : true"
              :is-first-in-group="themeStore.messageGrouping ? !isConsecutiveMessage(chatStore.activeMessages[(item.index ?? 0) - 1], item.message) : true"
              @contextmenu="openContextMenu"
              @reply="(msg) => { chatStore.replyingTo = { id: msg.id, senderId: msg.senderId, content: msg.content.slice(0, 150), type: msg.type }; }"
              @scroll-to-reply="scrollToMessage"
              @open-media="handleOpenMedia"
              @toggle-reaction="(emoji, messageId) => toggleReaction(messageId, emoji)"
              @add-reaction="handleOpenEmojiPicker"
            >
              <template #avatar>
                <UserAvatar :address="item.message.senderId" size="sm" />
              </template>
            </MessageBubble>
          </div>

          <!-- Typing indicator -->
          <div v-else-if="item.type === 'typing'" class="flex items-center gap-2 px-10 py-1">
            <div class="flex gap-0.5">
              <span class="h-1.5 w-1.5 animate-bounce rounded-full bg-text-on-main-bg-color [animation-delay:-0.3s]" />
              <span class="h-1.5 w-1.5 animate-bounce rounded-full bg-text-on-main-bg-color [animation-delay:-0.15s]" />
              <span class="h-1.5 w-1.5 animate-bounce rounded-full bg-text-on-main-bg-color" />
            </div>
            <span class="text-xs text-text-on-main-bg-color">{{ typingText }}</span>
          </div>
        </DynamicScrollerItem>
      </template>
    </DynamicScroller>

    <!-- Context menu -->
    <MessageContextMenu
      :show="contextMenu.show"
      :x="contextMenu.x"
      :y="contextMenu.y"
      :message="contextMenu.message"
      :is-own="contextMenu.isOwn"
      @close="closeContextMenu"
      @action="handleContextAction"
      @react="handleContextReaction"
      @open-emoji-picker="handleOpenEmojiPicker"
    />

    <!-- Full emoji picker (from context menu [+]) -->
    <EmojiPicker
      :show="emojiPicker.show"
      :x="emojiPicker.x"
      :y="emojiPicker.y"
      :mode="emojiPicker.mode"
      @close="emojiPicker.show = false"
      @select="handleEmojiSelect"
    />

    <!-- Media viewer -->
    <MediaViewer
      :show="showMediaViewer"
      :message-id="mediaViewerMessageId"
      @close="showMediaViewer = false"
    />

    <!-- Scroll-to-bottom FAB with new message badge -->
    <transition name="fab">
      <button
        v-if="showScrollFab"
        class="absolute bottom-4 right-4 flex h-11 w-11 items-center justify-center rounded-full bg-background-total-theme shadow-lg transition-all hover:bg-neutral-grad-0"
        @click="scrollToBottom(true)"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-text-on-main-bg-color">
          <polyline points="6 9 12 15 18 9" />
        </svg>
        <!-- New message count badge -->
        <span
          v-if="newMessageCount > 0"
          class="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-color-bg-ac px-1 text-[10px] font-medium text-text-on-bg-ac-color"
        >
          {{ newMessageCount > 99 ? "99+" : newMessageCount }}
        </span>
      </button>
    </transition>

    <!-- Delete confirmation modal -->
    <Teleport to="body">
      <transition name="modal-fade">
        <div
          v-if="chatStore.deletingMessage"
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          @click.self="chatStore.deletingMessage = null"
        >
          <div class="w-full max-w-xs rounded-xl bg-background-total-theme p-5 shadow-xl">
            <h3 class="mb-4 text-base font-semibold text-text-color">Delete message?</h3>
            <div class="flex flex-col gap-2">
              <button
                class="rounded-lg bg-color-bad px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-color-bad/90"
                @click="handleDeleteForEveryone"
              >
                Delete for everyone
              </button>
              <button
                class="rounded-lg bg-neutral-grad-0 px-4 py-2.5 text-sm font-medium text-text-color transition-colors hover:bg-neutral-grad-2"
                @click="handleDeleteForMe"
              >
                Delete for me
              </button>
              <button
                class="rounded-lg px-4 py-2 text-sm text-text-on-main-bg-color transition-colors hover:bg-neutral-grad-0"
                @click="chatStore.deletingMessage = null"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      </transition>
    </Teleport>
  </div>
</template>

<style scoped>
.fab-enter-active,
.fab-leave-active {
  transition: all 0.2s ease;
}
.fab-enter-from,
.fab-leave-to {
  opacity: 0;
  transform: scale(0.8) translateY(8px);
}
.modal-fade-enter-active,
.modal-fade-leave-active {
  transition: opacity 0.2s;
}
.modal-fade-enter-from,
.modal-fade-leave-to {
  opacity: 0;
}

/* Message entrance animations */
.msg-enter-own {
  animation: msg-in-own 0.25s ease-out both;
}
.msg-enter-other {
  animation: msg-in-other 0.25s ease-out both;
}
</style>

<style>
@keyframes search-flash {
  0% { background-color: rgba(var(--color-bg-ac-rgb, 59 130 246), 0.25); }
  100% { background-color: transparent; }
}
.search-highlight {
  animation: search-flash 1.5s ease-out;
  border-radius: 8px;
}
</style>
