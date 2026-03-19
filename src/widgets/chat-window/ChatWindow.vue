<script setup lang="ts">
import { useChatStore } from "@/entities/chat";
import { useAuthStore } from "@/entities/auth";
import { ChannelView } from "@/features/channels";
import { useChannelStore } from "@/entities/channel";
import { MessageList, MessageInput } from "@/features/messaging";
import SelectionBar from "@/features/messaging/ui/SelectionBar.vue";
import ForwardPicker from "@/features/messaging/ui/ForwardPicker.vue";
import ChatSearch from "@/features/messaging/ui/ChatSearch.vue";
import { useToast } from "@/shared/lib/use-toast";
import { ChatInfoPanel, UserProfilePanel } from "@/features/chat-info";
import PinnedBar from "@/features/messaging/ui/PinnedBar.vue";
import { UserAvatar } from "@/entities/user";
import { useUserStore } from "@/entities/user/model";

import { useMobile } from "@/shared/lib/composables/use-media-query";
import { BottomSheet } from "@/shared/ui/bottom-sheet";
import { useCallService } from "@/features/video-calls/model/call-service";
import type { CallType } from "@/entities/call";
import { useWallet } from "@/features/wallet";
import DonateModal from "@/features/wallet/ui/DonateModal.vue";
import { hexEncode, hexDecode } from "@/shared/lib/matrix/functions";
import DropOverlay from "@/features/messaging/ui/DropOverlay.vue";
import { usePasteDrop } from "@/features/messaging/model/use-paste-drop";
import { useResolvedRoomName } from "@/entities/chat/lib/use-resolved-room-name";
import { isUnresolvedName } from "@/entities/chat/lib/chat-helpers";
import { useChatSyncStatus } from "@/features/sync-status";

const chatStore = useChatStore();
const { syncSubtitle } = useChatSyncStatus(
  computed(() => chatStore.activeRoomId),
);
const authStore = useAuthStore();
const userStore = useUserStore();
const channelStore = useChannelStore();
const emit = defineEmits<{ back: [] }>();

const isChannelView = computed(() => channelStore.activeChannelAddress !== null);

watch(() => chatStore.activeRoomId, (roomId) => {
  if (roomId) channelStore.clearActiveChannel();
});
const { toast } = useToast();

const { t } = useI18n();

const isAdmin = computed(() => {
  if (!chatStore.activeRoom) return false;
  return chatStore.getRoomPowerLevels(chatStore.activeRoom.id).myLevel >= 50;
});

const { resolve: resolveRoomName } = useResolvedRoomName();

/** Trigger lazy-loading of missing user profiles for active room members */
function _ensureActiveMembers(room: NonNullable<typeof chatStore.activeRoom>): void {
  const myHex = authStore.address ? hexEncode(authStore.address) : "";
  const otherMembers = room.members.filter(m => m !== myHex);
  for (const hexId of otherMembers) {
    const addr = hexDecode(hexId);
    if (/^[A-Za-z0-9]+$/.test(addr)) userStore.loadUserIfMissing(addr);
  }
  if (room.avatar?.startsWith("__pocketnet__:")) {
    userStore.loadUserIfMissing(room.avatar.slice("__pocketnet__:".length));
  }
}

const activeRoomName = computed(() => {
  const room = chatStore.activeRoom;
  if (!room) return "";
  _ensureActiveMembers(room);
  return resolveRoomName(room);
});
const activeRoomNameLoading = computed(() => isUnresolvedName(activeRoomName.value));

const showForwardPicker = ref(false);
const showSearch = ref(false);
const showInfoPanel = ref(false);
const messageListRef = ref<InstanceType<typeof MessageList>>();
const chatWindowRef = ref<HTMLElement>();
const messageInputRef = ref<InstanceType<typeof MessageInput>>();

// Drag-and-drop file support — routes to MessageInput's existing mediaUpload
const pasteDrop = usePasteDrop({
  onMediaFiles: (files) => messageInputRef.value?.addMediaFiles(files),
  onOtherFiles: (files) => messageInputRef.value?.sendOtherFiles(files),
});

pasteDrop.setupDragListeners(chatWindowRef);

const isMobile = useMobile();
const showMoreMenu = ref(false);

const callService = useCallService();
const { isAvailable: walletAvailable } = useWallet();
const showDonateModal = ref(false);

const profileAddress = ref("");
const showUserProfile = ref(false);

