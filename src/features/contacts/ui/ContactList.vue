<script setup lang="ts">
import { ref, computed, nextTick, watch, onUnmounted, triggerRef } from "vue";
import { useChatStore } from "@/entities/chat";
import type { ChatRoom, Message } from "@/entities/chat";
import { MessageType, MessageStatus } from "@/entities/chat";
import MessageStatusIcon from "@/features/messaging/ui/MessageStatusIcon.vue";
import { useAuthStore } from "@/entities/auth";
import { useChannelStore } from "@/entities/channel";
import type { Channel } from "@/entities/channel";
import { formatRelativeTime } from "@/shared/lib/format";
import { stripMentionAddresses, stripBastyonLinks } from "@/shared/lib/message-format";
import { hexDecode, hexEncode } from "@/shared/lib/matrix/functions";
import { cleanMatrixIds, resolveSystemText, isUnresolvedName } from "@/entities/chat/lib/chat-helpers";
import { useFormatPreview } from "@/shared/lib/utils/format-preview";
import { isEncryptedPlaceholder } from "@/shared/lib/utils/is-encrypted-placeholder";
import { useLongPress } from "@/shared/lib/gestures";
import { ContextMenu } from "@/shared/ui/context-menu";
import type { ContextMenuItem } from "@/shared/ui/context-menu";
import { UserAvatar } from "@/entities/user";
import { useUserStore } from "@/entities/user/model";
import { RecycleScroller } from "vue-virtual-scroller";
import "vue-virtual-scroller/dist/vue-virtual-scroller.css";
import { getDraft } from "@/shared/lib/drafts";

interface Props {
  filter?: "all" | "personal" | "groups" | "invites" | "channels";
}

const props = withDefaults(defineProps<Props>(), { filter: "all" });

const chatStore = useChatStore();
const authStore = useAuthStore();
const channelStore = useChannelStore();
const userStore = useUserStore();
const { t } = useI18n();
const { formatPreview } = useFormatPreview();
const emit = defineEmits<{ selectRoom: [roomId: string]; selectChannel: [address: string] }>();

const handleSelect = (room: ChatRoom) => {
  if (ctxMenu.value.show) return;
  chatStore.setActiveRoom(room.id);
  channelStore.clearActiveChannel();
  emit("selectRoom", room.id);
};

const handleSelectChannel = (channel: Channel) => {
  if (ctxMenu.value.show) return;
  channelStore.setActiveChannel(channel.address);
  chatStore.setActiveRoom(null);
  emit("selectChannel", channel.address);
};

/** Check if a list item is a channel (has address field, no id field) */
function isChannel(item: ChatRoom | Channel): item is Channel {
  return "address" in item && !("id" in item);
}

/** Get unified sort timestamp for a list item */
function getItemTimestamp(item: ChatRoom | Channel): number {
  if (isChannel(item)) {
    return item.lastContent ? item.lastContent.time * 1000 : 0;
  }
  return item.lastMessage?.timestamp ?? item.updatedAt;
}

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
      // Only use name if it's a real display name, not the raw address
      if (user?.name && !isUnresolvedName(user.name) && user.name !== addr) {
        names.push(user.name); continue;
      }
    }
  }

  // Fallback: try avatar address
  if (names.length === 0 && room.avatar?.startsWith("__pocketnet__:")) {
    const avatarAddr = room.avatar.slice("__pocketnet__:".length);
    const user = allUsers[avatarAddr];
    if (user?.name && !isUnresolvedName(user.name) && user.name !== avatarAddr) names.push(user.name);
  }

  return names;
}

/** Rooms where name resolution permanently failed — stop showing skeleton for these */
const gaveUpRooms = ref(new Set<string>());

/** Track which rooms have no real display name yet */
const unresolvedRoomSet = computed(() => {
  const set = new Set<string>();
  const allUsers = userStore.users;
  const myHexId = authStore.address ? hexEncode(authStore.address) : "";
  for (const room of chatStore.sortedRooms) {
    if (gaveUpRooms.value.has(room.id)) continue;
    const resolved = _resolveMemberNames(room, allUsers, myHexId);
    if (resolved.length === 0) set.add(room.id);
  }
  return set;
});

const isRoomNameUnresolved = (room: ChatRoom): boolean => unresolvedRoomSet.value.has(room.id);

function _resolveRoomName(room: ChatRoom, allUsers: Record<string, any>, myHexId: string): string {
  if (!room.isGroup) {
    const names = _resolveMemberNames(room, allUsers, myHexId);
    if (names.length > 0) return names.join(", ");
    return room.name;
  }
  if (room.name?.startsWith("@")) return room.name.slice(1);
  if (!isUnresolvedName(room.name)) return cleanMatrixIds(room.name);
  const names = _resolveMemberNames(room, allUsers, myHexId);
  if (names.length > 0) return names.join(", ");
  return cleanMatrixIds(room.name);
}

