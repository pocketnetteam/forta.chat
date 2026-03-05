<script setup lang="ts">
import { ref, computed } from "vue";
import { useChatStore } from "@/entities/chat";
import type { ChatRoom, Message } from "@/entities/chat";
import { MessageType, MessageStatus } from "@/entities/chat";
import MessageStatusIcon from "@/features/messaging/ui/MessageStatusIcon.vue";
import { useAuthStore } from "@/entities/auth";
import { formatRelativeTime } from "@/shared/lib/format";
import { stripMentionAddresses, stripBastyonLinks } from "@/shared/lib/message-format";
import { hexDecode, hexEncode } from "@/shared/lib/matrix/functions";
import { cleanMatrixIds, resolveSystemText } from "@/entities/chat/lib/chat-helpers";
import { useLongPress } from "@/shared/lib/gestures";
import { ContextMenu } from "@/shared/ui/context-menu";
import type { ContextMenuItem } from "@/shared/ui/context-menu";
import { UserAvatar } from "@/entities/user";
import { useUserStore } from "@/entities/user/model";
import { RecycleScroller } from "vue-virtual-scroller";
import "vue-virtual-scroller/dist/vue-virtual-scroller.css";
import { getDraft } from "@/shared/lib/drafts";

interface Props {
  filter?: "all" | "personal" | "groups" | "invites";
}

const props = withDefaults(defineProps<Props>(), { filter: "all" });

const chatStore = useChatStore();
const authStore = useAuthStore();
const userStore = useUserStore();
const { t } = useI18n();
const emit = defineEmits<{ selectRoom: [roomId: string] }>();

const handleSelect = (room: ChatRoom) => {
  if (ctxMenu.value.show) return;
  chatStore.setActiveRoom(room.id);
  emit("selectRoom", room.id);
};

/** Reactive map of room ID → resolved display name.
 *  Using a computed ensures RecycleScroller re-renders when userStore.users changes. */
const roomNameMap = computed(() => {
  const allUsers = userStore.users;
  const myHexId = authStore.address ? hexEncode(authStore.address) : "";
  const map: Record<string, string> = {};
  for (const room of chatStore.sortedRooms) {
    map[room.id] = _resolveRoomName(room, allUsers, myHexId);
  }
  return map;
});

/** Resolve room display name — matches original bastyon-chat name.vue exactly:
 *  1. For 1:1: get other members → hexDecode(hexId) → look up name in userStore → join with ", "
 *  2. If no names found → "-"
 *  3. If room name starts with "@" → strip "@"
 *  4. For groups/public: use room name as-is */
