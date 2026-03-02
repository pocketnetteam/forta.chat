<script setup lang="ts">
import { useChatStore } from "@/entities/chat";
import { useAuthStore } from "@/entities/auth";
import { MessageList, MessageInput } from "@/features/messaging";
import SelectionBar from "@/features/messaging/ui/SelectionBar.vue";
import ForwardPicker from "@/features/messaging/ui/ForwardPicker.vue";
import ChatSearch from "@/features/messaging/ui/ChatSearch.vue";
import { useToast } from "@/shared/lib/use-toast";
import { ChatInfoPanel } from "@/features/chat-info";
import PinnedBar from "@/features/messaging/ui/PinnedBar.vue";
import { UserAvatar } from "@/entities/user";
import { useConnectivity } from "@/shared/lib/connectivity";
import { useCallService } from "@/features/video-calls/model/call-service";
import type { CallType } from "@/entities/call";

const chatStore = useChatStore();
const authStore = useAuthStore();
const emit = defineEmits<{ back: [] }>();
const { toast } = useToast();
const { isOnline, isSlow } = useConnectivity();
const { t } = useI18n();

const showForwardPicker = ref(false);
const showSearch = ref(false);
const showInfoPanel = ref(false);
const messageListRef = ref<InstanceType<typeof MessageList>>();

const callService = useCallService();

const startCallFromHeader = (type: CallType) => {
  const roomId = chatStore.activeRoomId;
  if (roomId) callService.startCall(roomId, type);
};

const handleScrollToMessage = (messageId: string) => {
  messageListRef.value?.scrollToMessage(messageId);
};

const handleSelectionForward = () => {
  showForwardPicker.value = true;
};

// Auto-open ForwardPicker when "forward" is selected from context menu
watch(() => chatStore.forwardingMessages, (v) => {
  if (v) showForwardPicker.value = true;
});

const handleSelectionCopy = () => {
  const ids = chatStore.selectedMessageIds;
  const msgs = chatStore.activeMessages.filter(m => ids.has(m.id));
  const text = msgs.map(m => m.content).join("\n");
  navigator.clipboard.writeText(text).then(() => toast(t("chat.copiedToClipboard")));
  chatStore.exitSelectionMode();
};

const handleSelectionDelete = () => {
  // Set the first selected message as deletingMessage (triggers the delete modal in MessageList)
  const ids = chatStore.selectedMessageIds;
  const msg = chatStore.activeMessages.find(m => ids.has(m.id));
  if (msg) chatStore.deletingMessage = msg;
};

/** Typing indicator text */
const typingText = computed(() => {
  const roomId = chatStore.activeRoomId;
  if (!roomId) return "";
  const typingUsers = chatStore.getTypingUsers(roomId);
  const myAddr = authStore.address ?? "";
  const others = typingUsers.filter(id => id !== myAddr);
  if (others.length === 0) return "";
  if (others.length === 1) return t("chat.typing");
  return t("chat.typingCount", { count: others.length });
});

/** Subtitle: typing indicator or member count */
const subtitle = computed(() => {
  if (typingText.value) return typingText.value;
  const room = chatStore.activeRoom;
  if (!room) return "";
  if (room.isGroup) return t("chat.members", { count: room.members.length });
  return "";
});

/** Handle search query changes — pass to MessageList for highlighting */
const handleSearchQuery = (query: string) => {
  messageListRef.value?.setSearchQuery(query);
};

/** Close search and clear highlighting */
const closeSearch = () => {
  showSearch.value = false;
  messageListRef.value?.setSearchQuery("");
};

/** Ctrl+F / Cmd+F keyboard shortcut to open search */
const handleKeydown = (e: KeyboardEvent) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "f" && chatStore.activeRoom) {
    e.preventDefault();
    showSearch.value = true;
  }
  if (e.key === "Escape" && showSearch.value) {
    closeSearch();
  }
};

/** Whether the active room is an invite (not yet joined) */
const isInvite = computed(() => chatStore.activeRoom?.membership === "invite");
const inviteLoading = ref(false);

const handleAcceptInvite = async () => {
  const roomId = chatStore.activeRoomId;
  if (!roomId) return;
  inviteLoading.value = true;
  try {
    await chatStore.acceptInvite(roomId);
  } finally {
    inviteLoading.value = false;
  }
};

