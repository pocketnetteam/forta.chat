<script setup lang="ts">
import { useChatStore } from "@/entities/chat";
import type { ChatRoom } from "@/entities/chat";
import { MessageType } from "@/entities/chat";
import MessageStatusIcon from "@/features/messaging/ui/MessageStatusIcon.vue";
import { useAuthStore } from "@/entities/auth";
import { formatRelativeTime } from "@/shared/lib/format";
import { stripMentionAddresses, stripBastyonLinks } from "@/shared/lib/message-format";
import { cleanMatrixIds, isUnresolvedName } from "@/entities/chat/lib/chat-helpers";
import { useFormatPreview } from "@/shared/lib/utils/format-preview";
import { getMessagePreviewForUI, type DisplayResult } from "@/entities/chat";
import { useLongPress } from "@/shared/lib/gestures";
import { UserAvatar } from "@/entities/user";
import { getDraft } from "@/shared/lib/drafts";
import { useSelectionStore } from "@/features/selection";
import { hapticImpact } from "@/shared/lib/haptics";

interface Props {
  room: ChatRoom & { _title?: DisplayResult };
}

const props = defineProps<Props>();
const emit = defineEmits<{
  select: [room: ChatRoom];
  contextmenu: [e: MouseEvent, room: ChatRoom];
}>();

const chatStore = useChatStore();
const authStore = useAuthStore();
const selectionStore = useSelectionStore();
const { t } = useI18n();
const { formatPreview } = useFormatPreview();

// Each ChatRoomRow has its own reactive scope — changes to one room's
// typing/preview/draft only re-render THAT row, not the entire list.

const isActive = computed(() => chatStore.activeRoomId === props.room.id);
const isPinned = computed(() => chatStore.pinnedRoomIds.has(props.room.id));
const isMuted = computed(() => chatStore.mutedRoomIds.has(props.room.id));
const isSelected = computed(() => selectionStore.isSelected(props.room.id));
const isSelectionMode = computed(() => selectionStore.isSelectionMode);

const typingText = computed(() => {
  const typingUsers = chatStore.getTypingUsers(props.room.id);
  const myAddr = authStore.address ?? "";
  const others = typingUsers.filter(id => id !== myAddr);
  if (others.length === 0) return "";
  if (!props.room.isGroup) return t("contactList.typing");
  const names = others.map(id => chatStore.getDisplayName(id));
  if (names.length === 1) return t("contactList.typingNamed", { name: names[0] });
  if (names.length === 2) return t("contactList.typingTwo", { name1: names[0], name2: names[1] });
  return t("contactList.typingMany", { name: names[0], count: names.length - 1 });
});

const draftText = computed(() => {
  void chatStore.activeRoomId;
  return getDraft(props.room.id);
});
const showDraft = computed(() => draftText.value && props.room.id !== chatStore.activeRoomId);

const preview = computed((): DisplayResult => {
  const room = props.room;
  if (room.lastMessage) {
    if (room.lastMessage.deleted || (!room.lastMessage.content && room.lastMessage.type === MessageType.text)) {
      return { state: "ready", text: `🚫 ${t("message.deleted")}` };
    }
    const content = room.lastMessage.content;
    const cleaned = (content && !content.startsWith("[encrypted"))
      ? stripBastyonLinks(cleanMatrixIds(stripMentionAddresses(content)))
      : content;
    return getMessagePreviewForUI(cleaned, room.lastMessage.decryptionStatus, t("message.notDecrypted"));
  }
  const msgs = chatStore.messages[room.id];
  if (msgs?.length) {
    const last = msgs[msgs.length - 1];
    if (last.deleted || (!last.content && last.type === MessageType.text)) {
      return { state: "ready", text: `🚫 ${t("message.deleted")}` };
    }
    if (room.isGroup && last.senderId) {
      const senderName = chatStore.getDisplayName(last.senderId);
      if (isUnresolvedName(senderName)) return { state: "resolving", text: "" };
    }
    if (last.type === MessageType.system) {
      return { state: "ready", text: formatPreview(last, room) };
    }
    const cleaned = stripBastyonLinks(cleanMatrixIds(stripMentionAddresses(last.content)));
    return getMessagePreviewForUI(cleaned, last.decryptionStatus, t("message.notDecrypted"));
  }
  const dexieRoom = chatStore.dexieRoomMap.get(room.id);
  if (dexieRoom?.lastMessageEventId) {
    return { state: "resolving", text: "" };
  }
  return { state: "ready", text: t("contactList.noMessages") };
});