const resolveRoomName = (room: ChatRoom): string => {
  return roomNameMap.value[room.id] ?? cleanMatrixIds(room.name);
};

// --- Retry unresolved room names (up to 5 attempts with exponential backoff) ---
let nameRetryCount = 0;
let nameRetryTimer: ReturnType<typeof setTimeout> | undefined;
const MAX_NAME_RETRIES = 5;
const NAME_RETRY_BASE_MS = 2_000; // 2s, 4s, 8s, 16s, 32s

watch(unresolvedRoomSet, (set) => {
  const unresolvedRoomIds = [...set];
  if (unresolvedRoomIds.length === 0) {
    nameRetryCount = 0;
    return;
  }
  if (nameRetryCount >= MAX_NAME_RETRIES) {
    // All retries exhausted — give up, show fallback name instead of infinite skeleton
    console.warn(
      `[contact-list] giving up on ${unresolvedRoomIds.length} unresolved rooms after ${MAX_NAME_RETRIES} retries:`,
      unresolvedRoomIds,
    );
    for (const id of unresolvedRoomIds) gaveUpRooms.value.add(id);
    triggerRef(gaveUpRooms);
    return;
  }
  clearTimeout(nameRetryTimer);
  const delay = NAME_RETRY_BASE_MS * Math.pow(2, nameRetryCount);
  nameRetryTimer = setTimeout(() => {
    nameRetryCount++;
    console.debug(`[contact-list] name-retry attempt=${nameRetryCount} unresolved=${unresolvedRoomIds.length} delayMs=${delay}`);
    chatStore.clearProfileCache(unresolvedRoomIds);
    chatStore.loadProfilesForRoomIds(unresolvedRoomIds);
  }, delay);
}, { immediate: true });

onUnmounted(() => clearTimeout(nameRetryTimer));

// If user profiles arrive late (e.g. from background refresh), remove gave-up flag
watch(() => userStore.users, () => {
  if (gaveUpRooms.value.size === 0) return;
  const myHexId = authStore.address ? hexEncode(authStore.address) : "";
  const allUsers = userStore.users;
  for (const roomId of [...gaveUpRooms.value]) {
    const room = chatStore.sortedRooms.find(r => r.id === roomId);
    if (!room) continue;
    if (_resolveMemberNames(room, allUsers, myHexId).length > 0) {
      gaveUpRooms.value.delete(roomId);
    }
  }
}, { deep: false });

/** Format last message preview — delegated to shared composable */