const handleDeclineInvite = async () => {
  const roomId = chatStore.activeRoomId;
  if (!roomId) return;
  inviteLoading.value = true;
  try {
    await chatStore.declineInvite(roomId);
  } finally {
    inviteLoading.value = false;
  }
};

onMounted(() => {
  document.addEventListener("keydown", handleKeydown);
});

onUnmounted(() => {
  document.removeEventListener("keydown", handleKeydown);
});
</script>

<template>
  <div class="flex h-full flex-col bg-background-total-theme" style="padding-bottom: max(var(--keyboardheight, 0px), env(safe-area-inset-bottom, 0px))">
    <!-- Chat header -->
    <div
      v-if="chatStore.activeRoom"
      class="flex h-14 shrink-0 items-center gap-3 border-b border-neutral-grad-0 px-3"
    >
      <!-- Back button (mobile) -->
      <button
        class="btn-press flex h-11 w-11 items-center justify-center rounded-full text-text-on-main-bg-color transition-colors hover:bg-neutral-grad-0 md:hidden"
        @click="emit('back')"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M19 12H5" /><path d="M12 19l-7-7 7-7" />
        </svg>
      </button>

      <!-- Room avatar + info (clickable to open info panel) -->
      <button
        class="flex min-w-0 flex-1 items-center gap-3 text-left"
        @click="showInfoPanel = true"
      >
        <UserAvatar
          v-if="chatStore.activeRoom.avatar?.startsWith('__pocketnet__:')"
          :address="chatStore.activeRoom.avatar.replace('__pocketnet__:', '')"
          size="sm"
        />
        <Avatar v-else :src="chatStore.activeRoom.avatar" :name="chatStore.activeRoom.name" size="sm" />
        <div class="min-w-0 flex-1">
          <div class="truncate text-[15px] font-medium text-text-color">
            {{ chatStore.activeRoom.name }}
          </div>
          <div
            class="text-xs"
            :class="typingText ? 'text-color-bg-ac' : 'text-text-on-main-bg-color'"
          >
            {{ subtitle }}
          </div>
        </div>
      </button>

      <!-- Search button -->
      <button
        class="btn-press flex h-11 w-11 items-center justify-center rounded-full text-text-on-main-bg-color transition-colors hover:bg-neutral-grad-0"
        :title="t('chat.search')"
        @click="showSearch = !showSearch"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      </button>

      <!-- Voice call button (1:1 only) -->
      <button
        v-if="!chatStore.activeRoom.isGroup"
        class="btn-press flex h-11 w-11 items-center justify-center rounded-full text-text-on-main-bg-color transition-colors hover:bg-neutral-grad-0"
        :title="t('call.voiceCall')"
        @click="startCallFromHeader('voice')"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z" />
        </svg>
      </button>

      <!-- Video call button (1:1 only) -->
      <button
        v-if="!chatStore.activeRoom.isGroup"
        class="btn-press flex h-11 w-11 items-center justify-center rounded-full text-text-on-main-bg-color transition-colors hover:bg-neutral-grad-0"
        :title="t('call.videoCall')"
        @click="startCallFromHeader('video')"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="23 7 16 12 23 17 23 7" />
          <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
        </svg>
      </button>

      <!-- More menu -->
      <button
        class="btn-press flex h-11 w-11 items-center justify-center rounded-full text-text-on-main-bg-color transition-colors hover:bg-neutral-grad-0"
        :title="t('chat.more')"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="12" cy="5" r="2" />
          <circle cx="12" cy="12" r="2" />
          <circle cx="12" cy="19" r="2" />
        </svg>
      </button>
    </div>

    <!-- No room selected -->
    <div
      v-if="!chatStore.activeRoom"
      class="flex flex-1 flex-col items-center justify-center gap-3 text-text-on-main-bg-color"
    >
      <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" class="opacity-30">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
      <span class="text-sm">{{ t("chat.selectToStart") }}</span>
    </div>

    <!-- Active room content -->
    <template v-if="chatStore.activeRoom">
      <!-- Connectivity banner -->
      <transition name="banner-slide">
        <div
          v-if="!isOnline"
          class="flex items-center justify-center gap-2 bg-color-bad px-3 py-1.5 text-xs font-medium text-white"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="1" y1="1" x2="23" y2="23" /><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" /><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" /><path d="M10.71 5.05A16 16 0 0 1 22.56 9" /><path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" /><path d="M8.53 16.11a6 6 0 0 1 6.95 0" /><line x1="12" y1="20" x2="12.01" y2="20" />
          </svg>
          {{ t("chat.offline") }}
        </div>
        <div
          v-else-if="isSlow"
          class="flex items-center justify-center gap-2 bg-yellow-500 px-3 py-1.5 text-xs font-medium text-white"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          {{ t("chat.slowConnection") }}
        </div>
      </transition>

      <!-- Invite preview (not yet joined) -->
      <div
        v-if="isInvite"
        class="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center"
      >
        <div class="flex h-16 w-16 items-center justify-center rounded-full bg-color-bg-ac/10">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="text-color-bg-ac">
            <path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
          </svg>
        </div>
        <div>
          <h3 class="text-base font-semibold text-text-color">
            {{ t("chat.invitation") }}
          </h3>
          <p class="mt-1 text-sm text-text-on-main-bg-color">
            <template v-if="chatStore.activeRoom?.isGroup">
              {{ t("chat.inviteGroup", { name: chatStore.activeRoom.name }) }}
              <br />
              <span class="text-xs">{{ t("chat.members", { count: chatStore.activeRoom.members.length }) }}</span>
            </template>
            <template v-else>
              {{ t("chat.invitePersonal", { name: chatStore.activeRoom?.name ?? '' }) }}
            </template>
          </p>
        </div>
        <div class="flex w-full max-w-xs gap-3">
          <button
            class="flex-1 rounded-xl bg-neutral-grad-0 px-4 py-3 text-sm font-medium text-text-color transition-colors hover:bg-neutral-grad-2"
            :disabled="inviteLoading"
            @click="handleDeclineInvite"
          >
            {{ t("chat.decline") }}
          </button>
          <button
            class="flex-1 rounded-xl bg-color-bg-ac px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-color-bg-ac/90"
            :disabled="inviteLoading"
            @click="handleAcceptInvite"
          >
            <span v-if="inviteLoading" class="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
            <span v-else>{{ t("chat.accept") }}</span>
          </button>
        </div>
      </div>

      <!-- Messages (joined room) -->
      <template v-else>
        <transition name="search-slide">
          <ChatSearch
            v-if="showSearch"
            @close="closeSearch"
            @scroll-to="handleScrollToMessage"
            @update:query="handleSearchQuery"
          />
        </transition>
        <PinnedBar @scroll-to="handleScrollToMessage" />
        <MessageList ref="messageListRef" />
        <transition name="bar-slide-up" mode="out-in">
          <SelectionBar
            v-if="chatStore.selectionMode"
            key="selection"
            @forward="handleSelectionForward"
            @copy="handleSelectionCopy"
            @delete="handleSelectionDelete"
          />
          <MessageInput v-else key="input" />
        </transition>
        <ForwardPicker
          :show="showForwardPicker"
          @close="showForwardPicker = false; chatStore.exitSelectionMode()"
        />
      </template>
    </template>

    <ChatInfoPanel :show="showInfoPanel" @close="showInfoPanel = false" />
  </div>