const timestamp = computed((): number | null => {
  if (props.room.lastMessage?.timestamp) return props.room.lastMessage.timestamp;
  const lr = chatStore.dexieRoomMap.get(props.room.id);
  const ts = lr?.lastMessageTimestamp || lr?.updatedAt || props.room.updatedAt;
  return ts && ts > 0 ? ts : null;
});

const hasFetchError = computed(() => {
  const state = chatStore.roomFetchStates.get(props.room.id);
  return state?.status === "error";
});

// Long press → selection mode activation (per-row isolated handler)
let suppressContextMenu = false;
const longPress = useLongPress({
  onTrigger: () => {
    if (selectionStore.isSelectionMode) return;
    suppressContextMenu = true;
    selectionStore.activate(props.room.id);
    hapticImpact("MEDIUM").catch(() => {});
    setTimeout(() => { suppressContextMenu = false; }, 50);
  },
});

const handleClick = () => emit("select", props.room);
const handleContextMenu = (e: MouseEvent) => {
  if (suppressContextMenu || selectionStore.isSelectionMode) return;
  emit("contextmenu", e, props.room);
};
</script>

<template>
  <button
    class="chat-room-row flex h-[68px] w-full cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors hover:bg-neutral-grad-0 active:bg-neutral-grad-0"
    :class="[
      isSelected ? 'bg-color-bg-ac/8' :
      isActive ? 'bg-color-bg-ac/10' : ''
    ]"
    :aria-label="`${room._title?.text || ''}${room.unreadCount ? `, ${room.unreadCount} unread` : ''}`"
    @click="handleClick"
    @contextmenu.prevent="handleContextMenu"
    @pointerdown="longPress.onPointerdown"
    @pointermove="longPress.onPointermove"
    @pointerup="longPress.onPointerup"
    @pointerleave="longPress.onPointerleave"
  >
    <!-- Avatar -->
    <div class="relative shrink-0">
      <transition name="check-pop">
        <div
          v-if="isSelectionMode"
          class="absolute inset-0 z-10 flex items-center justify-center rounded-full"
          :class="isSelected ? 'bg-color-bg-ac' : 'bg-black/30'"
        >
          <svg
            v-if="isSelected"
            width="22" height="22" viewBox="0 0 24 24"
            fill="none" stroke="white" stroke-width="3"
            stroke-linecap="round" stroke-linejoin="round"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>
      </transition>
      <UserAvatar
        v-if="room.avatar?.startsWith('__pocketnet__:')"
        :address="room.avatar!.replace('__pocketnet__:', '')"
        size="md"
        eager
      />
      <Avatar v-else :src="room.avatar" :name="room._title?.text || ''" size="md" />
      <!-- Invite badge -->
      <div
        v-if="!isSelectionMode && room.membership === 'invite'"
        class="absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-color-bg-ac"
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" class="text-white">
          <path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4-8 5-8-5V6l8 5 8-5v2z" />
        </svg>
      </div>
      <!-- Group indicator -->
      <div
        v-else-if="!isSelectionMode && room.isGroup"
        class="absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-background-total-theme"
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" class="text-text-on-main-bg-color">
          <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z" />
        </svg>
      </div>
    </div>

    <div class="min-w-0 flex-1">
      <!-- Name row -->
      <div class="flex items-center justify-between gap-2">
        <span v-if="room._title?.state === 'resolving'" class="inline-block h-3.5 w-24 animate-pulse rounded bg-neutral-grad-2 contain-strict shrink-0" />
        <span v-else class="flex items-center gap-1 truncate text-[15px] font-medium text-text-color">
          {{ room._title?.text }}
          <svg v-if="isPinned" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" class="shrink-0 text-text-on-main-bg-color">
            <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z" />
          </svg>
          <svg v-if="isMuted" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="shrink-0 text-text-on-main-bg-color">
            <path d="M11 5L6 9H2v6h4l5 4V5z" /><line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" />
          </svg>
        </span>
        <span
          v-if="timestamp"
          class="flex shrink-0 items-center gap-0.5 text-xs"
          :class="room.unreadCount > 0 ? 'text-color-bg-ac' : 'text-text-on-main-bg-color'"
        >
          <MessageStatusIcon
            v-if="room.lastMessage?.senderId === authStore.address && room.lastMessage!.type !== MessageType.system && room.lastMessage!.content !== ''"
            :status="room.lastMessage!.status"
          />
          {{ formatRelativeTime(new Date(timestamp!)) }}
        </span>
      </div>

      <!-- Preview row -->
      <div class="mt-0.5 flex items-center justify-between gap-2">
        <div class="min-w-0 flex-1 h-5 flex items-center contain-strict">
        <span v-if="typingText" class="truncate text-sm text-color-bg-ac">
          <span class="inline-flex gap-0.5 align-middle">
            <span class="inline-block h-1 w-1 animate-bounce rounded-full bg-color-bg-ac contain-strict [animation-delay:-0.3s]" />
            <span class="inline-block h-1 w-1 animate-bounce rounded-full bg-color-bg-ac contain-strict [animation-delay:-0.15s]" />
            <span class="inline-block h-1 w-1 animate-bounce rounded-full bg-color-bg-ac contain-strict" />
          </span>
          {{ typingText }}
        </span>
        <span
          v-else-if="showDraft"
          class="truncate text-sm"
        ><span class="font-medium text-color-bad">{{ t("contactList.draft") }}:</span> <span class="text-text-on-main-bg-color">{{ draftText }}</span></span>
        <span v-else-if="room.membership === 'invite'" class="truncate text-sm italic text-color-bg-ac">
          {{ t("contactList.inviteToChat") }}
        </span>
        <span
          v-else-if="hasFetchError && !preview.text"
          class="flex items-center gap-1 truncate text-sm text-text-on-main-bg-color"
        >
          <span class="italic opacity-60">{{ t("contactList.loadError") }}</span>
          <button
            class="ml-1 rounded p-0.5 text-xs text-color-bg-ac hover:bg-neutral-grad-2"
            @click.stop="chatStore.retryRoomFetch(room.id)"
          >↻</button>
        </span>
        <span
          v-else-if="preview.state === 'resolving'"
          class="inline-block h-3 w-32 animate-pulse rounded bg-neutral-grad-2 contain-strict shrink-0"
        />
        <span
          v-else-if="preview.state === 'failed'"
          class="truncate text-sm italic text-text-on-main-bg-color"
        >
          {{ preview.text }}
        </span>
        <span
          v-else-if="room.lastMessage?.callInfo"
          class="truncate text-sm"
          :class="room.lastMessage!.callInfo!.missed ? 'text-color-bad' : 'italic text-text-on-main-bg-color'"
        >
          {{ formatPreview(room.lastMessage, room) }}
        </span>
        <span
          v-else-if="room.lastMessage?.type === MessageType.system"
          class="truncate text-sm italic text-text-on-main-bg-color"
        >
          {{ formatPreview(room.lastMessage, room) }}
        </span>
        <span
          v-else-if="!room.lastMessage && preview.text"
          class="truncate text-sm text-text-on-main-bg-color"
        >
          {{ preview.text }}
        </span>
        <span v-else class="truncate text-sm text-text-on-main-bg-color">
          <span v-if="room.lastMessageReaction" class="mr-0.5">{{ room.lastMessageReaction!.emoji }}</span>{{ formatPreview(room.lastMessage, room) }}
        </span>
        </div>
        <transition name="badge-pop">
          <span
            v-if="room.unreadCount > 0"
            class="flex h-[20px] min-w-[20px] shrink-0 items-center justify-center rounded-full px-1.5 text-[11px] font-medium text-white contain-strict"
            :class="isMuted ? 'bg-neutral-grad-2' : 'bg-color-bg-ac'"
            :aria-label="`${room.unreadCount} unread messages`"
          >
            {{ room.unreadCount > 99 ? "99+" : room.unreadCount }}
          </span>
        </transition>
      </div>
    </div>
  </button>
</template>

<style scoped>
.chat-room-row {
  contain: strict;
  content-visibility: auto;
  contain-intrinsic-size: auto 68px;
}
.badge-pop-enter-active {
  animation: badge-bounce-in 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.badge-pop-leave-active {
  transition: transform 0.15s ease-in, opacity 0.15s ease-in;
}
.badge-pop-leave-to {
  opacity: 0;
  transform: scale(0);
}
@keyframes badge-bounce-in {
  0%   { transform: scale(0); }
  60%  { transform: scale(1.2); }
  100% { transform: scale(1); }
}
.check-pop-enter-active {
  transition: transform 0.15s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.1s ease;
}
.check-pop-enter-from { transform: scale(0); opacity: 0; }
.check-pop-leave-active {
  transition: transform 0.1s ease-in, opacity 0.1s ease-in;
}
.check-pop-leave-to { transform: scale(0); opacity: 0; }
</style>