/** Check if name looks like an unresolved hash/hex (not human-readable) */
function _isUnresolvedName(name: string): boolean {
  if (!name || name.length < 2) return true;
  if (/^#?[a-f0-9]{16,}$/i.test(name)) return true; // hex hash or #hex alias
  if (/^[a-f0-9]{8}…$/i.test(name)) return true; // truncated hex
  return false;
}

// Cache hexDecode results to avoid repeated computation
const hexDecodeCache = new Map<string, string>();
function cachedHexDecode(hex: string): string {
  let result = hexDecodeCache.get(hex);
  if (result === undefined) {
    result = hexDecode(hex);
    hexDecodeCache.set(hex, result);
  }
  return result;
}

/** Resolve member names from userStore — shared between 1:1 and group resolution */
function _resolveMemberNames(room: ChatRoom, allUsers: Record<string, any>, myHexId: string): string[] {
  const otherMembers = room.members.filter(m => m !== myHexId);

  const names: string[] = [];
  for (const hexId of otherMembers) {
    const addr = cachedHexDecode(hexId);
    if (/^[A-Za-z0-9]+$/.test(addr)) {
      const user = allUsers[addr];
      if (user?.name) { names.push(user.name); continue; }
    }
  }

  // Fallback: try avatar address
  if (names.length === 0 && room.avatar?.startsWith("__pocketnet__:")) {
    const avatarAddr = room.avatar.slice("__pocketnet__:".length);
    const user = allUsers[avatarAddr];
    if (user?.name && user.name !== avatarAddr) names.push(user.name);
  }

  return names;
}

function _resolveRoomName(room: ChatRoom, allUsers: Record<string, any>, myHexId: string): string {
  if (!room.isGroup) {
    const names = _resolveMemberNames(room, allUsers, myHexId);
    if (names.length > 0) return names.join(", ");
    // Fallback: show address from avatar or decoded member hex
    if (room.avatar?.startsWith("__pocketnet__:")) {
      return room.avatar.slice("__pocketnet__:".length);
    }
    const otherMembers = room.members.filter(m => m !== myHexId);
    if (otherMembers.length > 0) {
      const addr = cachedHexDecode(otherMembers[0]);
      if (/^[A-Za-z0-9]+$/.test(addr)) return addr;
    }
    return cleanMatrixIds(room.name);
  }
  if (room.name?.startsWith("@")) return room.name.slice(1);
  if (!_isUnresolvedName(room.name)) return cleanMatrixIds(room.name);
  const names = _resolveMemberNames(room, allUsers, myHexId);
  if (names.length > 0) return names.join(", ");
  return cleanMatrixIds(room.name);
}

const resolveRoomName = (room: ChatRoom): string => {
  return roomNameMap.value[room.id] ?? cleanMatrixIds(room.name);
};

/** Format last message preview with type-aware icons */
const formatPreview = (msg: Message | undefined, room: ChatRoom): string => {
  if (!msg) return t("contactList.noMessages");
  if (msg.deleted || (!msg.content && msg.type === MessageType.text && !msg.fileInfo)) {
    return `🚫 ${t("message.deleted")}`;
  }
  let preview: string;
  switch (msg.type) {
    case MessageType.image:
      preview = msg.content && msg.content !== "[photo]" ? `📷 ${msg.content}` : "📷 " + t("message.photo");
      break;
    case MessageType.video:
      preview = msg.content && msg.content !== "[video]" ? `🎬 ${msg.content}` : "🎬 " + t("message.video");
      break;
    case MessageType.audio:
      preview = msg.content && msg.content !== "[voice message]" ? `🎤 ${msg.content}` : "🎤 " + t("message.voiceMessage");
      break;
    case MessageType.file:
      preview = `📎 ${msg.content || t("message.file")}`;
      break;
    case MessageType.system: {
      // Dynamically resolve names from systemMeta template (avoids stale truncated addresses)
      let sysText: string;
      if (msg.systemMeta?.template) {
        sysText = resolveSystemText(
          msg.systemMeta.template,
          msg.systemMeta.senderAddr,
          msg.systemMeta.targetAddr,
          (addr) => chatStore.getDisplayName(addr),
        );
      } else {
        sysText = cleanMatrixIds(msg.content);
      }
      if (msg.callInfo) {
        const icon = msg.callInfo.callType === "video" ? "📹" : "📞";
        return `${icon} ${sysText}`;
      }
      return sysText;
    }
    default:
      preview = msg.content || "";
  }
  // Strip mention hex addresses for preview (e.g. @hexid:Name → @Name)
  preview = stripMentionAddresses(preview);
  // Replace bastyon post links with short label
  preview = stripBastyonLinks(preview);
  // Clean any remaining raw Matrix IDs (@hexid:server → decoded address)
  preview = cleanMatrixIds(preview);

  // Add sender prefix for group chats
  if (room.isGroup && msg.senderId) {
    const myAddr = authStore.address ?? "";
    const senderName = msg.senderId === myAddr ? "You" : chatStore.getDisplayName(msg.senderId);
    preview = `${senderName}: ${preview}`;
  }
  return preview;
};

/** Get typing users for a room (excluding self) */
const getTypingText = (roomId: string): string => {
  const typingUsers = chatStore.getTypingUsers(roomId);
  const myAddr = authStore.address ?? "";
  const others = typingUsers.filter(id => id !== myAddr);
  if (others.length === 0) return "";
  if (others.length === 1) return "typing...";
  return `${others.length} typing...`;
};

// --- Drafts: reactive map of roomId → draft text ---
// Bump version when user switches rooms (draft may have changed)
const draftsVersion = ref(0);
watch(() => chatStore.activeRoomId, () => { draftsVersion.value++; });

/** Get draft text for a room (reactive via draftsVersion) */
const getRoomDraft = (roomId: string): string => {
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  draftsVersion.value; // reactive dependency
  return getDraft(roomId);
};

const PAGE_SIZE = 30;
const displayLimit = ref(PAGE_SIZE);

const allFilteredRooms = computed(() => {
  const rooms = chatStore.sortedRooms;
  // Touch roomNameMap to keep reactive dependency (names resolve async)
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  roomNameMap.value;
  if (props.filter === "personal") return rooms.filter(r => !r.isGroup && r.membership !== "invite");
  if (props.filter === "groups") return rooms.filter(r => r.isGroup && r.membership !== "invite");
  if (props.filter === "invites") return rooms.filter(r => r.membership === "invite");
  return rooms;
});

const filteredRooms = computed(() => allFilteredRooms.value.slice(0, displayLimit.value));
const hasMoreRooms = computed(() => displayLimit.value < allFilteredRooms.value.length);

// Reset page when filter changes
watch(() => props.filter, () => { displayLimit.value = PAGE_SIZE; });

const loadMoreRooms = () => {
  if (hasMoreRooms.value) {
    displayLimit.value += PAGE_SIZE;
  }
};

const scrollerRef = ref<InstanceType<typeof RecycleScroller>>();

const onScrollerScroll = () => {
  if (!hasMoreRooms.value) return;
  const el = scrollerRef.value?.$el as HTMLElement | undefined;
  if (!el) return;
  const { scrollTop, scrollHeight, clientHeight } = el;
  if (scrollHeight - scrollTop - clientHeight < 200) {
    loadMoreRooms();
  }
};

// Attach native scroll listener to RecycleScroller's root element
let scrollEl: HTMLElement | null = null;
const attachScrollListener = () => {
  if (scrollEl) scrollEl.removeEventListener("scroll", onScrollerScroll);
  scrollEl = (scrollerRef.value?.$el as HTMLElement) ?? null;
  scrollEl?.addEventListener("scroll", onScrollerScroll, { passive: true });
};

onMounted(attachScrollListener);
watch(scrollerRef, attachScrollListener);
onUnmounted(() => { scrollEl?.removeEventListener("scroll", onScrollerScroll); });

// Context menu
const ctxMenu = ref<{ show: boolean; x: number; y: number; roomId: string | null }>({
  show: false, x: 0, y: 0, roomId: null,
});

const svg = (d: string) =>
  `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

const ICONS = {
  pin:    svg('<line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/>'),
  unpin:  svg('<line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/><line x1="2" y1="2" x2="22" y2="22"/>'),
  mute:   svg('<path d="M18 16.5a9 9 0 0 0 .38-10.17"/><path d="M13.73 7.73a4 4 0 0 1 .52 4.52"/><path d="m2 2 20 20"/><path d="M9.34 9.34 3 16h4v4l4.65-4.65"/><path d="M15 2 9.34 7.66"/>'),
  unmute: svg('<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>'),
  read:   svg('<polyline points="20 6 9 17 4 12"/>'),
  delete: svg('<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>'),
};

const ctxMenuItems = computed<ContextMenuItem[]>(() => {
  const roomId = ctxMenu.value.roomId;
  if (!roomId) return [];
  const isPinned = chatStore.pinnedRoomIds.has(roomId);
  const isMuted = chatStore.mutedRoomIds.has(roomId);
  return [
    { label: isPinned ? "Unpin" : "Pin", icon: isPinned ? ICONS.unpin : ICONS.pin, action: "pin" },
    { label: isMuted ? "Unmute" : "Mute", icon: isMuted ? ICONS.unmute : ICONS.mute, action: "mute" },
    { label: "Mark as Read", icon: ICONS.read, action: "read" },
    { label: "Delete", icon: ICONS.delete, action: "delete", danger: true },
  ];
});

const openCtxMenu = (e: PointerEvent, room: ChatRoom) => {
  ctxMenu.value = { show: true, x: e.clientX, y: e.clientY, roomId: room.id };
};

const deleteConfirm = ref<{ show: boolean; roomId: string | null }>({ show: false, roomId: null });

const handleCtxAction = (action: string) => {
  const roomId = ctxMenu.value.roomId;
  if (!roomId) return;
  switch (action) {
    case "pin": chatStore.togglePinRoom(roomId); break;
    case "mute": chatStore.toggleMuteRoom(roomId); break;
    case "read": chatStore.markRoomAsRead(roomId); break;
    case "delete":
      deleteConfirm.value = { show: true, roomId };
      break;
  }
  ctxMenu.value.show = false;
};

const confirmDeleteRoom = () => {
  if (deleteConfirm.value.roomId) {
    chatStore.removeRoom(deleteConfirm.value.roomId);
  }
  deleteConfirm.value = { show: false, roomId: null };
};

// Per-room long press: cache a single useLongPress instance per room
const longPressCache = new Map<string, ReturnType<typeof useLongPress>>();

const getRoomLongPress = (room: ChatRoom) => {
  let handlers = longPressCache.get(room.id);
  if (!handlers) {
    handlers = useLongPress({
      onTrigger: (e) => openCtxMenu(e, room),
    });
    longPressCache.set(room.id, handlers);
  }
  return handlers;
};
</script>

<template>
  <div class="flex flex-col">
    <div
      v-if="filteredRooms.length === 0"
      class="flex flex-col items-center gap-3 px-6 py-12 text-center"
    >
      <div class="flex h-14 w-14 items-center justify-center rounded-full bg-neutral-grad-0">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="text-text-on-main-bg-color">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </div>
      <p class="text-sm text-text-on-main-bg-color">{{ t("contactList.noConversations") }}</p>
    </div>

    <RecycleScroller
      v-if="filteredRooms.length > 0"
      ref="scrollerRef"
      :items="filteredRooms"
      :item-size="68"
      key-field="id"
      class="h-full"
    >
      <template #default="{ item: room }">
        <button
          class="flex h-[68px] w-full cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors hover:bg-neutral-grad-0 active:bg-neutral-grad-0"
          :class="room.id === chatStore.activeRoomId ? 'bg-color-bg-ac/10' : ''"
          @click="handleSelect(room)"
          @contextmenu.prevent="(e: MouseEvent) => { ctxMenu = { show: true, x: e.clientX, y: e.clientY, roomId: room.id }; }"
          @pointerdown="(e: PointerEvent) => getRoomLongPress(room).onPointerdown(e)"
          @pointermove="(e: PointerEvent) => getRoomLongPress(room).onPointermove(e)"
          @pointerup="() => getRoomLongPress(room).onPointerup()"
          @pointerleave="() => getRoomLongPress(room).onPointerleave()"
        >
          <!-- Avatar -->
          <div class="relative shrink-0">
            <UserAvatar
              v-if="room.avatar?.startsWith('__pocketnet__:')"
              :address="room.avatar.replace('__pocketnet__:', '')"
              size="md"
            />
            <Avatar v-else :src="room.avatar" :name="resolveRoomName(room)" size="md" />
            <!-- Group indicator -->
            <div
              v-if="room.isGroup"
              class="absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-background-total-theme"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" class="text-text-on-main-bg-color">
                <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z" />
              </svg>
            </div>
          </div>

          <div class="min-w-0 flex-1">
            <!-- Name row: name + timestamp + pin/mute icons -->
            <div class="flex items-center justify-between gap-2">
              <span class="flex items-center gap-1 truncate text-[15px] font-medium text-text-color">
                {{ resolveRoomName(room) }}
                <svg v-if="chatStore.pinnedRoomIds.has(room.id)" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" class="shrink-0 text-text-on-main-bg-color">
                  <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z" />
                </svg>
                <svg v-if="chatStore.mutedRoomIds.has(room.id)" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="shrink-0 text-text-on-main-bg-color">
                  <path d="M11 5L6 9H2v6h4l5 4V5z" /><line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" />
                </svg>
              </span>
              <span
                v-if="room.lastMessage"
                class="flex shrink-0 items-center gap-0.5 text-xs"
                :class="room.unreadCount > 0 ? 'text-color-bg-ac' : 'text-text-on-main-bg-color'"
              >
                <MessageStatusIcon
                  v-if="room.lastMessage.senderId === authStore.address && room.lastMessage.type !== MessageType.system"
                  :status="room.lastMessage.status"
                />
                {{ formatRelativeTime(new Date(room.lastMessage.timestamp)) }}
              </span>
            </div>

            <!-- Preview row: draft / typing / last message + unread badge -->
            <div class="mt-0.5 flex items-center justify-between gap-2">
              <span
                v-if="getTypingText(room.id)"
                class="truncate text-sm text-color-bg-ac"
              >
                <span class="inline-flex gap-0.5 align-middle">
                  <span class="inline-block h-1 w-1 animate-bounce rounded-full bg-color-bg-ac [animation-delay:-0.3s]" />
                  <span class="inline-block h-1 w-1 animate-bounce rounded-full bg-color-bg-ac [animation-delay:-0.15s]" />
                  <span class="inline-block h-1 w-1 animate-bounce rounded-full bg-color-bg-ac" />
                </span>
                {{ getTypingText(room.id) }}
              </span>
              <span
                v-else-if="getRoomDraft(room.id) && room.id !== chatStore.activeRoomId"
                class="truncate text-sm"
              ><span class="font-medium text-red-400">{{ t("contactList.draft") }}:</span> <span class="text-text-on-main-bg-color">{{ getRoomDraft(room.id) }}</span></span>
              <span v-else-if="room.membership === 'invite'" class="truncate text-sm italic text-color-bg-ac">
                Invitation to chat
              </span>
              <span
                v-else-if="room.lastMessage?.callInfo"
                class="truncate text-sm"
                :class="room.lastMessage.callInfo.missed ? 'text-red-400' : 'italic text-text-on-main-bg-color'"
              >
                {{ formatPreview(room.lastMessage, room) }}
              </span>
              <span
                v-else-if="room.lastMessage?.type === MessageType.system"
                class="truncate text-sm italic text-text-on-main-bg-color"
              >
                {{ formatPreview(room.lastMessage, room) }}
              </span>
              <span v-else class="truncate text-sm text-text-on-main-bg-color">
                {{ formatPreview(room.lastMessage, room) }}
              </span>
              <transition name="badge-pop">
                <span
                  v-if="room.unreadCount > 0"
                  class="flex h-[20px] min-w-[20px] shrink-0 items-center justify-center rounded-full px-1.5 text-[11px] font-medium text-white"
                  :class="chatStore.mutedRoomIds.has(room.id) ? 'bg-neutral-grad-2' : 'bg-color-bg-ac'"
                >
                  {{ room.unreadCount > 99 ? "99+" : room.unreadCount }}
                </span>
              </transition>
            </div>
          </div>
        </button>
      </template>
    </RecycleScroller>

    <!-- Room context menu -->
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
          @click.self="deleteConfirm = { show: false, roomId: null }"
        >
          <div class="w-full max-w-xs rounded-xl bg-background-total-theme p-5 shadow-xl">
            <h3 class="mb-3 text-base font-semibold text-text-color">Delete chat?</h3>
            <p class="mb-4 text-sm text-text-on-main-bg-color">Do you really want to leave and delete this chat?</p>
            <div class="flex gap-2">
              <button
                class="flex-1 rounded-lg bg-neutral-grad-0 px-4 py-2.5 text-sm font-medium text-text-color transition-colors hover:bg-neutral-grad-2"
                @click="deleteConfirm = { show: false, roomId: null }"
              >
                Cancel
              </button>
              <button
                class="flex-1 rounded-lg bg-color-bad px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-color-bad/90"
                @click="confirmDeleteRoom"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      </transition>
    </Teleport>
  </div>
</template>

<style scoped>
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
</style>