</template>

<style scoped>
/* Search bar slides down from top */
.search-slide-enter-active {
  transition: transform 0.25s cubic-bezier(0.32, 0.72, 0, 1), opacity 0.25s ease-out;
}
.search-slide-leave-active {
  transition: transform 0.2s ease-in, opacity 0.2s ease-in;
}
.search-slide-enter-from {
  opacity: 0;
  transform: translateY(-100%);
}
.search-slide-leave-to {
  opacity: 0;
  transform: translateY(-100%);
}

/* Connectivity banner slides down */
.banner-slide-enter-active {
  transition: transform 0.25s cubic-bezier(0.32, 0.72, 0, 1), opacity 0.25s ease-out;
}
.banner-slide-leave-active {
  transition: transform 0.2s ease-in, opacity 0.2s ease-in;
}
.banner-slide-enter-from {
  opacity: 0;
  transform: translateY(-100%);
}
.banner-slide-leave-to {
  opacity: 0;
  transform: translateY(-100%);
}

/* SelectionBar slides up from bottom */
.bar-slide-up-enter-active {
  transition: transform 0.2s cubic-bezier(0.32, 0.72, 0, 1), opacity 0.2s ease-out;
}
.bar-slide-up-leave-active {
  transition: transform 0.15s ease-in, opacity 0.15s ease-in;
}
.bar-slide-up-enter-from {
  opacity: 0;
  transform: translateY(8px);
}
.bar-slide-up-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
