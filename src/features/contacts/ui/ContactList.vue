<script setup lang="ts">
import { ref, computed, nextTick, watch, onUnmounted, triggerRef } from "vue";
import { useChatStore } from "@/entities/chat";
import type { ChatRoom } from "@/entities/chat";
import { useAuthStore } from "@/entities/auth";
import { useChannelStore } from "@/entities/channel";
import type { Channel } from "@/entities/channel";
import { hexDecode, hexEncode } from "@/shared/lib/matrix/functions";
import { cleanMatrixIds, isUnresolvedName, formatGroupMemberNames } from "@/entities/chat/lib/chat-helpers";
import { getRoomTitleForUI, type DisplayResult } from "@/entities/chat";
import { ContextMenu } from "@/shared/ui/context-menu";
import type { ContextMenuItem } from "@/shared/ui/context-menu";
import { useUserStore } from "@/entities/user/model";
import { RecycleScroller } from "vue-virtual-scroller";
import "vue-virtual-scroller/dist/vue-virtual-scroller.css";
import { useSelectionStore } from "@/features/selection";
import { tRaw } from "@/shared/lib/i18n";
import ChatRoomRow from "./ChatRoomRow.vue";
import ChannelRow from "./ChannelRow.vue";

interface Props {
  filter?: "all" | "personal" | "groups" | "invites" | "channels";
}

const props = withDefaults(defineProps<Props>(), { filter: "all" });

const chatStore = useChatStore();
const authStore = useAuthStore();
const channelStore = useChannelStore();
const userStore = useUserStore();
const { t } = useI18n();
const selectionStore = useSelectionStore();
const emit = defineEmits<{ selectRoom: [roomId: string]; selectChannel: [address: string] }>();