const openUserProfile = (address: string) => {
  profileAddress.value = address;
  showUserProfile.value = true;
};

provide("openUserProfile", openUserProfile);

/** Get the other member's Pocketnet address in a 1:1 chat.
 *  room.members stores hex-encoded addresses; we compare in hex then decode to Base58. */
const otherMemberAddress = computed(() => {
  const room = chatStore.activeRoom;
  if (!room || room.isGroup) return "";
  const myHex = authStore.address ? hexEncode(authStore.address) : "";
  const hexAddr = room.members.find((m) => m !== myHex) ?? "";
  return hexAddr ? hexDecode(hexAddr) : "";
});

const otherMemberName = computed(() =>
  otherMemberAddress.value ? chatStore.getDisplayName(otherMemberAddress.value) : "",
);

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

  const room = chatStore.activeRoom;
  if (!room?.isGroup) {
    return t("chat.typing");
  }

  const names = others.map(id => chatStore.getDisplayName(id));
  if (names.length === 1) {
    return t("chat.typingNamed", { name: names[0] });
  }
  if (names.length === 2) {
    return t("chat.typingTwo", { name1: names[0], name2: names[1] });
  }
  return t("chat.typingMany", { name: names[0], count: names.length - 1 });
});

/** Subtitle: typing indicator or member count */
const subtitle = computed(() => {
  if (typingText.value) return typingText.value;
  if (syncSubtitle.value) return syncSubtitle.value;
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
  if (e.key === "Escape") {
    if (showSearch.value) {
      closeSearch();
    } else if (chatStore.activeRoom && !isChannelView.value) {
      chatStore.setActiveRoom(null);
      // Снять фокус, чтобы не оставалась обводка на vue-recycle-scroller__item-view
      (document.activeElement as HTMLElement)?.blur();
    }
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
  <div ref="chatWindowRef" class="relative flex h-full flex-col bg-background-total-theme" style="padding-bottom: max(var(--keyboardheight, 0px), var(--safe-area-inset-bottom, 0px))">
    <!-- Chat header -->
    <div
      v-if="chatStore.activeRoom && !isChannelView"
      class="flex h-14 shrink-0 items-center gap-3 border-b border-neutral-grad-0 px-3"
    >
      <!-- Back button (mobile) -->
      <button
        class="btn-press flex h-11 w-11 items-center justify-center rounded-full text-text-on-main-bg-color transition-colors hover:bg-neutral-grad-0 md:hidden"
        :aria-label="t('nav.back')"
        @click="emit('back')"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M19 12H5" /><path d="M12 19l-7-7 7-7" />
        </svg>
      </button>

      <!-- Room avatar + info (clickable to open info panel) -->
      <button
        class="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left"
        :aria-label="activeRoomName + ' — ' + t('info.title')"
        @click="showInfoPanel = true"
      >
        <UserAvatar
          v-if="chatStore.activeRoom.avatar?.startsWith('__pocketnet__:')"
          :address="chatStore.activeRoom.avatar.replace('__pocketnet__:', '')"
          size="sm"
        />
        <Avatar v-else :src="chatStore.activeRoom.avatar" :name="activeRoomName" size="sm" />
        <div class="min-w-0 flex-1">
          <div v-if="activeRoomNameLoading" class="h-4 w-28 animate-pulse rounded bg-neutral-grad-2" />
          <div v-else class="truncate text-[15px] font-medium text-text-color">
            {{ activeRoomName }}
          </div>
          <div
            class="text-xs"
            :class="
              typingText
                ? 'text-color-bg-ac'
                : syncSubtitle
                  ? 'text-muted-foreground'
                  : 'text-text-on-main-bg-color'
            "
          >
            {{ subtitle }}
          </div>
        </div>
      </button>

      <!-- Search button -->
      <button
        class="btn-press flex h-11 w-11 items-center justify-center rounded-full text-text-on-main-bg-color transition-colors hover:bg-neutral-grad-0"
        :title="t('chat.search')"
        :aria-label="t('chat.search')"
        @click="showSearch = !showSearch"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      </button>

      <!-- Voice call button (1:1 only, desktop) -->
      <button
        v-if="!chatStore.activeRoom.isGroup && !isMobile"
        class="btn-press flex h-11 w-11 items-center justify-center rounded-full text-text-on-main-bg-color transition-colors hover:bg-neutral-grad-0"
        :title="t('call.voiceCall')"
        :aria-label="t('call.voiceCall')"
        @click="startCallFromHeader('voice')"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z" />
        </svg>
      </button>

      <!-- Info panel button (desktop) -->
      <button
        v-if="!isMobile"
        class="btn-press flex h-11 w-11 items-center justify-center rounded-full text-text-on-main-bg-color transition-colors hover:bg-neutral-grad-0"
        :title="t('info.title')"
        :aria-label="t('info.title')"
        @click="showInfoPanel = !showInfoPanel"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="12" cy="5" r="2" />
          <circle cx="12" cy="12" r="2" />
          <circle cx="12" cy="19" r="2" />
        </svg>
      </button>

      <!-- More menu button (mobile) -->
      <button
        v-if="isMobile"
        class="btn-press flex h-11 w-11 items-center justify-center rounded-full text-text-on-main-bg-color transition-colors hover:bg-neutral-grad-0"
        aria-label="More actions"
        @click="showMoreMenu = true"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="12" cy="5" r="2" />
          <circle cx="12" cy="12" r="2" />
          <circle cx="12" cy="19" r="2" />
        </svg>
      </button>
    </div>

    <!-- Active channel view -->
    <ChannelView
      v-if="isChannelView"
      @back="() => { channelStore.clearActiveChannel(); emit('back'); }"
    />

    <!-- No room selected (only when no channel either) -->
    <div
      v-else-if="!chatStore.activeRoom"
      class="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center text-text-on-main-bg-color"
    >
      <div class="flex h-20 w-20 items-center justify-center rounded-full bg-color-bg-ac/8">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" class="text-color-bg-ac/50">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </div>
      <div>
        <p class="text-base font-medium text-text-color/60">{{ t("chat.selectToStart") }}</p>
      </div>
    </div>

    <!-- Active room content -->
    <template v-else-if="chatStore.activeRoom">

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
              {{ t("chat.inviteGroup", { name: activeRoomName }) }}
              <br />
              <span class="text-xs">{{ t("chat.members", { count: chatStore.activeRoom.members.length }) }}</span>
            </template>
            <template v-else>
              {{ t("chat.invitePersonal", { name: activeRoomName }) }}
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
        <PinnedBar :is-admin="isAdmin" @scroll-to="handleScrollToMessage" />
        <MessageList ref="messageListRef" />
        <SelectionBar
          v-if="chatStore.selectionMode"
          @forward="handleSelectionForward"
          @copy="handleSelectionCopy"
          @delete="handleSelectionDelete"
        />
        <MessageInput
          v-else
          ref="messageInputRef"
          :show-donate="!chatStore.activeRoom?.isGroup && walletAvailable"
          @donate="showDonateModal = true"
        />
        <ForwardPicker
          :show="showForwardPicker"
          @close="showForwardPicker = false; chatStore.exitSelectionMode()"
        />
      </template>
    </template>

    <ChatInfoPanel :show="showInfoPanel" @close="showInfoPanel = false" @open-search="showSearch = true" @go-to-message="(id) => { showInfoPanel = false; messageListRef?.scrollToMessage(id); }" />
    <UserProfilePanel
      :show="showUserProfile"
      :address="profileAddress"
      @close="showUserProfile = false"
    />
    <DonateModal
      :show="showDonateModal"
      :receiver-address="otherMemberAddress"
      :receiver-name="otherMemberName"
      @close="showDonateModal = false"
    />

    <DropOverlay :visible="pasteDrop.isDragging.value" />

    <!-- Mobile more menu -->
    <BottomSheet :show="showMoreMenu" @close="showMoreMenu = false" aria-label="More actions">
      <div class="flex flex-col">
        <button
          v-if="chatStore.activeRoom && !chatStore.activeRoom.isGroup"
          class="flex items-center gap-3 px-2 py-3 text-left hover:bg-neutral-grad-0/50 rounded-lg"
          @click="startCallFromHeader('voice'); showMoreMenu = false"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-text-on-main-bg-color">
            <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z" />
          </svg>
          <span class="text-sm text-text-color">{{ t('call.voiceCall') }}</span>
        </button>
        <button
          class="flex items-center gap-3 px-2 py-3 text-left hover:bg-neutral-grad-0/50 rounded-lg"
          @click="showInfoPanel = !showInfoPanel; showMoreMenu = false"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-text-on-main-bg-color">
            <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
          </svg>
          <span class="text-sm text-text-color">{{ t('info.title') }}</span>
        </button>
      </div>
    </BottomSheet>
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