/** Get typing users for a room (excluding self) */
const getTypingText = (roomId: string): string => {
  const typingUsers = chatStore.getTypingUsers(roomId);
  const myAddr = authStore.address ?? "";
  const others = typingUsers.filter(id => id !== myAddr);
  if (others.length === 0) return "";

  const room = chatStore.rooms.find(r => r.id === roomId);
  if (!room?.isGroup) {
    return t("contactList.typing");
  }

  const names = others.map(id => chatStore.getDisplayName(id));
  if (names.length === 1) {
    return t("contactList.typingNamed", { name: names[0] });
  }
  if (names.length === 2) {
    return t("contactList.typingTwo", { name1: names[0], name2: names[1] });
  }
  return t("contactList.typingMany", { name: names[0], count: names.length - 1 });
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

/** Channel preview text for "All" tab */
const getChannelPreview = (channel: Channel): string => {
  if (!channel.lastContent) return "";
  const text = channel.lastContent.caption || channel.lastContent.message || "";
  return text.length > 80 ? text.slice(0, 80) + "..." : text;
};

const PAGE_SIZE = 50;
const displayLimit = ref(PAGE_SIZE);

/** Unified list item with a stable `_key` for RecycleScroller */
type UnifiedItem = (ChatRoom | Channel) & { _key: string };

const allFilteredRooms = computed<UnifiedItem[]>(() => {
  const rooms = chatStore.sortedRooms;
  // Touch roomNameMap to keep reactive dependency (names resolve async)
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  roomNameMap.value;
  if (props.filter === "personal") return rooms.filter(r => !r.isGroup && r.membership !== "invite").map(r => ({ ...r, _key: r.id }));
  if (props.filter === "groups") return rooms.filter(r => r.isGroup && r.membership !== "invite").map(r => ({ ...r, _key: r.id }));
  if (props.filter === "invites") return rooms.filter(r => r.membership === "invite").map(r => ({ ...r, _key: r.id }));

  // "all": mix rooms + channels, sorted by time.
  // Joined rooms sort above invites at the same timestamp to prevent
  // invite spam from pushing personal chats out of the visible area.
  const roomItems: UnifiedItem[] = rooms.map(r => ({ ...r, _key: r.id }));
  const channelItems: UnifiedItem[] = channelStore.channels.map(c => ({ ...c, _key: `ch:${c.address}` }));
  const merged = [...roomItems, ...channelItems];
  merged.sort((a, b) => {
    const tsDiff = getItemTimestamp(b) - getItemTimestamp(a);
    if (tsDiff !== 0) return tsDiff;
    // Secondary sort: joined > invite > channel (joined rooms first)
    const membershipRank = (item: ChatRoom | Channel): number => {
      if (isChannel(item)) return 2;
      return item.membership === "invite" ? 1 : 0;
    };
    return membershipRank(a) - membershipRank(b);
  });
  return merged;
});

const filteredRooms = computed(() => allFilteredRooms.value.slice(0, displayLimit.value));
const hasMoreRooms = computed(() => displayLimit.value < allFilteredRooms.value.length);

// Reset page when filter changes and reload visible profiles
watch(() => props.filter, () => {
  displayLimit.value = PAGE_SIZE;
  nextTick(loadVisibleRooms);
});

const loadMoreRooms = () => {
  if (hasMoreRooms.value) {
    displayLimit.value += PAGE_SIZE;
  }
};

const scrollerRef = ref<InstanceType<typeof RecycleScroller>>();
const ITEM_HEIGHT = 68;
const PREFETCH_BUFFER = 10; // extra rooms to prefetch ahead of viewport

/** Calculate which rooms are visible + buffer, then load their profiles + preload messages */
const loadVisibleRooms = () => {
  const el = scrollerRef.value?.$el as HTMLElement | undefined;
  if (!el) return;
  const { scrollTop, clientHeight } = el;
  const firstIdx = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - 2);
  const lastIdx = Math.min(
    filteredRooms.value.length - 1,
    Math.ceil((scrollTop + clientHeight) / ITEM_HEIGHT) + PREFETCH_BUFFER,
  );
  const visibleIds: string[] = [];
  for (let i = firstIdx; i <= lastIdx; i++) {
    const item = filteredRooms.value[i];
    if (item && !isChannel(item)) visibleIds.push((item as ChatRoom).id);
  }
  if (visibleIds.length > 0) {
    chatStore.loadProfilesForRoomIds(visibleIds);
    chatStore.preloadRoomsByIds(visibleIds);
  }
};

let scrollDebounceTimer: ReturnType<typeof setTimeout> | null = null;

const onScrollerScroll = () => {
  // Load more rooms (infinite scroll)
  const el = scrollerRef.value?.$el as HTMLElement | undefined;
  if (el && hasMoreRooms.value) {
    const { scrollTop, scrollHeight, clientHeight } = el;
    if (scrollHeight - scrollTop - clientHeight < 200) {
      loadMoreRooms();
    }
  }
  // Debounce viewport preloading (profiles + messages) to avoid flooding on fast scroll
  if (scrollDebounceTimer) clearTimeout(scrollDebounceTimer);
  scrollDebounceTimer = setTimeout(loadVisibleRooms, 150);
};

// Attach native scroll listener to RecycleScroller's root element
let scrollEl: HTMLElement | null = null;
const attachScrollListener = () => {
  if (scrollEl) scrollEl.removeEventListener("scroll", onScrollerScroll);
  scrollEl = (scrollerRef.value?.$el as HTMLElement) ?? null;
  scrollEl?.addEventListener("scroll", onScrollerScroll, { passive: true });
};