const handleSelect = (room: ChatRoom) => {
  if (ctxMenu.value.show) return;
  if (selectionStore.isSelectionMode) {
    selectionStore.toggle(room.id);
    return;
  }
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
 *  Incrementally updated: only creates a new map reference when at least one name
 *  actually changed. This prevents cascading re-renders in allFilteredRooms/RecycleScroller
 *  when a profile load returns the same names (e.g. stale cache refresh). */
let _prevNameMapResult: Record<string, string> = {};
const roomNameMap = computed(() => {
  const allUsers = userStore.users;
  const myHexId = authStore.address ? hexEncode(authStore.address) : "";
  const map: Record<string, string> = {};
  let changed = false;
  for (const room of chatStore.sortedRooms) {
    const name = _resolveRoomName(room, allUsers, myHexId);
    map[room.id] = name;
    if (!changed && _prevNameMapResult[room.id] !== name) changed = true;
  }
  // Also detect removed rooms
  if (!changed) {
    for (const id in _prevNameMapResult) {
      if (!(id in map)) { changed = true; break; }
    }
  }
  if (!changed) return _prevNameMapResult;
  _prevNameMapResult = map;
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

/** Resolve member names — checks Pocketnet profiles first, then Matrix displaynames.
 *  Matrix displaynames come from m.room.member state events (free, already in sync)
 *  and are available instantly without any RPC call. */
function _resolveMemberNames(room: ChatRoom, allUsers: Record<string, any>, myHexId: string): string[] {
  const otherMembers = room.members.filter(m => m !== myHexId);

  const names: string[] = [];
  for (const hexId of otherMembers) {
    const addr = cachedHexDecode(hexId);
    if (/^[A-Za-z0-9]+$/.test(addr)) {
      const user = allUsers[addr];
      if (user?.deleted) { names.push(tRaw("profile.deletedAccount")); continue; }
      if (user?.name && !isUnresolvedName(user.name) && user.name !== addr) {
        names.push(user.name); continue;
      }
      const matrixName = chatStore.getDisplayName(addr);
      if (matrixName && matrixName !== addr && matrixName !== "?" && !isUnresolvedName(matrixName)) {
        names.push(matrixName); continue;
      }
    }
  }

  // Fallback: try avatar address
  if (names.length === 0 && room.avatar?.startsWith("__pocketnet__:")) {
    const avatarAddr = room.avatar.slice("__pocketnet__:".length);
    const user = allUsers[avatarAddr];
    if (user?.deleted) {
      names.push(tRaw("profile.deletedAccount"));
    } else if (user?.name && !isUnresolvedName(user.name) && user.name !== avatarAddr) {
      names.push(user.name);
    } else {
      const matrixName = chatStore.getDisplayName(avatarAddr);
      if (matrixName && matrixName !== avatarAddr && matrixName !== "?" && !isUnresolvedName(matrixName)) {
        names.push(matrixName);
      }
    }
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


function _resolveRoomName(room: ChatRoom, allUsers: Record<string, any>, myHexId: string): string {
  if (!room.isGroup) {
    const names = _resolveMemberNames(room, allUsers, myHexId);
    if (names.length > 0) return names.join(", ");
    return cleanMatrixIds(room.name);
  }
  if (room.name?.startsWith("@")) return room.name.slice(1);
  if (!isUnresolvedName(room.name)) return cleanMatrixIds(room.name);
  const names = _resolveMemberNames(room, allUsers, myHexId);
  if (names.length > 0) return formatGroupMemberNames(names);
  // Fallback for groups (including mis-flagged 1:1): try avatar address, then member address
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

const resolveRoomName = (room: ChatRoom): string => {
  return roomNameMap.value[room.id] ?? cleanMatrixIds(room.name);
};

/** Unified display state for room title: resolving → skeleton, failed → fallback, ready → text */
function getRoomTitle(room: ChatRoom): DisplayResult {
  return getRoomTitleForUI(
    resolveRoomName(room),
    { gaveUp: gaveUpRooms.value.has(room.id), roomId: room.id, fallbackPrefix: t("common.encryptedChat") },
  );
}


// RecycleScroller ref + item height — needed by both retry watcher and scroll handler
const scrollerRef = ref<InstanceType<typeof RecycleScroller>>();
const ITEM_HEIGHT = 68;

// --- Retry unresolved room names (viewport-only, exponential backoff) ---
// With Matrix displayname fallback, most rooms resolve instantly.
// Retry only fires for rooms still unresolved AND currently visible.
let nameRetryCount = 0;
let nameRetryTimer: ReturnType<typeof setTimeout> | undefined;
const MAX_NAME_RETRIES = 6;
const NAME_RETRY_BASE_MS = 2_000; // 2s, 4s, 8s, 16s, 32s, 64s

/** Get room IDs currently in the viewport (or all if scroller not mounted) */
const getVisibleRoomIds = (): Set<string> => {
  const el = scrollerRef.value?.$el as HTMLElement | undefined;
  if (!el) return new Set();
  const { scrollTop, clientHeight } = el;
  const firstIdx = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - 2);
  const lastIdx = Math.min(
    filteredRooms.value.length - 1,
    Math.ceil((scrollTop + clientHeight) / ITEM_HEIGHT) + 4,
  );
  const ids = new Set<string>();
  for (let i = firstIdx; i <= lastIdx; i++) {
    const item = filteredRooms.value[i];
    if (item && !isChannel(item)) ids.add((item as ChatRoom).id);
  }
  return ids;
};

watch(unresolvedRoomSet, (set) => {
  if (set.size === 0) {
    nameRetryCount = 0;
    return;
  }
  if (nameRetryCount >= MAX_NAME_RETRIES) {
    const unresolvedRoomIds = [...set];
    console.warn(
      `[contact-list] giving up on ${unresolvedRoomIds.length} unresolved rooms after ${MAX_NAME_RETRIES} retries`,
    );
    for (const id of unresolvedRoomIds) gaveUpRooms.value.add(id);
    triggerRef(gaveUpRooms);
    return;
  }
  clearTimeout(nameRetryTimer);
  const delay = NAME_RETRY_BASE_MS * Math.pow(2, nameRetryCount);
  nameRetryTimer = setTimeout(() => {
    nameRetryCount++;
    // Only retry rooms that are currently visible — don't fire /members for off-screen rooms
    const visible = getVisibleRoomIds();
    const toRetry = [...set].filter(id => visible.has(id));
    if (toRetry.length === 0) return;
    chatStore.clearProfileCache(toRetry);
    chatStore.loadMembersForRooms(toRetry);
    // Directly enqueue member profiles — loadMembersForRooms loads Matrix members,
    // but we also need to ensure Pocketnet profiles are requested
    const myHex = authStore.address ? hexEncode(authStore.address) : "";
    const addrs: string[] = [];
    for (const roomId of toRetry) {
      const room = chatStore.sortedRooms.find(r => r.id === roomId);
      if (!room) continue;
      for (const hexId of room.members) {
        if (hexId === myHex) continue;
        const addr = cachedHexDecode(hexId);
        if (/^[A-Za-z0-9]+$/.test(addr) && !userStore.users[addr]?.name) addrs.push(addr);
      }
    }
    if (addrs.length > 0) userStore.enqueueProfiles(addrs);
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


const PAGE_SIZE = 50;
const displayLimit = ref(PAGE_SIZE);

/** Unified list item with a stable `_key` for RecycleScroller.
 *  _type enables separate view pools (rooms vs channels) to avoid cross-type DOM diffing.
 *  _title is pre-computed to avoid reactive lookup flash during recycling. */
type UnifiedItem = (ChatRoom | Channel) & { _key: string; _type: "room" | "channel"; _title?: DisplayResult };

// Cache UnifiedItem objects by room id + version to reduce GC pressure.
// Only create a new object when the room's display-affecting fields change.
// IMPORTANT: resolvedName is included in the cache key so that background profile
// loading (triggerRef on userStore.users → roomNameMap recompute) invalidates
// stale titles that were computed before profiles arrived.
const _unifiedItemCache = new Map<string, { ts: number; unread: number; name: string; membership: string; msgStatus: string; preview: string; resolvedName: string; decryptionStatus: string; senderId: string; avatar: string; item: UnifiedItem }>();
const _channelItemCache = new Map<string, { lastTime: number; name: string; avatar: string; item: UnifiedItem }>();

const allFilteredRooms = computed<UnifiedItem[]>(() => {
  const rooms = chatStore.sortedRooms;
  // Read roomNameMap eagerly to maintain reactive dependency even on cache-hit paths.
  // Without this, Vue drops the dependency after first all-hit evaluation.
  const nameMap = roomNameMap.value;
  const toItem = (r: ChatRoom): UnifiedItem => {
    const ts = r.lastMessage?.timestamp ?? r.updatedAt ?? 0;
    const msgStatus = r.lastMessage?.status ?? "";
    const preview = r.lastMessage?.content ?? "";
    const resolvedName = nameMap[r.id] ?? "";
    const decryptionStatus = r.lastMessage?.decryptionStatus ?? "";
    const senderId = r.lastMessage?.senderId ?? "";
    const avatar = r.avatar ?? "";
    const cached = _unifiedItemCache.get(r.id);
    if (cached && cached.ts === ts && cached.unread === r.unreadCount
        && cached.name === r.name && cached.membership === (r.membership ?? "join")
        && cached.msgStatus === msgStatus && cached.preview === preview
        && cached.resolvedName === resolvedName
        && cached.decryptionStatus === decryptionStatus
        && cached.senderId === senderId
        && cached.avatar === avatar) {
      return cached.item;
    }
    const item: UnifiedItem = { ...r, _key: r.id, _type: "room", _title: getRoomTitle(r) };
    _unifiedItemCache.set(r.id, { ts, unread: r.unreadCount, name: r.name, membership: r.membership ?? "join", msgStatus, preview, resolvedName, decryptionStatus, senderId, avatar, item });
    return item;
  };

  if (props.filter === "personal") return rooms.filter(r => !r.isGroup && r.membership !== "invite").map(toItem);
  if (props.filter === "groups") return rooms.filter(r => r.isGroup && r.membership !== "invite").map(toItem);
  if (props.filter === "invites") return rooms.filter(r => r.membership === "invite").map(toItem);
  if (props.filter === "channels") {
    return channelStore.channels
      .map(c => {
        const lastTime = c.lastContent ? c.lastContent.time : 0;
        const cached = _channelItemCache.get(c.address);
        if (cached && cached.lastTime === lastTime && cached.name === c.name && cached.avatar === c.avatar) {
          return cached.item;
        }
        const item: UnifiedItem = { ...c, _key: `ch:${c.address}`, _type: "channel" };
        _channelItemCache.set(c.address, { lastTime, name: c.name, avatar: c.avatar, item });
        return item;
      })
      .sort((a, b) => getItemTimestamp(b) - getItemTimestamp(a));
  }

  // "all": merge-sort rooms + channels (both already sorted by time desc).
  // O(n+m) instead of O((n+m) log(n+m)).
  const roomItems: UnifiedItem[] = rooms.map(toItem);
  const channelItems: UnifiedItem[] = channelStore.channels
    .map(c => {
      const lastTime = c.lastContent ? c.lastContent.time : 0;
      const cached = _channelItemCache.get(c.address);
      if (cached && cached.lastTime === lastTime && cached.name === c.name && cached.avatar === c.avatar) {
        return cached.item;
      }
      const item: UnifiedItem = { ...c, _key: `ch:${c.address}`, _type: "channel" };
      _channelItemCache.set(c.address, { lastTime, name: c.name, avatar: c.avatar, item });
      return item;
    })
    .sort((a, b) => getItemTimestamp(b) - getItemTimestamp(a));

  // Membership rank for tie-breaking: joined rooms > invites > channels
  const membershipRank = (item: ChatRoom | Channel): number => {
    if (isChannel(item)) return 2;
    return (item as ChatRoom).membership === "invite" ? 1 : 0;
  };

  const merged: UnifiedItem[] = [];
  let ri = 0, ci = 0;
  while (ri < roomItems.length && ci < channelItems.length) {
    const rTs = getItemTimestamp(roomItems[ri]);
    const cTs = getItemTimestamp(channelItems[ci]);
    if (rTs > cTs) {
      merged.push(roomItems[ri++]);
    } else if (cTs > rTs) {
      merged.push(channelItems[ci++]);
    } else {
      // Same timestamp: rooms before channels
      if (membershipRank(roomItems[ri]) <= membershipRank(channelItems[ci])) {
        merged.push(roomItems[ri++]);
      } else {
        merged.push(channelItems[ci++]);
      }
    }
  }
  while (ri < roomItems.length) merged.push(roomItems[ri++]);
  while (ci < channelItems.length) merged.push(channelItems[ci++]);
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


/** Track current viewport generation — incremented on each scroll, previous batch stops. */
let viewportGeneration = 0;
let _layoutRetries = 0;

/** Calculate which rooms are visible, load profiles + messages for them.
 *  On scroll: cancels previous batch, loads only new visible rooms. */
const loadVisibleRooms = () => {
  const el = scrollerRef.value?.$el as HTMLElement | undefined;
  if (!el) return;
  const { scrollTop, clientHeight } = el;

  // During tab transition clientHeight may be 0 — retry when layout settles.
  // 20 frames (~333ms at 60fps) covers most CSS transitions.
  if (clientHeight === 0 && _layoutRetries < 20) {
    _layoutRetries++;
    requestAnimationFrame(loadVisibleRooms);
    return;
  }
  _layoutRetries = 0;

  // Only the actual viewport + small overscan (1 above, 2 below)
  const firstIdx = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - 1);
  const lastIdx = Math.min(
    filteredRooms.value.length - 1,
    Math.ceil((scrollTop + clientHeight) / ITEM_HEIGHT) + 2,
  );

  const visibleIds: string[] = [];
  for (let i = firstIdx; i <= lastIdx; i++) {
    const item = filteredRooms.value[i];
    if (item && !isChannel(item)) visibleIds.push((item as ChatRoom).id);
  }

  if (visibleIds.length === 0) return;

  // Cancel previous batch by incrementing generation
  const gen = ++viewportGeneration;

  // 1. Profiles (names, avatars) — always load
  chatStore.loadProfilesForRoomIds(visibleIds);

  // 1a. Load profiles for addresses in system message previews (sender/target)
  //     These may not be current room members, so loadProfilesForRoomIds misses them.
  const sysAddrs: string[] = [];
  for (let i = firstIdx; i <= lastIdx; i++) {
    const item = filteredRooms.value[i];
    if (item && !isChannel(item)) {
      const meta = (item as ChatRoom).lastMessage?.systemMeta;
      if (meta) {
        if (meta.senderAddr && !userStore.users[meta.senderAddr]) sysAddrs.push(meta.senderAddr);
        if (meta.targetAddr && !userStore.users[meta.targetAddr]) sysAddrs.push(meta.targetAddr);
      }
    }
  }
  if (sysAddrs.length > 0) userStore.enqueueProfiles(sysAddrs);

  // 1b. For rooms with unresolved names, eagerly load members from server
  //     (Matrix SDK lazy-loads members, so room.members may be empty until this call)
  const unresolved = unresolvedRoomSet.value;
  if (unresolved.size > 0) {
    const needMembers = visibleIds.filter(id => unresolved.has(id));
    if (needMembers.length > 0) chatStore.loadMembersForRooms(needMembers);
  }

  // 2. Message preload — only for rooms without data, cancellable
  chatStore.ensureRoomsLoaded(visibleIds, "high", gen);
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
  // Initial viewport profile load — retry after transition settles
  nextTick(() => {
    loadVisibleRooms();
    // Retry after transition animation (scroller may not be in DOM yet)
    setTimeout(loadVisibleRooms, 350);
  });
});
// When scroller ref becomes available (v-if becomes true), attach listener and load visible rooms
watch(scrollerRef, (val) => {
  attachScrollListener();
  if (val) nextTick(loadVisibleRooms);
});

// Eagerly load profiles for ALL rooms in the list whenever it changes.
// This replaces the scroll-dependent loadVisibleRooms for profile loading —
// profiles are cheap (user data lookups) and loadProfilesForRoomIds deduplicates
// via profilesRequestedForRooms. This ensures names resolve without scrolling.
// Also loads profiles for system message sender/target addresses (they may no
// longer be room members, e.g. the user who left the chat).
const _enqueuedSysMeta = new Set<string>();
watch(
  filteredRooms,
  (rooms) => {
    const roomIds: string[] = [];
    const sysAddrs: string[] = [];
    for (const r of rooms) {
      if (isChannel(r)) continue;
      roomIds.push(r.id);
      const meta = (r as ChatRoom).lastMessage?.systemMeta;
      if (meta) {
        if (meta.senderAddr && !_enqueuedSysMeta.has(meta.senderAddr) && !userStore.users[meta.senderAddr]) {
          sysAddrs.push(meta.senderAddr);
          _enqueuedSysMeta.add(meta.senderAddr);
        }
        if (meta.targetAddr && !_enqueuedSysMeta.has(meta.targetAddr) && !userStore.users[meta.targetAddr]) {
          sysAddrs.push(meta.targetAddr);
          _enqueuedSysMeta.add(meta.targetAddr);
        }
      }
    }
    if (roomIds.length > 0) {
      chatStore.loadProfilesForRoomIds(roomIds);
    }
    if (sysAddrs.length > 0) {
      userStore.enqueueProfiles(sysAddrs);
    }
  },
  { immediate: true },
);

// When rooms first appear (0 → N), guarantee viewport loading even if
// RecycleScroller layout wasn't settled during onMounted / scrollerRef watch.
// Uses setTimeout to give the scroller time to measure and render items.
let _roomsAppearedOnce = false;
watch(
  () => filteredRooms.value.length,
  (len) => {
    if (len > 0 && !_roomsAppearedOnce) {
      _roomsAppearedOnce = true;
      setTimeout(loadVisibleRooms, 200);
    }
  },
);
onUnmounted(() => {
  scrollEl?.removeEventListener("scroll", onScrollerScroll);
  if (scrollDebounceTimer) { clearTimeout(scrollDebounceTimer); scrollDebounceTimer = null; }
});

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

const onRoomContextMenu = (e: MouseEvent, room: ChatRoom) => {
  ctxMenu.value = { show: true, x: e.clientX, y: e.clientY, roomId: room.id };
};
</script>

<template>
  <div class="flex flex-col">
    <!-- Skeleton placeholder during initial sync -->
    <div v-if="filteredRooms.length === 0 && chatStore.isSyncing" class="flex flex-col">
      <div v-for="i in 6" :key="i" class="flex h-[68px] w-full shrink-0 items-center gap-3 px-3 py-2.5 contain-strict animate-pulse">
        <div class="h-10 w-10 shrink-0 rounded-full bg-neutral-grad-0" />
        <div class="flex min-w-0 flex-1 flex-col gap-1.5">
          <div class="h-3.5 w-2/5 rounded bg-neutral-grad-0" />
          <div class="h-3 w-3/5 rounded bg-neutral-grad-0" />
        </div>
      </div>
    </div>

    <div
      v-else-if="filteredRooms.length === 0 && chatStore.roomsInitialized"
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
      type-field="_type"
      class="h-full"
    >
      <template #default="{ item }">
        <ChannelRow
          v-if="isChannel(item)"
          :channel="(item as Channel)"
          @select="handleSelectChannel"
        />
        <ChatRoomRow
          v-else
          :room="(item as any)"
          @select="handleSelect"
          @contextmenu="onRoomContextMenu"
        />
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
.fade-enter-active,
.fade-leave-active { transition: opacity 0.15s ease; }
.fade-enter-from,
.fade-leave-to { opacity: 0; }

:deep(.vue-recycle-scroller__item-view) {
  contain: layout style;
  content-visibility: auto;
  contain-intrinsic-size: auto 68px;
}
</style>