onMounted(() => {
  attachScrollListener();
  // Initial viewport profile load
  nextTick(loadVisibleRooms);
});
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
    { label: isPinned ? t("contactList.unpin") : t("contactList.pin"), icon: isPinned ? ICONS.unpin : ICONS.pin, action: "pin" },
    { label: isMuted ? t("contactList.unmute") : t("contactList.mute"), icon: isMuted ? ICONS.unmute : ICONS.mute, action: "mute" },
    { label: t("contactList.markAsRead"), icon: ICONS.read, action: "read" },
    { label: t("contactList.delete"), icon: ICONS.delete, action: "delete", danger: true },
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
      v-if="filteredRooms.length === 0 && chatStore.roomsInitialized"
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
      key-field="_key"
      class="h-full"
    >
      <template #default="{ item }">
        <!-- Channel item -->
        <button
          v-if="isChannel(item)"
          class="flex h-[68px] w-full cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors hover:bg-neutral-grad-0 active:bg-neutral-grad-0"
          :class="(item as Channel).address === channelStore.activeChannelAddress ? 'bg-color-bg-ac/10' : ''"
          @click="handleSelectChannel(item as Channel)"
        >
          <div class="relative shrink-0">
            <Avatar :src="(item as Channel).avatar" :name="(item as Channel).name" size="md" />
            <!-- Channel (megaphone) badge -->
            <div class="absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-background-total-theme">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" class="text-text-on-main-bg-color">
                <path d="M3 10v4a1 1 0 0 0 1 1h2l5 4V5L6 9H4a1 1 0 0 0-1 1zm16 2a6 6 0 0 0-3-5.2v10.4A6 6 0 0 0 19 12z" />
              </svg>
            </div>
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex items-center justify-between gap-2">
              <span class="truncate text-[15px] font-medium text-text-color">{{ (item as Channel).name }}</span>
              <span v-if="(item as Channel).lastContent" class="shrink-0 text-xs text-text-on-main-bg-color">
                {{ formatRelativeTime(new Date((item as Channel).lastContent!.time * 1000)) }}
              </span>
            </div>
            <div class="mt-0.5 flex items-center justify-between gap-2">
              <span class="truncate text-sm text-text-on-main-bg-color">
                {{ getChannelPreview(item as Channel) }}
              </span>
            </div>
          </div>
        </button>

        <!-- Chat room item -->
        <button
          v-else
          class="flex h-[68px] w-full cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors hover:bg-neutral-grad-0 active:bg-neutral-grad-0"
          :class="(item as ChatRoom).id === chatStore.activeRoomId ? 'bg-color-bg-ac/10' : ''"
          :aria-label="`${resolveRoomName(item as ChatRoom)}${(item as ChatRoom).unreadCount ? `, ${(item as ChatRoom).unreadCount} unread` : ''}`"
          @click="handleSelect(item as ChatRoom)"
          @contextmenu.prevent="(e: MouseEvent) => { ctxMenu = { show: true, x: e.clientX, y: e.clientY, roomId: (item as ChatRoom).id }; }"
          @pointerdown="(e: PointerEvent) => getRoomLongPress(item as ChatRoom).onPointerdown(e)"
          @pointermove="(e: PointerEvent) => getRoomLongPress(item as ChatRoom).onPointermove(e)"
          @pointerup="() => getRoomLongPress(item as ChatRoom).onPointerup()"
          @pointerleave="() => getRoomLongPress(item as ChatRoom).onPointerleave()"
        >
          <!-- Avatar -->
          <div class="relative shrink-0">
            <!-- Skeleton circle while name is unresolved -->
            <div
              v-if="isRoomNameUnresolved(item as ChatRoom)"
              class="h-10 w-10 animate-pulse rounded-full bg-neutral-grad-2"
            />
            <UserAvatar
              v-else-if="(item as ChatRoom).avatar?.startsWith('__pocketnet__:')"
              :address="(item as ChatRoom).avatar!.replace('__pocketnet__:', '')"
              size="md"
            />
            <Avatar v-else :src="(item as ChatRoom).avatar" :name="resolveRoomName(item as ChatRoom)" size="md" />
            <!-- Invite badge -->
            <div
              v-if="(item as ChatRoom).membership === 'invite'"
              class="absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-color-bg-ac"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" class="text-white">
                <path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4-8 5-8-5V6l8 5 8-5v2z" />
              </svg>
            </div>
            <!-- Group indicator -->
            <div
              v-else-if="(item as ChatRoom).isGroup"
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
              <span v-if="isRoomNameUnresolved(item as ChatRoom)" class="inline-block h-3.5 w-24 animate-pulse rounded bg-neutral-grad-2" />
              <span v-else class="flex items-center gap-1 truncate text-[15px] font-medium text-text-color">
                {{ resolveRoomName(item as ChatRoom) }}
                <svg v-if="chatStore.pinnedRoomIds.has((item as ChatRoom).id)" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" class="shrink-0 text-text-on-main-bg-color">
                  <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z" />
                </svg>
                <svg v-if="chatStore.mutedRoomIds.has((item as ChatRoom).id)" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="shrink-0 text-text-on-main-bg-color">
                  <path d="M11 5L6 9H2v6h4l5 4V5z" /><line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" />
                </svg>
              </span>
              <span
                v-if="(item as ChatRoom).lastMessage"
                class="flex shrink-0 items-center gap-0.5 text-xs"
                :class="(item as ChatRoom).unreadCount > 0 ? 'text-color-bg-ac' : 'text-text-on-main-bg-color'"
              >
                <MessageStatusIcon
                  v-if="(item as ChatRoom).lastMessage!.senderId === authStore.address && (item as ChatRoom).lastMessage!.type !== MessageType.system && (item as ChatRoom).lastMessage!.content !== ''"
                  :status="(item as ChatRoom).lastMessage!.status"
                />
                {{ formatRelativeTime(new Date((item as ChatRoom).lastMessage!.timestamp)) }}
              </span>
            </div>

            <!-- Preview row: draft / typing / last message + unread badge -->
            <div class="mt-0.5 flex items-center justify-between gap-2">
              <span
                v-if="getTypingText((item as ChatRoom).id)"
                class="truncate text-sm text-color-bg-ac"
              >
                <span class="inline-flex gap-0.5 align-middle">
                  <span class="inline-block h-1 w-1 animate-bounce rounded-full bg-color-bg-ac [animation-delay:-0.3s]" />
                  <span class="inline-block h-1 w-1 animate-bounce rounded-full bg-color-bg-ac [animation-delay:-0.15s]" />
                  <span class="inline-block h-1 w-1 animate-bounce rounded-full bg-color-bg-ac" />
                </span>
                {{ getTypingText((item as ChatRoom).id) }}
              </span>
              <span
                v-else-if="getRoomDraft((item as ChatRoom).id) && (item as ChatRoom).id !== chatStore.activeRoomId"
                class="truncate text-sm"
              ><span class="font-medium text-color-bad">{{ t("contactList.draft") }}:</span> <span class="text-text-on-main-bg-color">{{ getRoomDraft((item as ChatRoom).id) }}</span></span>
              <span v-else-if="(item as ChatRoom).membership === 'invite'" class="truncate text-sm italic text-color-bg-ac">
                {{ t("contactList.inviteToChat") }}
              </span>
              <span
                v-else-if="(item as ChatRoom).lastMessage?.callInfo"
                class="truncate text-sm"
                :class="(item as ChatRoom).lastMessage!.callInfo!.missed ? 'text-color-bad' : 'italic text-text-on-main-bg-color'"
              >
                {{ formatPreview((item as ChatRoom).lastMessage, item as ChatRoom) }}
              </span>
              <span
                v-else-if="(item as ChatRoom).lastMessage?.type === MessageType.system"
                class="truncate text-sm italic text-text-on-main-bg-color"
              >
                {{ formatPreview((item as ChatRoom).lastMessage, item as ChatRoom) }}
              </span>
              <!-- Shimmer skeleton while encrypted message is being decrypted -->
              <span
                v-else-if="isEncryptedPlaceholder((item as ChatRoom).lastMessage?.content)"
                class="inline-block h-3 w-32 animate-pulse rounded bg-neutral-grad-2"
              />
              <span v-else class="truncate text-sm text-text-on-main-bg-color">
                <span v-if="(item as ChatRoom).lastMessageReaction" class="mr-0.5">{{ (item as ChatRoom).lastMessageReaction!.emoji }}</span>{{ formatPreview((item as ChatRoom).lastMessage, item as ChatRoom) }}
              </span>
              <transition name="badge-pop">
                <span
                  v-if="(item as ChatRoom).unreadCount > 0"
                  class="flex h-[20px] min-w-[20px] shrink-0 items-center justify-center rounded-full px-1.5 text-[11px] font-medium text-white"
                  :class="chatStore.mutedRoomIds.has((item as ChatRoom).id) ? 'bg-neutral-grad-2' : 'bg-color-bg-ac'"
                  :aria-label="`${(item as ChatRoom).unreadCount} unread messages`"
                >
                  {{ (item as ChatRoom).unreadCount > 99 ? "99+" : (item as ChatRoom).unreadCount }}
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
            <h3 class="mb-3 text-base font-semibold text-text-color">{{ t("contactList.deleteChat") }}</h3>
            <p class="mb-4 text-sm text-text-on-main-bg-color">{{ t("contactList.deleteChatConfirm") }}</p>
            <div class="flex gap-2">
              <button
                class="flex-1 rounded-lg bg-neutral-grad-0 px-4 py-2.5 text-sm font-medium text-text-color transition-colors hover:bg-neutral-grad-2"
                @click="deleteConfirm = { show: false, roomId: null }"
              >
                {{ t("contactList.cancel") }}
              </button>
              <button
                class="flex-1 rounded-lg bg-color-bad px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-color-bad/90"
                @click="confirmDeleteRoom"
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
