import { getMatrixClientService } from "@/entities/matrix";
import type { MatrixKit } from "@/entities/matrix";
import type { Pcrypto, PcryptoRoomInstance } from "@/entities/matrix/model/matrix-crypto";
import { getmatrixid, hexEncode, hexDecode } from "@/shared/lib/matrix/functions";
import { matrixIdToAddress, messageTypeFromMime, parseFileInfo, cleanMatrixIds, looksLikeProperName } from "../lib/chat-helpers";
import { cacheRooms, getCachedRooms, cacheMessages, getCachedMessages } from "@/shared/lib/cache/chat-cache";
import { useAuthStore } from "@/entities/auth/model/stores";
import { useUserStore } from "@/entities/user/model";
import { defineStore } from "pinia";
import { computed, ref, shallowRef, triggerRef } from "vue";

import type { ChatRoom, FileInfo, Message, PollInfo, ReplyTo, TransferInfo } from "./types";
import { MessageStatus, MessageType } from "./types";

const NAMESPACE = "chat";

/** Extract raw event data from a MatrixEvent object */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getRawEvent(matrixEvent: any): Record<string, unknown> | null {
  // MatrixEvent has .event property with raw data
  if (matrixEvent?.event) return matrixEvent.event;
  // Fallback: maybe it's already a raw event
  if (matrixEvent?.type && matrixEvent?.sender) return matrixEvent;
  return null;
}

/** Convert a Matrix SDK room object into our ChatRoom type */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function matrixRoomToChatRoom(room: any, kit: MatrixKit, myUserId: string, nameHints?: Record<string, string>): ChatRoom {
  const roomId = room.roomId as string;
  const name = (room.name as string) ?? roomId;
  const isGroup = !kit.isTetatetChat(room);
  const membership = (room.selfMembership ?? room.getMyMembership?.()) as "join" | "invite" | undefined;

  // Get members
  const members = kit.getRoomMembers(room);
  const memberIds = members.map((m: Record<string, unknown>) => getmatrixid(m.userId as string));

  // Unread notification count
  const unreadCount = (room.getUnreadNotificationCount?.("total") as number) ?? 0;

  // Get timeline events
  let timelineEvents: unknown[] = [];
  try {
    const liveTimeline = room.getLiveTimeline?.();
    if (liveTimeline) {
      timelineEvents = liveTimeline.getEvents?.() ?? [];
    }
    if (!timelineEvents.length) {
      timelineEvents = room.timeline ?? [];
    }
  } catch { /* ignore */ }

  // Find last message event (search backwards, skip state events)
  let lastMessage: Message | undefined;
  let lastSystemMessage: Message | undefined; // fallback: member/call events
  let lastTs = 0;
  for (let i = timelineEvents.length - 1; i >= 0; i--) {
    const raw = getRawEvent(timelineEvents[i]);
    if (!raw) continue;
    // Use timestamp from latest event (any type)
    if (!lastTs && raw.origin_server_ts) {
      lastTs = raw.origin_server_ts as number;
    }
    // Find last actual message
    if (!lastMessage && raw.type === "m.room.message" && raw.content) {
      const content = raw.content as Record<string, unknown>;
      const msgtype = content.msgtype as string;
      let previewBody: string;
      let previewType = MessageType.text;

      if (msgtype === "m.encrypted") {
        previewBody = "[encrypted]";
      } else if (msgtype === "m.file") {
        const fi = parseFileInfo(content, msgtype);
        previewBody = fi ? fi.name : "[file]";
        previewType = fi ? messageTypeFromMime(fi.type) : MessageType.file;
      } else if (msgtype === "m.image") {
        previewBody = "[photo]";
        previewType = MessageType.image;
      } else if (msgtype === "m.audio") {
        previewBody = "[voice message]";
        previewType = MessageType.audio;
      } else if (msgtype === "m.video") {
        previewBody = "[video]";
        previewType = MessageType.video;
      } else {
        previewBody = (content?.body as string) ?? "";
      }

      lastMessage = {
        id: raw.event_id as string,
        roomId,
        senderId: matrixIdToAddress(raw.sender as string),
        content: previewBody,
        timestamp: (raw.origin_server_ts as number) ?? 0,
        status: MessageStatus.sent,
        type: previewType,
      };
    }
    // Pick up system events (member join/leave, call hangup) as fallback preview
    if (!lastSystemMessage) {
      if (raw.type === "m.room.member" && raw.content) {
        const membership = (raw.content as Record<string, unknown>).membership as string;
        const sender = matrixIdToAddress(raw.sender as string);
        const senderName = nameHints?.[sender] || sender.slice(0, 8) + "...";
        const stateKey = raw.state_key as string | undefined;
        const targetAddr = stateKey ? matrixIdToAddress(stateKey) : sender;
        const targetName = targetAddr !== sender
          ? (nameHints?.[targetAddr] || targetAddr.slice(0, 8) + "...")
          : senderName;
        const isSelf = targetAddr === sender;
        let text = "";
        let template = "";
        if (membership === "join") { text = isSelf ? `${senderName} joined the chat` : `${senderName} added ${targetName}`; template = isSelf ? "{sender} joined the chat" : "{sender} added {target}"; }
        else if (membership === "leave") { text = isSelf ? `${senderName} left the chat` : `${senderName} removed ${targetName}`; template = isSelf ? "{sender} left the chat" : "{sender} removed {target}"; }
        else if (membership === "invite") { text = `${senderName} invited ${targetName}`; template = "{sender} invited {target}"; }
        if (text) {
          lastSystemMessage = {
            id: raw.event_id as string, roomId, senderId: sender,
            content: text, timestamp: (raw.origin_server_ts as number) ?? 0,
            status: MessageStatus.sent, type: MessageType.system,
            systemMeta: { template, senderAddr: sender, targetAddr: targetAddr !== sender ? targetAddr : undefined },
          };
        }
      } else if (raw.type === "m.call.hangup") {
        const callContent = raw.content as Record<string, unknown>;
        const reason = callContent.reason as string | undefined;
        const isVideo = (callContent as any).offer_type === "video"
          || (callContent as any).version === 1;
        const durationMs = typeof callContent.duration === "number" ? callContent.duration : 0;
        const sender = matrixIdToAddress(raw.sender as string);
        const senderName = nameHints?.[sender] || sender.slice(0, 8) + "...";
        const text = reason === "invite_timeout" ? `Missed call from ${senderName}` : `Call with ${senderName}`;
        const callTemplate = reason === "invite_timeout" ? "Missed call from {sender}" : "Call with {sender}";
        lastSystemMessage = {
          id: raw.event_id as string, roomId, senderId: sender,
          content: text, timestamp: (raw.origin_server_ts as number) ?? 0,
          status: MessageStatus.sent, type: MessageType.system,
          callInfo: { callType: isVideo ? "video" : "voice", missed: reason === "invite_timeout", duration: Math.round(durationMs / 1000) },
          systemMeta: { template: callTemplate, senderAddr: sender },
        };
      }
    }
    if (lastMessage && lastTs) break;
  }
  // Use system event as fallback if no real message found
  if (!lastMessage && lastSystemMessage) {
    lastMessage = lastSystemMessage;
  }

  // Resolve display name
  let displayName = name;
  if (!isGroup) {
    // 1:1 chat: use the other member's rawDisplayName, then nameHints (user store), then address
    const otherMember = members.find(
      (m: Record<string, unknown>) => getmatrixid(m.userId as string) !== getmatrixid(myUserId)
    );
    const otherAddress = otherMember ? matrixIdToAddress(otherMember.userId as string) : null;
    const rawDN = (otherMember?.rawDisplayName as string) || "";
    const memberName = (otherMember?.name as string) || "";
    // rawDisplayName might be a hex ID — only use it if it looks human-readable
    const isHumanName = (s: string) => !!s && !/^[a-f0-9]{20,}$/i.test(s) && !s.startsWith("@");
    displayName = (isHumanName(rawDN) ? rawDN : null)
      || (isHumanName(memberName) ? memberName : null)
      || (otherAddress && nameHints?.[otherAddress])
      || otherAddress
      // If room name is a Matrix ID like @hexid:domain, extract and decode the address
      || (name.startsWith("@") ? matrixIdToAddress(name) : null)
      || name;
  } else if (name.startsWith("#") && name.length > 20) {
    // Group with auto-generated hash name: build from member display names
    const memberNames = members
      .filter((m: Record<string, unknown>) => getmatrixid(m.userId as string) !== getmatrixid(myUserId))
      .map((m: Record<string, unknown>) => (m.rawDisplayName as string) || (m.name as string) || "?")
      .slice(0, 3);
    displayName = memberNames.join(", ") + (members.length > 4 ? "..." : "");
  }

  // Resolve avatar URL
  let avatar: string | undefined;
  if (!isGroup) {
    // 1:1: use the other member's address (UserAvatar will resolve via Pocketnet)
    // We store the address so ContactList can use UserAvatar
    const otherMember = members.find(
      (m: Record<string, unknown>) => getmatrixid(m.userId as string) !== getmatrixid(myUserId)
    );
    if (otherMember) {
      avatar = `__pocketnet__:${matrixIdToAddress(otherMember.userId as string)}`;
    }
  } else {
    // Group: try to get room avatar from Matrix state, convert mxc:// to HTTP
    try {
      const avatarEvent = room.currentState?.getStateEvents?.("m.room.avatar", "");
      const avatarUrl = avatarEvent?.getContent?.()?.url ?? avatarEvent?.event?.content?.url;
      if (avatarUrl && typeof avatarUrl === "string") {
        const matrixService = getMatrixClientService();
        avatar = matrixService.mxcToHttp(avatarUrl) ?? avatarUrl;
      }
    } catch { /* ignore */ }
  }

  // Read room topic
  let topic: string | undefined;
  try {
    const topicEvent = room.currentState?.getStateEvents?.("m.room.topic", "");
    const topicContent = topicEvent?.getContent?.()?.topic ?? topicEvent?.event?.content?.topic;
    if (topicContent && typeof topicContent === "string") {
      topic = topicContent;
    }
  } catch { /* ignore */ }

  return {
    id: roomId,
    name: displayName,
    avatar,
    lastMessage,
    unreadCount,
    members: memberIds,
    isGroup,
    updatedAt: lastTs || 0,
    membership: membership === "invite" ? "invite" : "join",
    topic,
  };
}

export const useChatStore = defineStore(NAMESPACE, () => {
  const rooms = shallowRef<ChatRoom[]>([]);
  const roomsMap = new Map<string, ChatRoom>(); // O(1) lookup index
  const activeRoomId = ref<string | null>(null);
  const messages = shallowRef<Record<string, Message[]>>({});
  const typing = ref<Record<string, string[]>>({});
  const replyingTo = ref<ReplyTo | null>(null);

  /** True after the first refreshRoomsImmediate completes (rooms list is authoritative) */
  const roomsInitialized = ref(false);
  /** True after user profiles have been loaded for room members */
  const namesReady = ref(false);

  // Cache for decrypted room previews — persists across refreshRooms() rebuilds
  const decryptedPreviewCache = new Map<string, string>();

  // Debounce timer for refreshRooms
  let refreshDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Diff-based refresh: track which rooms changed since last refresh
  const changedRoomIds = new Set<string>();
  let lastSyncState: "PREPARED" | "SYNCING" | null = null;
  let lastFullRefresh = 0;
  const FULL_REFRESH_INTERVAL = 60_000; // Reconciliation fallback
  let membersLoadedOnce = false; // One-time member loading for stale lazy-load cache

  /** Mark a room as changed so the next incremental refresh processes it */
  const markRoomChanged = (roomId: string) => {
    changedRoomIds.add(roomId);
  };

  /** O(1) room lookup by ID (falls back to array scan if map is stale) */
  const getRoomById = (roomId: string): ChatRoom | undefined => {
    const cached = roomsMap.get(roomId);
    if (cached) return cached;
    // Fallback: array scan for rooms added directly (e.g. tests pushing to rooms.value)
    const found = rooms.value.find(r => r.id === roomId);
    if (found) roomsMap.set(roomId, found); // Repair map
    return found;
  };

  /** Rebuild roomsMap index from rooms array */
  const rebuildRoomsMap = () => {
    roomsMap.clear();
    for (const r of rooms.value) {
      roomsMap.set(r.id, r);
    }
  };

  // Debounced room caching — max once per 5 seconds
  let cacheTimer: ReturnType<typeof setTimeout> | null = null;
  const debouncedCacheRooms = () => {
    if (cacheTimer) clearTimeout(cacheTimer);
    cacheTimer = setTimeout(() => {
      // Never cache empty rooms — protects against premature calls before sync completes
      if (rooms.value.length > 0) {
        cacheRooms(rooms.value).catch(() => {});
      }
      cacheTimer = null;
    }, 5000);
  };

  // Track rooms that failed decryption — retry with backoff instead of permanent block
  const decryptFailedRooms = new Map<string, { count: number; lastAttempt: number }>();
  const DECRYPT_RETRY_DELAY = 10_000; // 10s before retrying a failed room
  const DECRYPT_MAX_RETRIES = 3;

  // Edit/delete state (Batch 3)
  const editingMessage = ref<{ id: string; content: string } | null>(null);
  const deletingMessage = ref<Message | null>(null);

  // User display name cache: address → display name
  const userDisplayNames = ref<Record<string, string>>({});

  /** Look up a user's display name; falls back to truncated address.
   *  Accepts both raw Bastyon addresses and hex-encoded IDs (from room.members).
   *  Also checks the user store (restored from localStorage on startup) to avoid
   *  showing raw addresses while Matrix sync is still in progress. */
  const getDisplayName = (address: string): string => {
    if (!address) return "?";
    // Direct lookup (raw address)
    const cached = userDisplayNames.value[address];
    if (cached) return cached;
    // Try hex-decoded lookup (room.members stores hex IDs, cache uses raw addresses)
    let resolvedAddr = address;
    if (/^[a-f0-9]+$/i.test(address)) {
      try {
        const decoded = hexDecode(address);
        if (decoded !== address && /^[A-Za-z0-9]+$/.test(decoded)) {
          const decodedCached = userDisplayNames.value[decoded];
          if (decodedCached) return decodedCached;
          resolvedAddr = decoded;
        }
      } catch { /* not a valid hex string */ }
    }
    // Check user store (synchronously restored from localStorage — available before Matrix sync)
    const uStore = useUserStore();
    const userProfile = uStore.users[resolvedAddr];
    if (userProfile?.name) return userProfile.name;
    // Fallback: truncated address
    if (address.length > 16) return address.slice(0, 8) + "\u2026" + address.slice(-4);
    return address;
  };

  // Selection/forward state (Batch 4)
  const selectionMode = ref(false);
  const selectedMessageIds = ref<Set<string>>(new Set());
  const forwardingMessages = ref(false);

  const enterSelectionMode = (messageId: string) => {
    selectionMode.value = true;
    selectedMessageIds.value = new Set([messageId]);
  };

  const toggleSelection = (messageId: string) => {
    const s = selectedMessageIds.value;
    if (s.has(messageId)) s.delete(messageId);
    else s.add(messageId);
    selectedMessageIds.value = new Set(s);
  };

  const exitSelectionMode = () => {
    selectionMode.value = false;
    selectedMessageIds.value = new Set();
    forwardingMessages.value = false;
  };

  // Server-synced pinned messages (m.room.pinned_events state event)
  const pinnedMessages = ref<Message[]>([]);
  const pinnedMessageIndex = ref(0);

  /** Load pinned messages from room state (m.room.pinned_events) */
  const loadPinnedMessages = async (roomId: string) => {
    try {
      const matrixService = getMatrixClientService();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const matrixRoom = matrixService.getRoom(roomId) as any;
      if (!matrixRoom) return;
      const pinEvent = matrixRoom.currentState?.getStateEvents?.("m.room.pinned_events", "");
      const pinnedIds: string[] = pinEvent?.getContent?.()?.pinned ?? pinEvent?.event?.content?.pinned ?? [];
      if (pinnedIds.length === 0) {
        pinnedMessages.value = [];
        pinnedMessageIndex.value = 0;
        return;
      }
      // Resolve event IDs to Message objects from loaded messages
      const roomMsgs = messages.value[roomId] ?? [];
      const resolved: Message[] = [];
      for (const eventId of pinnedIds) {
        const msg = roomMsgs.find(m => m.id === eventId);
        if (msg) resolved.push(msg);
      }
      pinnedMessages.value = resolved;
      pinnedMessageIndex.value = Math.min(pinnedMessageIndex.value, Math.max(0, resolved.length - 1));
    } catch (e) {
      console.warn("[chat-store] loadPinnedMessages error:", e);
    }
  };

  /** Pin a message (server-synced via m.room.pinned_events state event) */
  const pinMessage = async (messageId: string) => {
    const roomId = activeRoomId.value;
    if (!roomId) return;
    try {
      const matrixService = getMatrixClientService();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const matrixRoom = matrixService.getRoom(roomId) as any;
      if (!matrixRoom) return;
      const pinEvent = matrixRoom.currentState?.getStateEvents?.("m.room.pinned_events", "");
      const currentPinned: string[] = pinEvent?.getContent?.()?.pinned ?? pinEvent?.event?.content?.pinned ?? [];
      if (currentPinned.includes(messageId)) return; // already pinned
      const newPinned = [...currentPinned, messageId];
      await matrixService.sendStateEvent(roomId, "m.room.pinned_events", { pinned: newPinned }, "");
      // Optimistic update
      const msg = messages.value[roomId]?.find(m => m.id === messageId);
      if (msg && !pinnedMessages.value.some(p => p.id === messageId)) {
        pinnedMessages.value = [...pinnedMessages.value, msg];
        pinnedMessageIndex.value = pinnedMessages.value.length - 1;
      }
    } catch (e) {
      console.warn("[chat-store] pinMessage error:", e);
    }
  };

  /** Unpin a message (server-synced) */
  const unpinMessage = async (messageId: string) => {
    const roomId = activeRoomId.value;
    if (!roomId) return;
    try {
      const matrixService = getMatrixClientService();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const matrixRoom = matrixService.getRoom(roomId) as any;
      if (!matrixRoom) return;
      const pinEvent = matrixRoom.currentState?.getStateEvents?.("m.room.pinned_events", "");
      const currentPinned: string[] = pinEvent?.getContent?.()?.pinned ?? pinEvent?.event?.content?.pinned ?? [];
      const newPinned = currentPinned.filter(id => id !== messageId);
      await matrixService.sendStateEvent(roomId, "m.room.pinned_events", { pinned: newPinned }, "");
      // Optimistic update
      pinnedMessages.value = pinnedMessages.value.filter(m => m.id !== messageId);
      if (pinnedMessageIndex.value >= pinnedMessages.value.length) {
        pinnedMessageIndex.value = Math.max(0, pinnedMessages.value.length - 1);
      }
    } catch (e) {
      console.warn("[chat-store] unpinMessage error:", e);
    }
  };

  const cyclePinnedMessage = (direction: 1 | -1) => {
    if (pinnedMessages.value.length === 0) return;
    pinnedMessageIndex.value = (pinnedMessageIndex.value + direction + pinnedMessages.value.length) % pinnedMessages.value.length;
  };

  // Room-level pin/mute (Batch 7)
  const pinnedRoomIds = ref<Set<string>>(new Set(JSON.parse(localStorage.getItem("chat_pinned_rooms") || "[]")));
  const mutedRoomIds = ref<Set<string>>(new Set(JSON.parse(localStorage.getItem("chat_muted_rooms") || "[]")));

  const persistRoomSets = () => {
    localStorage.setItem("chat_pinned_rooms", JSON.stringify([...pinnedRoomIds.value]));
    localStorage.setItem("chat_muted_rooms", JSON.stringify([...mutedRoomIds.value]));
  };

  const togglePinRoom = (roomId: string) => {
    const s = new Set(pinnedRoomIds.value);
    if (s.has(roomId)) s.delete(roomId);
    else s.add(roomId);
    pinnedRoomIds.value = s;
    persistRoomSets();
  };

  const toggleMuteRoom = (roomId: string) => {
    const s = new Set(mutedRoomIds.value);
    if (s.has(roomId)) s.delete(roomId);
    else s.add(roomId);
    mutedRoomIds.value = s;
    persistRoomSets();
  };

  const markRoomAsRead = (roomId: string) => {
    const room = getRoomById(roomId);
    if (room) room.unreadCount = 0;
  };

  // References to matrix helpers (set by auth store after init)
  const matrixKitRef = shallowRef<MatrixKit | null>(null);
  const pcryptoRef = shallowRef<Pcrypto | null>(null);

  const activeRoom = computed(() => {
    // Access rooms.value to register Vue reactive dependency
    void rooms.value;
    return activeRoomId.value ? getRoomById(activeRoomId.value) : undefined;
  });

  // Spread ensures a new array reference on every recompute, so dependents
  // (virtualItems, RecycleScroller) always see the change even with shallowRef.
  const activeMessages = computed(() =>
    activeRoomId.value ? [...(messages.value[activeRoomId.value] ?? [])] : []
  );

  const activeMediaMessages = computed(() =>
    activeMessages.value.filter(m => m.type === MessageType.image || m.type === MessageType.video)
  );

  const sortedRooms = computed(() =>
    [...rooms.value]
      .filter(r => !deletedRoomIds.value.has(r.id))
      .sort((a, b) => {
        // Pinned rooms first
        const aPinned = pinnedRoomIds.value.has(a.id) ? 1 : 0;
        const bPinned = pinnedRoomIds.value.has(b.id) ? 1 : 0;
        if (aPinned !== bPinned) return bPinned - aPinned;
        // Chronological — most recent activity first (matches original bastyon-chat)
        return b.updatedAt - a.updatedAt;
      })
  );

  const totalUnread = computed(() =>
    rooms.value.reduce((sum, r) => sum + r.unreadCount, 0)
  );

  /** Set helper references from auth store */
  const setHelpers = (kit: MatrixKit, crypto: Pcrypto) => {
    matrixKitRef.value = kit;
    pcryptoRef.value = crypto;
  };


  /** Internal: actual refresh logic (called by debounced wrapper) */
  const PRELOAD_COUNT = 15;
  let preloadDone = false;

  /** Background-preload messages for the top visible rooms so opening them feels instant */
  const preloadVisibleRooms = async () => {
    if (preloadDone) return;
    preloadDone = true;

    const roomsToPreload = sortedRooms.value
      .slice(0, PRELOAD_COUNT)
      .filter(r => r.id !== activeRoomId.value && r.membership !== "invite");

    // Phase 1: Load all cached messages in parallel (fast, IndexedDB)
    await Promise.all(
      roomsToPreload.map(room =>
        messages.value[room.id]?.length ? Promise.resolve() : loadCachedMessages(room.id).catch(() => {})
      )
    );

    // Phase 2: Load fresh data from Matrix in small batches
    const BATCH = 5;
    for (let i = 0; i < roomsToPreload.length; i += BATCH) {
      const batch = roomsToPreload.slice(i, i + BATCH);
      await Promise.all(
        batch.map(room => loadRoomMessages(room.id).catch(() => {}))
      );
      // Yield to UI between batches
      await new Promise(r => setTimeout(r, 0));
    }
  };

  /** Full room rebuild — used for initial sync and periodic reconciliation */
  const fullRoomRefresh = (
    matrixRooms: any[],
    kit: MatrixKit,
    myUserId: string,
  ) => {
    // Retry previously failed decryptions on full refresh
    decryptFailedRooms.clear();

    // Preserve existing room data — addRoom/addMessage/cache may have set data that Matrix can't resolve yet
    const prevNameMap = new Map(rooms.value.map(r => [r.id, r.name]));
    const prevLastMessageMap = new Map(rooms.value.map(r => [r.id, r.lastMessage]));
    const prevMembersMap = new Map(rooms.value.map(r => [r.id, r.members]));
    const prevAvatarMap = new Map(rooms.value.map(r => [r.id, r.avatar]));
    const prevActiveRoom = activeRoomId.value ? getRoomById(activeRoomId.value) : undefined;

    const interactiveRooms = filterInteractiveRooms(matrixRooms);

    const newRooms = interactiveRooms
      .map((r) => {
        const room = buildChatRoom(r, kit, myUserId, prevNameMap, prevLastMessageMap);
        // Preserve cached members if Matrix SDK returned fewer (lazy-load issue)
        const prevMembers = prevMembersMap.get(room.id);
        if (prevMembers && prevMembers.length > room.members.length) {
          room.members = prevMembers;
          const prevAvatar = prevAvatarMap.get(room.id);
          if (prevAvatar) room.avatar = prevAvatar;
        }
        return room;
      });

    // Ensure active room is in the list before assigning (prevents "no chat selected" flash)
    if (prevActiveRoom && !newRooms.some(r => r.id === prevActiveRoom.id)) {
      newRooms.push(prevActiveRoom);
    }

    rooms.value = newRooms;
    rebuildRoomsMap();

    // Build user display name cache from room members (sync — no API calls)
    // Only run loadMissingMembers once AND only when we have actual rooms
    const willLoadMembers = !membersLoadedOnce && interactiveRooms.length > 0;
    updateDisplayNames(interactiveRooms, kit, willLoadMembers);

    // Eagerly load profiles for the first viewport of rooms (top ~15)
    const viewportIds = sortedRooms.value.slice(0, 15).map(r => r.id);
    if (viewportIds.length > 0) loadProfilesForRoomIds(viewportIds);

    // One-time: load members for rooms with stale lazy-load cache (only 1 member = self)
    if (willLoadMembers) {
      membersLoadedOnce = true;
      loadMissingMembers(interactiveRooms, kit, myUserId);
    }

    // Decrypt [encrypted] previews asynchronously — results go to cache
    decryptRoomPreviews(interactiveRooms).then(() => debouncedCacheRooms());
    debouncedCacheRooms();
  };

  /** One-time: load members from server for rooms with only self as member.
   *  Updates room member lists + avatars. Profile loading is handled lazily by loadProfilesForRoomIds. */
  const loadMissingMembers = async (matrixRooms: any[], kit: MatrixKit, myUserId: string) => {
    const myHexId = getmatrixid(myUserId);
    const toLoad: any[] = [];

    // Find rooms that need member loading (only self as member)
    for (const mr of matrixRooms) {
      const members = kit.getRoomMembers(mr);
      const memberIds = members.map((m: Record<string, unknown>) => getmatrixid(m.userId as string));
      const others = memberIds.filter(id => id !== myHexId);

      if (others.length === 0 && typeof mr.loadMembersIfNeeded === "function") {
        toLoad.push(mr);
      }
    }

    // Phase 1: Load missing members from server (no reactive updates)
    if (toLoad.length > 0) {
      const BATCH = 20;
      for (let i = 0; i < toLoad.length; i += BATCH) {
        const batch = toLoad.slice(i, i + BATCH);
        await Promise.all(batch.map(async (mr: any) => {
          try { await mr.loadMembersIfNeeded(); } catch { /* ignore */ }
        }));
        await new Promise(r => setTimeout(r, 0));
      }
    }

    // Phase 2: Apply room member updates from loaded rooms
    const roomUpdates: Array<{ room: ChatRoom; memberIds: string[]; avatar?: string }> = [];
    for (const mr of toLoad) {
      const roomId = mr.roomId as string;
      const room = getRoomById(roomId);
      if (!room) continue;
      const members = kit.getRoomMembers(mr);
      const memberIds = members.map((m: Record<string, unknown>) => getmatrixid(m.userId as string));

      // Update matrixRoomAddresses with newly loaded members
      const addrs: string[] = [];
      for (const m of members) {
        const addr = matrixIdToAddress((m as Record<string, unknown>).userId as string);
        if (addr && /^[A-Za-z0-9]+$/.test(addr)) addrs.push(addr);
      }
      if (addrs.length > 0) matrixRoomAddresses.set(roomId, addrs);

      if (memberIds.length <= room.members.length) continue;
      let avatar: string | undefined;
      if (!room.isGroup) {
        const otherHex = memberIds.find(id => id !== myHexId);
        if (otherHex) {
          const decoded = hexDecode(otherHex);
          if (/^[A-Za-z0-9]+$/.test(decoded)) {
            avatar = `__pocketnet__:${decoded}`;
          }
        }
      }
      roomUpdates.push({ room, memberIds, avatar });
    }

    // Single reactive update
    for (const { room, memberIds, avatar } of roomUpdates) {
      room.members = memberIds;
      if (avatar) room.avatar = avatar;
    }
    if (roomUpdates.length > 0) {
      triggerRef(rooms);
    }

    // Re-request profiles for ALL rooms that were loaded (not just updated)
    // This ensures rooms that initially had no members now get profiles loaded
    if (toLoad.length > 0) {
      const loadedIds = toLoad.map((mr: any) => mr.roomId as string);
      for (const id of loadedIds) profilesRequestedForRooms.delete(id);
      loadProfilesForRoomIds(loadedIds);
    }

    // Persist and signal ready
    debouncedCacheRooms();
    namesReady.value = true;
  };

  /** Incremental room refresh — only processes changed rooms */
  const incrementalRoomRefresh = (
    matrixRooms: any[],
    kit: MatrixKit,
    myUserId: string,
    changed: Set<string>,
  ) => {
    const matrixRoomMap = new Map<string, any>();
    for (const mr of matrixRooms) matrixRoomMap.set(mr.roomId as string, mr);

    // Detect new rooms (not in our map yet)
    for (const mr of matrixRooms) {
      if (!roomsMap.has(mr.roomId as string)) changed.add(mr.roomId as string);
    }

    // Remove rooms that no longer exist in Matrix
    const matrixRoomIds = new Set(matrixRooms.map((r: any) => r.roomId as string));
    let removed = false;
    rooms.value = rooms.value.filter(r => {
      if (!matrixRoomIds.has(r.id) || deletedRoomIds.value.has(r.id)) {
        roomsMap.delete(r.id);
        removed = true;
        return false;
      }
      return true;
    });

    // Rebuild only changed rooms
    const changedMatrixRooms: any[] = [];
    for (const roomId of changed) {
      const matrixRoom = matrixRoomMap.get(roomId);
      if (!matrixRoom) continue;

      // Check this room is still interactive
      if (deletedRoomIds.value.has(roomId)) continue;
      const membership = matrixRoom.selfMembership ?? matrixRoom.getMyMembership?.();
      if (membership !== "join" && membership !== "invite") continue;
      try {
        const createEvent = matrixRoom.currentState?.getStateEvents?.("m.room.create", "");
        const createContent = createEvent?.getContent?.() ?? createEvent?.event?.content;
        if (createContent?.type === "m.space") continue;
      } catch { /* ignore */ }

      const chatRoom = buildChatRoom(matrixRoom, kit, myUserId);
      const existing = roomsMap.get(roomId);
      if (existing) {
        // Preserve richer members list from cache/previous load
        if (existing.members.length > chatRoom.members.length) {
          chatRoom.members = existing.members;
          chatRoom.avatar = existing.avatar;
        }
        // Update in-place to preserve Vue reactivity references
        Object.assign(existing, chatRoom);
      } else {
        rooms.value.push(chatRoom);
        roomsMap.set(roomId, chatRoom);
      }
      changedMatrixRooms.push(matrixRoom);
    }

    if (changed.size > 0 || removed) {
      triggerRef(rooms);
    }

    // Update display names only for changed rooms
    updateDisplayNames(changedMatrixRooms, kit);

    // Load profiles for changed rooms (lazy — skips already-requested)
    if (changedMatrixRooms.length > 0) {
      loadProfilesForRoomIds(changedMatrixRooms.map((r: any) => r.roomId as string));
    }

    // Decrypt previews only for changed rooms
    if (changedMatrixRooms.length > 0) {
      const changedIds = new Set(changedMatrixRooms.map((r: any) => r.roomId as string));
      decryptRoomPreviews(changedMatrixRooms, changedIds).then(() => debouncedCacheRooms());
    }
    debouncedCacheRooms();
  };

  /** Filter Matrix rooms to interactive ones (joined/invited, non-spaces) */
  const filterInteractiveRooms = (matrixRooms: any[]): any[] => {
    return matrixRooms.filter((r) => {
      if (deletedRoomIds.value.has(r.roomId as string)) return false;
      const membership = r.selfMembership ?? r.getMyMembership?.();
      if (membership !== "join" && membership !== "invite") return false;
      try {
        const createEvent = r.currentState?.getStateEvents?.("m.room.create", "");
        const createContent = createEvent?.getContent?.() ?? createEvent?.event?.content;
        if (createContent?.type === "m.space") return false;
      } catch { /* ignore */ }
      return true;
    });
  };

  /** Build a single ChatRoom with name/lastMessage resolution.
   *  When prevNameMap/prevLastMessageMap are provided (full refresh), uses them.
   *  Otherwise falls back to roomsMap for O(1) lookup (incremental refresh). */
  const buildChatRoom = (
    r: any,
    kit: MatrixKit,
    myUserId: string,
    prevNameMap?: Map<string, string>,
    prevLastMessageMap?: Map<string, Message | undefined>,
  ): ChatRoom => {
    const chatRoom = matrixRoomToChatRoom(r, kit, myUserId, userDisplayNames.value);
    if (chatRoom.id === activeRoomId.value) chatRoom.unreadCount = 0;

    // Use provided maps (full refresh) or fall back to roomsMap (incremental)
    const prev = prevNameMap ? undefined : roomsMap.get(chatRoom.id);

    if (!chatRoom.isGroup) {
      const addr = chatRoom.avatar?.startsWith("__pocketnet__:")
        ? chatRoom.avatar.slice("__pocketnet__:".length)
        : undefined;
      if (!looksLikeProperName(chatRoom.name, addr)) {
        const prevName = prevNameMap ? prevNameMap.get(chatRoom.id) : prev?.name;
        if (prevName && looksLikeProperName(prevName, addr)) {
          chatRoom.name = prevName;
        } else if (chatRoom.name.startsWith("@") && chatRoom.name.includes(":")) {
          chatRoom.name = matrixIdToAddress(chatRoom.name);
        }
      }
    }

    // Determine best lastMessage: prefer decrypted over "[encrypted]", newer over older.
    const candidates: Array<Message | undefined> = [chatRoom.lastMessage];
    const loadedMsgs = messages.value[chatRoom.id];
    if (loadedMsgs?.length) candidates.push(loadedMsgs[loadedMsgs.length - 1]);
    const prevLast = prevLastMessageMap ? prevLastMessageMap.get(chatRoom.id) : prev?.lastMessage;
    if (prevLast) candidates.push(prevLast);

    let best: Message | undefined;
    for (const c of candidates) {
      if (!c) continue;
      const cEncrypted = c.content === "[encrypted]";
      const bestEncrypted = best ? best.content === "[encrypted]" : true;
      if (!best || (bestEncrypted && !cEncrypted) || (bestEncrypted === cEncrypted && c.timestamp > best.timestamp)) {
        best = c;
      }
    }
    if (best) {
      chatRoom.lastMessage = best;
      chatRoom.updatedAt = Math.max(chatRoom.updatedAt, best.timestamp);
    }

    // Apply cached decrypted previews
    if (chatRoom.lastMessage?.content === "[encrypted]") {
      const cached = decryptedPreviewCache.get(chatRoom.id);
      if (cached) {
        chatRoom.lastMessage = { ...chatRoom.lastMessage, content: cached };
      }
    }

    return chatRoom;
  };

  /** Per-room addresses collected from Matrix SDK (most complete source).
   *  Populated by updateDisplayNames, consumed by loadProfilesForRoomIds. */
  const matrixRoomAddresses = new Map<string, string[]>();

  /** Update display name cache from Matrix SDK room members.
   *  Collects addresses per room for later viewport-based profile loading.
   *  @param skipNamesReady — if true, don't set namesReady (loadMissingMembers will do it) */
  const updateDisplayNames = (matrixRooms: any[], kit: MatrixKit, skipNamesReady = false) => {
    for (const r of matrixRooms) {
      const roomId = r.roomId as string;
      const members = kit.getRoomMembers(r);
      const roomAddrs: string[] = [];
      for (const m of members) {
        const addr = matrixIdToAddress((m as Record<string, unknown>).userId as string);
        const dn = (m as Record<string, unknown>).rawDisplayName as string
          || (m as Record<string, unknown>).name as string;
        if (addr && dn && dn !== addr) {
          userDisplayNames.value[addr] = dn;
        }
        if (addr && /^[A-Za-z0-9]+$/.test(addr)) {
          roomAddrs.push(addr);
        }
      }
      if (roomAddrs.length > 0) matrixRoomAddresses.set(roomId, roomAddrs);
    }
    if (!skipNamesReady && rooms.value.length > 0) {
      namesReady.value = true;
    }
  };

  /** Set of room IDs whose member profiles have already been requested */
  const profilesRequestedForRooms = new Set<string>();

  /** Load user profiles for members of specific rooms (viewport-based lazy loading).
   *  Uses Matrix SDK addresses when available (most complete), falls back to ChatRoom.members.
   *  Only marks a room as "requested" if we actually found addresses to load or all are cached. */
  const loadProfilesForRoomIds = (roomIds: string[]) => {
    const uStore = useUserStore();
    const addressesToLoad: string[] = [];
    for (const roomId of roomIds) {
      if (profilesRequestedForRooms.has(roomId)) continue;

      // Prefer Matrix SDK addresses (populated by updateDisplayNames)
      const sdkAddrs = matrixRoomAddresses.get(roomId);
      if (sdkAddrs && sdkAddrs.length > 0) {
        profilesRequestedForRooms.add(roomId);
        for (const addr of sdkAddrs) {
          if (!uStore.users[addr]) addressesToLoad.push(addr);
        }
        continue;
      }

      // Fallback: decode from ChatRoom.members (for cached rooms without Matrix data)
      const room = getRoomById(roomId);
      if (!room) continue;
      let foundAddrs = false;
      for (const hexId of room.members) {
        try {
          const addr = hexDecode(hexId);
          if (addr && /^[A-Za-z0-9]+$/.test(addr)) {
            foundAddrs = true;
            if (!uStore.users[addr]) addressesToLoad.push(addr);
          }
        } catch { /* ignore invalid hex */ }
      }
      // Only mark as requested if we found member addresses (otherwise retry later when members load)
      if (foundAddrs) profilesRequestedForRooms.add(roomId);
    }
    if (addressesToLoad.length > 0) {
      uStore.loadUsersBatch([...new Set(addressesToLoad)]);
    }
  };

  const refreshRoomsImmediate = () => {
    const matrixService = getMatrixClientService();
    const kit = matrixKitRef.value;
    if (!matrixService.isReady() || !kit) {
      return;
    }

    const myUserId = matrixService.getUserId() ?? "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const matrixRooms = matrixService.getRooms() as any[];

    // Determine if we need a full rebuild or incremental update
    const isInitial = lastSyncState === "PREPARED" || !roomsInitialized.value;
    const forceFullRefresh = Date.now() - lastFullRefresh > FULL_REFRESH_INTERVAL;
    const changed = new Set(changedRoomIds);
    changedRoomIds.clear();

    if (isInitial || forceFullRefresh) {
      lastFullRefresh = Date.now();
      fullRoomRefresh(matrixRooms, kit, myUserId);
    } else {
      incrementalRoomRefresh(matrixRooms, kit, myUserId, changed);
    }

    // Mark rooms as initialized (first sync-based refresh complete)
    if (!roomsInitialized.value) {
      roomsInitialized.value = true;
      // Start background preloading after rooms are built
      // Delay lets the UI render the room list and decrypt previews first
      setTimeout(() => preloadVisibleRooms(), 500);
    }
  };

  /** Debounced refresh: batches multiple rapid calls into one (150ms window) */
  const refreshRooms = (state?: "PREPARED" | "SYNCING") => {
    if (state) lastSyncState = state;
    if (refreshDebounceTimer) clearTimeout(refreshDebounceTimer);
    refreshDebounceTimer = setTimeout(() => {
      refreshDebounceTimer = null;
      refreshRoomsImmediate();
    }, 150);
  };

  /** Force immediate refresh (used after init when first load must be instant) */
  const refreshRoomsNow = () => {
    if (refreshDebounceTimer) {
      clearTimeout(refreshDebounceTimer);
      refreshDebounceTimer = null;
    }
    lastSyncState = "PREPARED"; // Force full refresh
    refreshRoomsImmediate();
  };

  /** Decrypt last-message previews for rooms that show [encrypted].
   *  Results are stored in decryptedPreviewCache so they survive room list rebuilds.
   *  @param onlyRoomIds — if provided, only decrypt rooms in this set (incremental mode) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const decryptRoomPreviews = async (matrixRooms: any[], onlyRoomIds?: Set<string>) => {
    // Collect rooms that need decryption
    const toDecrypt: Array<{ roomId: string; matrixRoom: unknown }> = [];
    for (const matrixRoom of matrixRooms) {
      const roomId = matrixRoom.roomId as string;
      if (onlyRoomIds && !onlyRoomIds.has(roomId)) continue;
      if (decryptedPreviewCache.has(roomId)) continue; // already decrypted
      const failInfo = decryptFailedRooms.get(roomId);
      if (failInfo) {
        if (failInfo.count >= DECRYPT_MAX_RETRIES) continue;
        if (Date.now() - failInfo.lastAttempt < DECRYPT_RETRY_DELAY) continue;
      }
      const room = getRoomById(roomId);
      const lmc = room?.lastMessage?.content;
      if (!lmc || (lmc !== "[encrypted]" && lmc !== "[no room crypto]")) continue;
      toDecrypt.push({ roomId, matrixRoom });
    }
    if (toDecrypt.length === 0) return;

    // Cap at 20 rooms per cycle to avoid blocking
    const capped = toDecrypt.slice(0, 20);

    // Decrypt in small batches (5 at a time) with incremental UI updates
    const BATCH = 5;
    for (let i = 0; i < capped.length; i += BATCH) {
      const batch = capped.slice(i, i + BATCH);
      let batchUpdated = false;

      await Promise.all(batch.map(async ({ roomId, matrixRoom }) => {
        try {
          const roomCrypto = await ensureRoomCrypto(roomId);
          if (!roomCrypto) return;

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let timelineEvents: unknown[] = [];
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const lt = (matrixRoom as any).getLiveTimeline?.();
            if (lt) timelineEvents = lt.getEvents?.() ?? [];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if (!timelineEvents.length) timelineEvents = (matrixRoom as any).timeline ?? [];
          } catch { /* ignore */ }

          for (let j = timelineEvents.length - 1; j >= 0; j--) {
            const raw = getRawEvent(timelineEvents[j]);
            if (!raw?.content || raw.type !== "m.room.message") continue;
            const content = raw.content as Record<string, unknown>;
            if (content.msgtype !== "m.encrypted") continue;

            try {
              const decrypted = await roomCrypto.decryptEvent(raw);
              if (decrypted.body) {
                decryptedPreviewCache.set(roomId, decrypted.body);
                const room = getRoomById(roomId);
                if (room?.lastMessage) {
                  room.lastMessage = { ...room.lastMessage, content: decrypted.body };
                  batchUpdated = true;
                }
              }
            } catch {
              decryptFailedRooms.set(roomId, { count: (decryptFailedRooms.get(roomId)?.count ?? 0) + 1, lastAttempt: Date.now() });
            }
            break;
          }
        } catch {
          decryptFailedRooms.set(roomId, { count: (decryptFailedRooms.get(roomId)?.count ?? 0) + 1, lastAttempt: Date.now() });
        }
      }));

      // Trigger reactivity after each batch so UI updates incrementally
      if (batchUpdated) triggerRef(rooms);
    }
  };

  // Pending read receipt: sent when tab becomes visible
  let pendingReadReceipt: { roomId: string; event: unknown } | null = null;

  const sendReadReceiptIfVisible = (roomId: string, event: unknown) => {
    if (document.visibilityState === "visible") {
      try {
        const matrixService = getMatrixClientService();
        matrixService.sendReadReceipt(event);
      } catch (e) {
        console.warn("[chat-store] sendReadReceipt error:", e);
      }
    } else {
      pendingReadReceipt = { roomId, event };
    }
  };

  // Listen for visibility changes to send pending read receipts
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && pendingReadReceipt) {
        const { event } = pendingReadReceipt;
        pendingReadReceipt = null;
        try {
          const matrixService = getMatrixClientService();
          matrixService.sendReadReceipt(event);
        } catch (e) {
          console.warn("[chat-store] deferred sendReadReceipt error:", e);
        }
      }
    });
  }

  const setActiveRoom = (roomId: string | null) => {
    activeRoomId.value = roomId;
    if (roomId) {
      const room = getRoomById(roomId);
      if (room) room.unreadCount = 0;

      // Ensure member profiles are loaded for the active room
      profilesRequestedForRooms.delete(roomId);
      loadProfilesForRoomIds([roomId]);

      // Don't auto-join invited rooms — let the user preview first
      if (room?.membership === "invite") return;

      // Send read receipt for last event in the room (only if tab is visible)
      try {
        const matrixService = getMatrixClientService();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const matrixRoom = matrixService.getRoom(roomId) as any;
        if (matrixRoom) {
          const events = matrixRoom.timeline ?? matrixRoom.getLiveTimeline?.()?.getEvents?.() ?? [];
          if (events.length > 0) {
            const lastEvent = events[events.length - 1];
            sendReadReceiptIfVisible(roomId, lastEvent);
          }
        }
      } catch (e) {
        console.warn("[chat-store] sendReadReceipt error:", e);
      }
    }
  };

  /** Accept an invite: join the room and update membership */
  const acceptInvite = async (roomId: string) => {
    try {
      const matrixService = getMatrixClientService();
      await matrixService.joinRoom(roomId);

      // Update local membership to "join"
      const room = getRoomById(roomId);
      if (room) room.membership = "join";

      // Refresh to get full room data now that we're a member
      refreshRooms();
    } catch (e) {
      console.warn("[chat-store] acceptInvite error:", e);
    }
  };

  /** Decline an invite: leave the room and remove from list */
  const declineInvite = async (roomId: string) => {
    // Mark as deleted so refreshRooms won't re-add (persisted to localStorage)
    deletedRoomIds.value = new Set([...deletedRoomIds.value, roomId]);
    saveDeletedRooms(deletedRoomIds.value);

    // Optimistic: remove from UI
    rooms.value = rooms.value.filter((r) => r.id !== roomId);
    roomsMap.delete(roomId);
    if (activeRoomId.value === roomId) activeRoomId.value = null;

    try {
      const matrixService = getMatrixClientService();
      await matrixService.leaveRoom(roomId);
    } catch (e) {
      console.warn("[chat-store] declineInvite error:", e);
    }
  };

  /** Count of rooms with pending invitations */
  const inviteCount = computed(() =>
    rooms.value.filter((r) => r.membership === "invite").length
  );

  const addRoom = (room: ChatRoom) => {
    const existing = getRoomById(room.id);
    if (existing) {
      Object.assign(existing, room);
    } else {
      rooms.value.push(room);
    }
    roomsMap.set(room.id, existing ?? room);
  };

  // Client-side deleted rooms set (matches bastyon-chat's deletedrooms map).
  // Persisted to localStorage so deletions survive page reload.
  const DELETED_ROOMS_KEY = "bastyon-chat-deleted-rooms";
  const loadDeletedRooms = (): Set<string> => {
    try {
      const stored = localStorage.getItem(DELETED_ROOMS_KEY);
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch { return new Set(); }
  };
  const saveDeletedRooms = (ids: Set<string>) => {
    try { localStorage.setItem(DELETED_ROOMS_KEY, JSON.stringify([...ids])); } catch { /* ignore */ }
  };
  const deletedRoomIds = ref<Set<string>>(loadDeletedRooms());

  /** Remove a room: kick other members → leave → forget → remove from local state.
   *  Kicks all other joined members so the chat disappears for everyone (both 1:1 and groups). */
  const removeRoom = async (roomId: string) => {
    // Mark as deleted so refreshRooms won't re-add it (persisted to localStorage)
    deletedRoomIds.value = new Set([...deletedRoomIds.value, roomId]);
    saveDeletedRooms(deletedRoomIds.value);

    // Optimistic: remove from UI immediately
    rooms.value = rooms.value.filter((r) => r.id !== roomId);
    roomsMap.delete(roomId);
    delete messages.value[roomId];
    triggerRef(messages);
    if (activeRoomId.value === roomId) {
      activeRoomId.value = null;
    }

    // Server: kick all other members → leave → forget
    try {
      const matrixService = getMatrixClientService();

      // Kick all other joined members before leaving (works for both 1:1 and groups)
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const matrixRoom = matrixService.getRoom(roomId) as any;
        if (matrixRoom) {
          const myUserId = matrixService.getUserId();
          const joinedMembers = matrixRoom.getJoinedMembers?.() ?? [];
          for (const member of joinedMembers) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const memberId = (member as any).userId as string;
            if (memberId !== myUserId) {
              try {
                await matrixService.kick(roomId, memberId);
              } catch (kickErr) {
                console.warn("[chat-store] removeRoom: kick failed for", memberId, kickErr);
              }
            }
          }
        }
      } catch (e) {
        console.warn("[chat-store] removeRoom kick members error:", e);
      }

      // Delete room alias before leaving (so the alias can be reused for new chats)
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const matrixRoom = matrixService.getRoom(roomId) as any;
        const canonicalAlias = matrixRoom?.getCanonicalAlias?.() as string | undefined;
        if (canonicalAlias) {
          await matrixService.deleteAlias(canonicalAlias);
        }
      } catch (aliasErr) {
        console.warn("[chat-store] removeRoom: deleteAlias failed:", aliasErr);
      }

      await matrixService.leaveRoom(roomId);
      await matrixService.forgetRoom(roomId);
    } catch (e) {
      console.warn("[chat-store] removeRoom leave/forget error:", e);
    }
  };

  /** Leave a group chat without kicking other members. */
  const leaveGroup = async (roomId: string) => {
    deletedRoomIds.value = new Set([...deletedRoomIds.value, roomId]);
    saveDeletedRooms(deletedRoomIds.value);

    // Optimistic: remove from UI
    rooms.value = rooms.value.filter((r) => r.id !== roomId);
    roomsMap.delete(roomId);
    delete messages.value[roomId];
    triggerRef(messages);
    if (activeRoomId.value === roomId) {
      activeRoomId.value = null;
    }

    try {
      const matrixService = getMatrixClientService();
      await matrixService.leaveRoom(roomId);
      await matrixService.forgetRoom(roomId);
    } catch (e) {
      console.warn("[chat-store] leaveGroup error:", e);
    }
  };

  /** Kick a single user from a room (requires admin power level).
   *  @param address — raw Bastyon address (will be hex-encoded for Matrix ID) */
  const kickMember = async (roomId: string, address: string): Promise<boolean> => {
    try {
      const matrixService = getMatrixClientService();
      const hexId = hexEncode(address).toLowerCase();
      const targetMatrixId = matrixService.matrixId(hexId);
      await matrixService.kick(roomId, targetMatrixId);

      // Optimistic: remove member from local room data immediately
      const room = getRoomById(roomId);
      if (room) {
        room.members = room.members.filter(m => m !== hexId);
      }

      return true;
    } catch (e) {
      console.warn("[chat-store] kickMember error:", e);
      return false;
    }
  };

  /** Set power level for a user in a room */
  const setMemberPowerLevel = async (roomId: string, address: string, level: number): Promise<boolean> => {
    try {
      const matrixService = getMatrixClientService();
      const targetMatrixId = matrixService.matrixId(hexEncode(address).toLowerCase());
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const matrixRoom = matrixService.getRoom(roomId) as any;
      if (!matrixRoom) return false;
      const powerEvent = matrixRoom.currentState?.getStateEvents?.("m.room.power_levels");
      if (!powerEvent?.length) return false;
      await matrixService.setPowerLevel(roomId, targetMatrixId, level, powerEvent[0]);
      return true;
    } catch (e) {
      console.warn("[chat-store] setMemberPowerLevel error:", e);
      return false;
    }
  };

  /** Upload and set a new room avatar (group chats) */
  const setRoomAvatar = async (roomId: string, file: File): Promise<boolean> => {
    try {
      const matrixService = getMatrixClientService();
      const mxcUrl = await matrixService.uploadContentMxc(file);
      await matrixService.sendStateEvent(roomId, "m.room.avatar", { url: mxcUrl }, "");
      const httpUrl = matrixService.mxcToHttp(mxcUrl);
      const room = getRoomById(roomId);
      if (room && httpUrl) room.avatar = httpUrl;
      return true;
    } catch (e) {
      console.warn("[chat-store] setRoomAvatar error:", e);
      return false;
    }
  };

  /** Set or clear the room topic/description */
  const setRoomTopic = async (roomId: string, topic: string): Promise<boolean> => {
    try {
      const matrixService = getMatrixClientService();
      await matrixService.setRoomTopic(roomId, topic);
      const room = getRoomById(roomId);
      if (room) room.topic = topic;
      return true;
    } catch (e) {
      console.warn("[chat-store] setRoomTopic error:", e);
      return false;
    }
  };

  /** Ban a user from a room */
  const banMember = async (roomId: string, address: string): Promise<boolean> => {
    try {
      const matrixService = getMatrixClientService();
      const hexId = hexEncode(address).toLowerCase();
      const targetMatrixId = matrixService.matrixId(hexId);
      await matrixService.ban(roomId, targetMatrixId);
      // Optimistic: remove from members
      const room = getRoomById(roomId);
      if (room) {
        room.members = room.members.filter(m => m !== hexId);
      }
      return true;
    } catch (e) {
      console.warn("[chat-store] banMember error:", e);
      return false;
    }
  };

  /** Unban a user from a room */
  const unbanMember = async (roomId: string, userId: string): Promise<boolean> => {
    try {
      const matrixService = getMatrixClientService();
      await matrixService.unban(roomId, userId);
      return true;
    } catch (e) {
      console.warn("[chat-store] unbanMember error:", e);
      return false;
    }
  };

  /** Get banned members for a room. Returns array of { userId, name } */
  const getBannedMembers = (roomId: string): Array<{ userId: string; name: string }> => {
    try {
      const matrixService = getMatrixClientService();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const matrixRoom = matrixService.getRoom(roomId) as any;
      if (!matrixRoom) return [];
      const banned = matrixRoom.getMembersWithMembership?.("ban") ?? [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return banned.map((m: any) => ({
        userId: m.userId as string,
        name: (m.rawDisplayName as string) || (m.name as string) || (() => { const a = matrixIdToAddress(m.userId as string); return /^[A-Za-z0-9]+$/.test(a) ? a : "?"; })(),
      }));
    } catch {
      return [];
    }
  };

  /** Mute/unmute a member by setting power level to -1 (muted) or 0 (normal) */
  const muteMember = async (roomId: string, address: string, mute: boolean): Promise<boolean> => {
    return setMemberPowerLevel(roomId, address, mute ? -1 : 0);
  };

  /** Check if a member is muted (power level < 0) */
  const isMemberMuted = (roomId: string, hexId: string): boolean => {
    const { levels } = getRoomPowerLevels(roomId);
    const matrixService = getMatrixClientService();
    const targetMatrixId = matrixService.matrixId(hexId);
    const level = levels[targetMatrixId] ?? 0;
    return level < 0;
  };

  /** Invite a user to a room */
  const inviteMember = async (roomId: string, address: string): Promise<boolean> => {
    try {
      const matrixService = getMatrixClientService();
      const hexId = hexEncode(address).toLowerCase();
      const targetMatrixId = matrixService.matrixId(hexId);
      await matrixService.invite(roomId, targetMatrixId);

      // Optimistic: add member to local room data immediately
      const room = getRoomById(roomId);
      if (room && !room.members.includes(hexId)) {
        room.members = [...room.members, hexId];
      }

      return true;
    } catch (e) {
      console.warn("[chat-store] inviteMember error:", e);
      return false;
    }
  };

  /** Get power levels for a room. Returns map of matrixId → power level. */
  const getRoomPowerLevels = (roomId: string): { myLevel: number; levels: Record<string, number> } => {
    try {
      const matrixService = getMatrixClientService();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const matrixRoom = matrixService.getRoom(roomId) as any;
      if (!matrixRoom) return { myLevel: 0, levels: {} };
      const powerEvent = matrixRoom.currentState?.getStateEvents?.("m.room.power_levels", "");
      const content = powerEvent?.getContent?.() ?? powerEvent?.event?.content ?? {};
      const users = (content.users ?? {}) as Record<string, number>;
      const defaultLevel = (content.users_default ?? 0) as number;
      const myUserId = matrixService.getUserId() ?? "";
      const myLevel = users[myUserId] ?? defaultLevel;
      return { myLevel, levels: users };
    } catch {
      return { myLevel: 0, levels: {} };
    }
  };

  /** Check if room has public join rules */
  const isRoomPublic = (roomId: string): boolean => {
    try {
      const matrixService = getMatrixClientService();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const matrixRoom = matrixService.getRoom(roomId) as any;
      if (!matrixRoom) return false;
      const joinEvent = matrixRoom.currentState?.getStateEvents?.("m.room.join_rules", "");
      const rule = joinEvent?.getContent?.()?.join_rule ?? joinEvent?.event?.content?.join_rule;
      return rule === "public";
    } catch {
      return false;
    }
  };

  /** Toggle room between public/private join rules (admin only) */
  const setRoomPublic = async (roomId: string, isPublic: boolean): Promise<boolean> => {
    try {
      const matrixService = getMatrixClientService();
      await matrixService.sendStateEvent(roomId, "m.room.join_rules", {
        join_rule: isPublic ? "public" : "invite",
      }, "");
      return true;
    } catch (e) {
      console.warn("[chat-store] setRoomPublic error:", e);
      return false;
    }
  };

  /** Join a room by ID (for invite link flow) */
  const joinRoomById = async (roomId: string): Promise<boolean> => {
    try {
      const matrixService = getMatrixClientService();
      await matrixService.joinRoom(roomId);
      await refreshRoomsNow();
      setActiveRoom(roomId);
      return true;
    } catch (e) {
      console.warn("[chat-store] joinRoomById error:", e);
      return false;
    }
  };

  const addMessage = (roomId: string, message: Message) => {
    if (!messages.value[roomId]) {
      messages.value[roomId] = [];
    }

    // Avoid duplicate messages
    if (messages.value[roomId].some((m) => m.id === message.id)) return;

    messages.value[roomId].push(message);
    triggerRef(messages);

    // Update room's last message and timestamp
    const room = getRoomById(roomId);
    if (room) {
      room.lastMessage = message;
      room.updatedAt = message.timestamp;
      if (roomId !== activeRoomId.value) {
        room.unreadCount++;
      }
      triggerRef(rooms);
    }

    // Update decrypted preview cache so refreshRoomsImmediate() preserves this preview
    if (message.content && message.content !== "[encrypted]") {
      decryptedPreviewCache.set(roomId, message.content);
    }
  };

  const setMessages = (roomId: string, msgs: Message[]) => {
    messages.value[roomId] = msgs;
    triggerRef(messages);
  };

  /** Replace a temporary message ID with the server-assigned event_id */
  const updateMessageId = (roomId: string, tempId: string, serverId: string) => {
    const roomMessages = messages.value[roomId];
    if (roomMessages) {
      const msg = roomMessages.find((m) => m.id === tempId);
      if (msg) {
        msg.id = serverId;
        triggerRef(messages);
      }
    }
  };

  const updateMessageStatus = (
    roomId: string,
    messageId: string,
    status: Message["status"]
  ) => {
    const roomMessages = messages.value[roomId];
    if (roomMessages) {
      const msg = roomMessages.find((m) => m.id === messageId);
      if (msg) {
        msg.status = status;
        triggerRef(messages);
      }
    }
  };

  /** Update content of a message (for edit) */
  const updateMessageContent = (roomId: string, messageId: string, newContent: string) => {
    const roomMessages = messages.value[roomId];
    if (roomMessages) {
      const msg = roomMessages.find((m) => m.id === messageId);
      if (msg) {
        msg.content = newContent;
        msg.edited = true;
        triggerRef(messages);
      }
    }
  };

  /** Remove a single message from a room */
  const removeMessage = (roomId: string, messageId: string) => {
    const roomMessages = messages.value[roomId];
    if (roomMessages) {
      const msg = roomMessages.find((m) => m.id === messageId);
      if (msg) {
        // Mark as deleted instead of removing — shows "Message deleted" like WhatsApp
        msg.deleted = true;
        msg.content = "";
        msg.fileInfo = undefined;
        msg.replyTo = undefined;
        msg.reactions = undefined;
        msg.pollInfo = undefined;
        msg.transferInfo = undefined;
        msg.forwardedFrom = undefined;
        triggerRef(messages);
      }
      // Update room's lastMessage to show "Message deleted"
      const room = getRoomById(roomId);
      if (room && msg) {
        room.lastMessage = { ...msg };
        triggerRef(rooms);
      }
    }
  };

  /** Set typing indicator for a room */
  const setTypingUsers = (roomId: string, userIds: string[]) => {
    typing.value[roomId] = userIds;
  };

  /** Get typing users for a room */
  const getTypingUsers = (roomId: string): string[] => {
    return typing.value[roomId] ?? [];
  };

  /** Ensure a PcryptoRoom instance exists for the given room */
  const ensureRoomCrypto = async (roomId: string): Promise<PcryptoRoomInstance | undefined> => {
    const pcrypto = pcryptoRef.value;
    if (!pcrypto) return undefined;

    // Already exists
    if (pcrypto.rooms[roomId]) return pcrypto.rooms[roomId];

    // Create: get the Matrix room object
    const matrixService = getMatrixClientService();
    const matrixRoom = matrixService.getRoom(roomId);
    if (!matrixRoom) return undefined;

    try {
      return await pcrypto.addRoom(matrixRoom as Record<string, unknown>);
    } catch (e) {
      console.warn("[chat-store] ensureRoomCrypto failed for", roomId, e);
      return undefined;
    }
  };

  /** Build a human-readable system message for room state events.
   *  Stores a template + raw addresses in systemMeta so names can be
   *  re-resolved at render time (avoids stale truncated addresses). */
  const buildSystemMessage = (raw: Record<string, unknown>, roomId: string): Message | null => {
    const content = raw.content as Record<string, unknown>;
    const eventType = raw.type as string;
    const sender = matrixIdToAddress(raw.sender as string);
    const senderName = getDisplayName(sender) || sender.slice(0, 8) + "...";

    let text = "";
    let template = "";
    let targetAddr: string | undefined;

    if (eventType === "m.room.member") {
      const membership = content.membership as string;
      const stateKey = raw.state_key as string | undefined;
      targetAddr = stateKey ? matrixIdToAddress(stateKey) : sender;
      const targetName = targetAddr !== sender
        ? (getDisplayName(targetAddr) || targetAddr.slice(0, 8) + "...")
        : senderName;
      const isSelf = targetAddr === sender;

      if (membership === "join") {
        text = isSelf ? `${senderName} joined the chat` : `${senderName} added ${targetName}`;
        template = isSelf ? "{sender} joined the chat" : "{sender} added {target}";
      } else if (membership === "leave") {
        text = isSelf ? `${senderName} left the chat` : `${senderName} removed ${targetName}`;
        template = isSelf ? "{sender} left the chat" : "{sender} removed {target}";
      } else if (membership === "ban") {
        text = `${senderName} banned ${targetName}`;
        template = "{sender} banned {target}";
      } else if (membership === "invite") {
        text = `${senderName} invited ${targetName}`;
        template = "{sender} invited {target}";
      } else {
        return null;
      }
    } else if (eventType === "m.room.name") {
      const newName = (content.name as string) || "";
      // Room names in our system are often internal hashes — only show the
      // human-readable name if it doesn't look like a hex hash.
      const isHash = /^#?[0-9a-f]{20,}$/i.test(newName);
      if (isHash || !newName) {
        text = `${senderName} updated the room`;
        template = "{sender} updated the room";
      } else {
        text = `${senderName} changed the room name to "${newName}"`;
        template = `{sender} changed the room name to "${newName}"`;
      }
    } else if (eventType === "m.room.power_levels") {
      text = `${senderName} changed room permissions`;
      template = "{sender} changed room permissions";
    } else if (eventType === "m.room.avatar") {
      text = `${senderName} changed the room photo`;
      template = "{sender} changed the room photo";
    } else if (eventType === "m.room.topic") {
      const newTopic = (content.topic as string) || "";
      text = newTopic
        ? `${senderName} set the room description`
        : `${senderName} cleared the room description`;
      template = newTopic
        ? "{sender} set the room description"
        : "{sender} cleared the room description";
    } else if (eventType === "m.room.pinned_events") {
      text = `${senderName} pinned a message`;
      template = "{sender} pinned a message";
    } else {
      return null;
    }

    return {
      id: raw.event_id as string,
      roomId,
      senderId: sender,
      content: cleanMatrixIds(text),
      timestamp: (raw.origin_server_ts as number) ?? 0,
      status: MessageStatus.sent,
      type: MessageType.system,
      systemMeta: { template, senderAddr: sender, targetAddr: targetAddr !== sender ? targetAddr : undefined },
    };
  };

  /** Parse a single timeline event into a Message (or null if not a message) */
  const parseSingleEvent = async (
    event: unknown,
    roomId: string,
    roomCrypto: PcryptoRoomInstance | undefined,
  ): Promise<Message | null> => {
    const raw = getRawEvent(event);
    if (!raw?.content) return null;

    // Handle state events as system messages
    const stateEventTypes = ["m.room.member", "m.room.name", "m.room.power_levels", "m.room.avatar", "m.room.topic", "m.room.pinned_events"];
    if (stateEventTypes.includes(raw.type as string)) {
      return buildSystemMessage(raw, roomId);
    }

    // Handle call hangup events as system messages in timeline history
    if (raw.type === "m.call.hangup") {
      const callContent = raw.content as Record<string, unknown>;
      const reason = callContent.reason as string | undefined;
      const isVideo = (callContent as any).offer_type === "video"
        || (callContent as any).version === 1;
      const durationMs = typeof callContent.duration === "number" ? callContent.duration : 0;
      const sender = matrixIdToAddress(raw.sender as string);
      let text: string;
      if (reason === "invite_timeout") {
        text = isVideo ? `Missed video call` : `Missed voice call`;
      } else {
        text = isVideo ? `Video call` : `Voice call`;
      }
      return {
        id: raw.event_id as string,
        roomId,
        senderId: sender,
        content: text,
        timestamp: (raw.origin_server_ts as number) ?? 0,
        status: MessageStatus.sent,
        type: MessageType.system,
        callInfo: { callType: isVideo ? "video" : "voice", missed: reason === "invite_timeout", duration: Math.round(durationMs / 1000) },
      };
    }

    // Handle poll start events (MSC3381)
    if (raw.type === "org.matrix.msc3381.poll.start") {
      const pollContent = raw.content as Record<string, unknown>;
      const pollStart = (pollContent["org.matrix.msc3381.poll.start"] ?? pollContent) as Record<string, unknown>;
      const question = ((pollStart.question as Record<string, unknown>)?.body as string) ?? (pollStart.question as string) ?? "";
      const answers = (pollStart.answers as Array<Record<string, unknown>>) ?? [];
      const options = answers.map((a) => ({
        id: (a.id as string) ?? "",
        text: (a.body as string) ?? ((a["org.matrix.msc1767.text"] as string) ?? ""),
      }));
      const pollInfo: PollInfo = {
        question,
        options,
        votes: {},
      };
      return {
        id: raw.event_id as string,
        roomId,
        senderId: matrixIdToAddress(raw.sender as string),
        content: question,
        timestamp: (raw.origin_server_ts as number) ?? 0,
        status: MessageStatus.sent,
        type: MessageType.poll,
        pollInfo,
      };
    }

    if (raw.type !== "m.room.message") return null;

    const content = raw.content as Record<string, unknown>;

    // Redacted message — return deleted placeholder
    const contentKeys = content ? Object.keys(content) : [];
    const isRedacted = contentKeys.length === 0 || (raw.unsigned as any)?.redacted_because;
    if (isRedacted) {
      return {
        id: raw.event_id as string,
        roomId,
        senderId: matrixIdToAddress(raw.sender as string),
        content: "",
        timestamp: (raw.origin_server_ts as number) ?? 0,
        status: MessageStatus.sent,
        type: MessageType.text,
        deleted: true,
      };
    }

    // Skip edit events — they're handled separately in parseTimelineEvents
    const relTo = content["m.relates_to"] as Record<string, unknown> | undefined;
    if (relTo?.rel_type === "m.replace") return null;

    // Handle donation/transfer messages (m.notice with txId — from original bastyon-chat)
    const mtype = content.msgtype as string;
    if (mtype === "m.notice" && content.txId) {
      const body = (content.body as string) ?? `Sent ${content.amount} PKOIN`;
      return {
        id: raw.event_id as string,
        roomId,
        senderId: matrixIdToAddress(raw.sender as string),
        content: body,
        timestamp: (raw.origin_server_ts as number) ?? 0,
        status: MessageStatus.sent,
        type: MessageType.transfer,
        transferInfo: {
          txId: content.txId as string,
          amount: content.amount as number,
          from: content.from as string,
          to: content.to as string,
          message: body || undefined,
        },
      };
    }

    let body = (content.body as string) ?? "";
    let msgType = MessageType.text;

    // Try to decrypt if encrypted
    if (content.msgtype === "m.encrypted") {
      if (roomCrypto) {
        try {
          const decrypted = await roomCrypto.decryptEvent(raw);
          body = decrypted.body;
        } catch (decErr) {
          console.error("[decrypt] failed for event", raw.event_id, "error:", decErr);
          body = "[encrypted]";
        }
      } else {
        body = "[no room crypto]";
      }
    }

    // Detect transfer messages encoded as JSON (encrypted with Pcrypto)
    if (body.startsWith('{"_transfer":true')) {
      try {
        const transfer = JSON.parse(body);
        const displayBody = transfer.message || `Sent ${transfer.amount} PKOIN`;
        return {
          id: raw.event_id as string,
          roomId,
          senderId: matrixIdToAddress(raw.sender as string),
          content: displayBody,
          timestamp: (raw.origin_server_ts as number) ?? 0,
          status: MessageStatus.sent,
          type: MessageType.transfer,
          transferInfo: {
            txId: transfer.txId as string,
            amount: transfer.amount as number,
            from: transfer.from as string,
            to: transfer.to as string,
            message: transfer.message || undefined,
          },
        };
      } catch { /* not valid transfer JSON, continue as text */ }
    }

    // Determine message type and parse file info
    let fileInfo: FileInfo | undefined;

    if (mtype === "m.image" || mtype === "m.file" || mtype === "m.audio" || mtype === "m.video") {
      fileInfo = parseFileInfo(content, mtype);
      if (fileInfo) {
        if (mtype === "m.image") msgType = MessageType.image;
        else if (mtype === "m.audio") msgType = MessageType.audio;
        else if (mtype === "m.video") msgType = MessageType.video;
        else msgType = messageTypeFromMime(fileInfo.type);
        body = fileInfo.name;
      } else {
        if (mtype === "m.image") msgType = MessageType.image;
        else if (mtype === "m.audio") msgType = MessageType.audio;
        else if (mtype === "m.video") msgType = MessageType.video;
        else msgType = MessageType.file;
      }
    }

    // Parse reply reference
    let replyTo: ReplyTo | undefined;
    const relatesTo = content["m.relates_to"] as Record<string, unknown> | undefined;
    const inReplyTo = relatesTo?.["m.in_reply_to"] as Record<string, unknown> | undefined;
    if (inReplyTo?.event_id) {
      replyTo = {
        id: inReplyTo.event_id as string,
        senderId: "",
        content: "",
      };
    }

    // Parse forwarded_from metadata
    let forwardedFrom: Message["forwardedFrom"] | undefined;
    const fwdMeta = content["forwarded_from"] as Record<string, unknown> | undefined;
    if (fwdMeta?.sender_id) {
      forwardedFrom = {
        senderId: fwdMeta.sender_id as string,
        senderName: (fwdMeta.sender_name as string) || undefined,
      };
    }

    return {
      id: raw.event_id as string,
      roomId,
      senderId: matrixIdToAddress(raw.sender as string),
      content: body,
      timestamp: (raw.origin_server_ts as number) ?? 0,
      status: MessageStatus.sent,
      type: msgType,
      fileInfo,
      replyTo,
      forwardedFrom,
    };
  };

  /** Parse timeline events into Message array — decrypts in parallel, collects reactions */
  const parseTimelineEvents = async (
    timelineEvents: unknown[],
    roomId: string,
  ): Promise<Message[]> => {
    // Ensure room crypto is initialized before parsing
    const roomCrypto = await ensureRoomCrypto(roomId);

    // Separate messages, reactions, edits, and poll events
    const messageEvents: unknown[] = [];
    const reactionEvents: Record<string, unknown>[] = [];
    const editEvents: Record<string, unknown>[] = [];
    const pollResponseEvents: Record<string, unknown>[] = [];
    const pollEndEvents: Record<string, unknown>[] = [];

    const stateEventTypes = ["m.room.member", "m.room.name", "m.room.power_levels", "m.room.avatar", "m.room.topic", "m.room.pinned_events"];
    for (const event of timelineEvents) {
      const raw = getRawEvent(event);
      if (!raw) continue;
      if (raw.type === "m.reaction" && raw.content) {
        reactionEvents.push(raw);
      } else if (raw.type === "org.matrix.msc3381.poll.response" && raw.content) {
        pollResponseEvents.push(raw);
      } else if (raw.type === "org.matrix.msc3381.poll.end" && raw.content) {
        pollEndEvents.push(raw);
      } else if (raw.type === "m.room.message" && raw.content) {
        // Check if this message has been redacted (content cleared by server)
        const contentKeys = Object.keys(raw.content as Record<string, unknown>);
        const isRedacted = contentKeys.length === 0 || (raw.unsigned as any)?.redacted_because;
        if (isRedacted) {
          // Still include as a deleted placeholder
          messageEvents.push(event);
        } else {
          const rel = (raw.content as Record<string, unknown>)["m.relates_to"] as Record<string, unknown> | undefined;
          if (rel?.rel_type === "m.replace" && rel?.event_id) {
            editEvents.push(raw);
          } else {
            messageEvents.push(event);
          }
        }
      } else if (raw.type === "m.room.message") {
        // Redacted message with empty/null content — include as deleted placeholder
        messageEvents.push(event);
      } else if (stateEventTypes.includes(raw.type as string) && raw.content) {
        // State events: membership changes, room name changes, power level changes
        messageEvents.push(event);
      } else {
        messageEvents.push(event);
      }
    }

    // Decrypt all messages in parallel
    const results = await Promise.all(
      messageEvents.map((event) => parseSingleEvent(event, roomId, roomCrypto).catch(() => null))
    );

    const msgs = results.filter((m): m is Message => m !== null && (m.content !== "" || m.deleted === true));

    // Apply edits to messages (decrypt if needed)
    const msgMap = new Map(msgs.map(m => [m.id, m]));
    for (const raw of editEvents) {
      const content = raw.content as Record<string, unknown>;
      const rel = content["m.relates_to"] as Record<string, unknown>;
      const targetId = rel.event_id as string;
      const target = msgMap.get(targetId);
      if (target) {
        const newContent = content["m.new_content"] as Record<string, unknown> | undefined;
        let editBody: string;

        if (newContent?.msgtype === "m.encrypted" || content.msgtype === "m.encrypted") {
          if (roomCrypto) {
            try {
              const decrypted = await roomCrypto.decryptEvent(raw);
              editBody = decrypted.body;
            } catch {
              editBody = (newContent?.body as string) ?? (content.body as string) ?? "[decrypt error]";
            }
          } else {
            editBody = "[no room crypto]";
          }
        } else {
          editBody = (newContent?.body as string) ?? (content.body as string) ?? "";
        }

        target.content = editBody.replace(/^\* /, "");
        target.edited = true;
      }
    }

    // Apply reactions to messages
    const matrixService = getMatrixClientService();
    for (const raw of reactionEvents) {
      const content = raw.content as Record<string, unknown>;
      const relatesTo = content?.["m.relates_to"] as Record<string, unknown> | undefined;
      if (!relatesTo) continue;
      const targetId = relatesTo.event_id as string;
      const emoji = relatesTo.key as string;
      if (!targetId || !emoji) continue;

      const targetMsg = msgMap.get(targetId);
      if (!targetMsg) continue;

      if (!targetMsg.reactions) targetMsg.reactions = {};
      if (!targetMsg.reactions[emoji]) {
        targetMsg.reactions[emoji] = { count: 0, users: [] };
      }
      const reactionSenderId = matrixIdToAddress(raw.sender as string);
      const rd = targetMsg.reactions[emoji];
      if (!rd.users.includes(reactionSenderId)) {
        rd.users.push(reactionSenderId);
        rd.count++;
        if (matrixService.isMe(raw.sender as string)) {
          rd.myEventId = raw.event_id as string;
        }
      }
    }

    // Apply poll responses (votes) to poll messages
    for (const raw of pollResponseEvents) {
      const content = raw.content as Record<string, unknown>;
      const relatesTo = content["m.relates_to"] as Record<string, unknown> | undefined;
      const pollEventId = relatesTo?.event_id as string;
      if (!pollEventId) continue;
      const pollMsg = msgMap.get(pollEventId);
      if (!pollMsg?.pollInfo) continue;
      const responseContent = (content["org.matrix.msc3381.poll.response"] ?? content) as Record<string, unknown>;
      const answers = (responseContent.answers as string[]) ?? [];
      const voterId = matrixIdToAddress(raw.sender as string);
      // Remove previous vote from this voter
      for (const optId of Object.keys(pollMsg.pollInfo.votes)) {
        pollMsg.pollInfo.votes[optId] = pollMsg.pollInfo.votes[optId].filter(v => v !== voterId);
      }
      // Add new vote
      if (answers.length > 0) {
        const optionId = answers[0];
        if (!pollMsg.pollInfo.votes[optionId]) pollMsg.pollInfo.votes[optionId] = [];
        pollMsg.pollInfo.votes[optionId].push(voterId);
      }
      // Track own vote
      if (matrixService.isMe(raw.sender as string) && answers.length > 0) {
        pollMsg.pollInfo.myVote = answers[0];
      }
    }

    // Apply poll end events
    for (const raw of pollEndEvents) {
      const content = raw.content as Record<string, unknown>;
      const relatesTo = content["m.relates_to"] as Record<string, unknown> | undefined;
      const pollEventId = relatesTo?.event_id as string;
      if (!pollEventId) continue;
      const pollMsg = msgMap.get(pollEventId);
      if (!pollMsg?.pollInfo) continue;
      pollMsg.pollInfo.ended = true;
      pollMsg.pollInfo.endedBy = matrixIdToAddress(raw.sender as string);
    }

    // Resolve reply references (fill in sender/content/type from parsed messages)
    for (const msg of msgs) {
      if (msg.replyTo?.id) {
        const referenced = msgMap.get(msg.replyTo.id);
        if (referenced) {
          msg.replyTo.senderId = referenced.senderId;
          msg.replyTo.content = referenced.content.slice(0, 100);
          msg.replyTo.type = referenced.type;
        }
      }
    }

    return msgs;
  };

  /** Get timeline events from a Matrix room */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getTimelineEvents = (matrixRoom: any): unknown[] => {
    try {
      // Try getLiveTimeline().getEvents() first (standard API)
      const liveTimeline = matrixRoom.getLiveTimeline?.();
      if (liveTimeline) {
        const events = liveTimeline.getEvents?.();
        if (events?.length) return events;
      }
      // Fallback to room.timeline property
      if (matrixRoom.timeline?.length) return matrixRoom.timeline;
    } catch (e) {
      console.warn("[chat-store] getTimelineEvents error:", e);
    }
    return [];
  };

  /** Apply existing read receipts from the Matrix room to set correct message statuses.
   *  Walks the timeline backwards, finds the latest event that has a read receipt
   *  from a non-self user, and marks all own messages up to that point as "read". */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const applyExistingReceipts = (matrixRoom: any, timelineEvents: unknown[], msgs: Message[], myUserId: string | null) => {
    if (!myUserId || msgs.length === 0) return;
    try {
      const myAddr = matrixIdToAddress(myUserId);
      // Find the latest event that has a read receipt from a non-self user
      let readUpToEventId: string | null = null;
      for (let i = timelineEvents.length - 1; i >= 0; i--) {
        const ev = timelineEvents[i];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const receipts: Array<{ userId: string; type: string }> = matrixRoom.getReceiptsForEvent?.(ev) ?? [];
        const hasOtherRead = receipts.some(
          (r) => r.type === "m.read" && r.userId !== myUserId
        );
        if (hasOtherRead) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          readUpToEventId = (ev as any)?.getId?.() ?? (ev as any)?.event?.event_id ?? null;
          break;
        }
      }
      if (!readUpToEventId) return;

      // Find the index of this event in our messages and mark all own messages up to it
      const readUpToIdx = msgs.findIndex(m => m.id === readUpToEventId);
      if (readUpToIdx < 0) {
        // Event not in our parsed messages — mark all as read (receipt is beyond our range)
        for (const msg of msgs) {
          if (msg.senderId === myAddr && msg.status === MessageStatus.sent) {
            msg.status = MessageStatus.read;
          }
        }
        return;
      }
      for (let i = readUpToIdx; i >= 0; i--) {
        const msg = msgs[i];
        if (msg.senderId !== myAddr) continue;
        if (msg.status === MessageStatus.sent) {
          msg.status = MessageStatus.read;
        }
      }
    } catch (e) {
      console.warn("[chat-store] applyExistingReceipts error:", e);
    }
  };

  /** Load timeline events for a room and convert to Messages */
  const loadRoomMessages = async (roomId: string) => {
    try {
      const matrixService = getMatrixClientService();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const matrixRoom = matrixService.getRoom(roomId) as any;
      if (!matrixRoom) {
        console.warn("[chat-store] loadRoomMessages: room not found:", roomId);
        return;
      }

      // Count how many actual message events sync has provided.
      // Sync typically only provides 1-2 recent events per room (for preview).
      // We need scrollback to fetch enough messages for a proper chat view.
      let timelineEvents = getTimelineEvents(matrixRoom);
      const MIN_MESSAGES = 20;
      const MAX_SCROLLBACK_ATTEMPTS = 5;

      const countMessages = (events: unknown[]) =>
        events.filter((ev) => {
          const raw = getRawEvent(ev);
          return raw?.type === "m.room.message";
        }).length;

      let msgCount = countMessages(timelineEvents);

      if (msgCount < MIN_MESSAGES) {
        // Retry once if timeline is completely empty — sync may not have populated it yet
        if (timelineEvents.length === 0) {
          await new Promise(r => setTimeout(r, 1500));
        }

        // Keep scrolling back until we have enough messages or hit the beginning
        for (let attempt = 0; attempt < MAX_SCROLLBACK_ATTEMPTS && msgCount < MIN_MESSAGES; attempt++) {
          const prevCount = timelineEvents.length;
          try {
            await matrixService.scrollback(roomId, 50);
          } catch (e) {
            console.warn("[chat-store] scrollback failed:", e);
            break;
          }
          timelineEvents = getTimelineEvents(matrixRoom);
          msgCount = countMessages(timelineEvents);

          // No new events loaded — we've reached the beginning of the room
          if (timelineEvents.length === prevCount) break;
        }
      }

      const msgs = await parseTimelineEvents(timelineEvents, roomId);

      // Apply existing read receipts to determine message status.
      // Walk timeline backwards, find the latest read receipt from a non-self user,
      // and mark all own messages up to that point as "read".
      applyExistingReceipts(matrixRoom, timelineEvents, msgs, matrixService.getUserId());

      setMessages(roomId, msgs);

      // Load server-synced pinned messages after messages are available
      if (roomId === activeRoomId.value) {
        await loadPinnedMessages(roomId);
      }

      // Fire-and-forget: cache messages to IndexedDB
      cacheMessages(roomId, msgs).catch(() => {});
    } catch (e) {
      console.error("[chat-store] loadRoomMessages fatal error for room %s:", roomId, e);
      // Set empty messages so UI doesn't hang
      setMessages(roomId, []);
    }
  };

  /** Load more (older) messages for a room. Returns false if no more available. */
  const loadMoreMessages = async (roomId: string): Promise<boolean> => {
    try {
      const matrixService = getMatrixClientService();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const matrixRoom = matrixService.getRoom(roomId) as any;
      if (!matrixRoom) return false;

      const prevCount = getTimelineEvents(matrixRoom).length;

      try {
        await matrixService.scrollback(roomId, 50);
      } catch (e) {
        console.warn("[chat-store] loadMoreMessages scrollback failed:", e);
        return false;
      }

      const newCount = getTimelineEvents(matrixRoom).length;
      if (newCount <= prevCount) return false; // no more messages

      const timelineEvents = getTimelineEvents(matrixRoom);
      const msgs = await parseTimelineEvents(timelineEvents, roomId);
      applyExistingReceipts(matrixRoom, timelineEvents, msgs, matrixService.getUserId());
      setMessages(roomId, msgs);

      // Fire-and-forget: cache messages to IndexedDB
      cacheMessages(roomId, msgs).catch(() => {});

      return true;
    } catch (e) {
      console.error("[chat-store] loadMoreMessages error:", e);
      return false;
    }
  };

  /** Load ALL messages for a room (for search). Paginates until no more history.
   *  Unlike calling loadMoreMessages in a loop, this only updates reactive state
   *  once at the end to avoid flickering caused by repeated re-renders. */
  const loadAllMessages = async (roomId: string): Promise<void> => {
    try {
      const matrixService = getMatrixClientService();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const matrixRoom = matrixService.getRoom(roomId) as any;
      if (!matrixRoom) return;

      // Paginate without touching reactive state
      let keepGoing = true;
      while (keepGoing) {
        const prevCount = getTimelineEvents(matrixRoom).length;
        try {
          await matrixService.scrollback(roomId, 25);
        } catch {
          break;
        }
        if (getTimelineEvents(matrixRoom).length <= prevCount) {
          keepGoing = false;
        }
      }

      // Parse everything once and update reactive state in a single write
      const timelineEvents = getTimelineEvents(matrixRoom);
      const msgs = await parseTimelineEvents(timelineEvents, roomId);
      applyExistingReceipts(matrixRoom, timelineEvents, msgs, matrixService.getUserId());
      setMessages(roomId, msgs);
      cacheMessages(roomId, msgs).catch(() => {});
    } catch (e) {
      console.error("[chat-store] loadAllMessages error:", e);
    }
  };

  /** Apply a reaction event to a stored message */
  const applyReaction = (roomId: string, raw: Record<string, unknown>) => {
    const content = raw.content as Record<string, unknown>;
    const relatesTo = content?.["m.relates_to"] as Record<string, unknown> | undefined;
    if (!relatesTo) return;

    const targetEventId = relatesTo.event_id as string;
    const emoji = relatesTo.key as string;
    if (!targetEventId || !emoji) return;

    const roomMessages = messages.value[roomId];
    if (!roomMessages) return;

    const targetMsg = roomMessages.find(m => m.id === targetEventId);
    if (!targetMsg) return;

    if (!targetMsg.reactions) targetMsg.reactions = {};
    if (!targetMsg.reactions[emoji]) {
      targetMsg.reactions[emoji] = { count: 0, users: [] };
    }

    const reactionSender = matrixIdToAddress(raw.sender as string);
    const reactionData = targetMsg.reactions[emoji];
    if (!reactionData.users.includes(reactionSender)) {
      reactionData.users.push(reactionSender);
      reactionData.count++;
    }

    // Update own reaction event ID — but only if the new ID is a real server ID ($...)
    // The SDK fires timeline events with local IDs (~...) before server confirmation
    const matrixService = getMatrixClientService();
    const incomingId = raw.event_id as string;
    if (matrixService.isMe(raw.sender as string) && incomingId) {
      const currentId = reactionData.myEventId;
      // Only update if: no ID yet, current is optimistic/local, or incoming is a real server ID
      if (!currentId || !currentId.startsWith("$") || incomingId.startsWith("$")) {
        reactionData.myEventId = incomingId;
      }
    }
    triggerRef(messages);
  };

  /** Set the server-confirmed event ID for an own reaction */
  const setReactionEventId = (roomId: string, messageId: string, emoji: string, eventId: string) => {
    const roomMessages = messages.value[roomId];
    if (!roomMessages) return;
    const msg = roomMessages.find(m => m.id === messageId);
    if (msg?.reactions?.[emoji]) {
      msg.reactions[emoji].myEventId = eventId;
      triggerRef(messages);
    }
  };

  /** Optimistic add: instantly show a reaction before server confirms */
  const optimisticAddReaction = (roomId: string, messageId: string, emoji: string, userAddress: string) => {
    const roomMessages = messages.value[roomId];
    if (!roomMessages) return;
    const msg = roomMessages.find(m => m.id === messageId);
    if (!msg) return;
    if (!msg.reactions) msg.reactions = {};
    if (!msg.reactions[emoji]) {
      msg.reactions[emoji] = { count: 0, users: [] };
    }
    const rd = msg.reactions[emoji];
    if (!rd.users.includes(userAddress)) {
      rd.users.push(userAddress);
      rd.count++;
    }
    // myEventId will be set by applyReaction when the server echoes back
    rd.myEventId = "__optimistic__";
    triggerRef(messages);
  };

  /** Optimistic remove: instantly hide a reaction before server confirms */
  const optimisticRemoveReaction = (roomId: string, messageId: string, emoji: string, userAddress: string) => {
    const roomMessages = messages.value[roomId];
    if (!roomMessages) return;
    const msg = roomMessages.find(m => m.id === messageId);
    if (!msg?.reactions?.[emoji]) return;
    const rd = msg.reactions[emoji];
    rd.users = rd.users.filter(u => u !== userAddress);
    rd.count = rd.users.length;
    delete rd.myEventId;
    if (rd.count === 0) {
      delete msg.reactions[emoji];
    }
    triggerRef(messages);
  };

  /** Handle incoming timeline event from Matrix sync */
  const handleTimelineEvent = async (event: unknown, roomId: string) => {
    try {
      const raw = getRawEvent(event);
      if (!raw?.content) return;

      // Handle reaction events
      if (raw.type === "m.reaction") {
        applyReaction(roomId, raw);
        return;
      }

      // Handle state events (membership, room name, power levels, avatar, topic, pinned) as system messages
      const liveStateEventTypes = ["m.room.member", "m.room.name", "m.room.power_levels", "m.room.avatar", "m.room.topic", "m.room.pinned_events"];
      if (liveStateEventTypes.includes(raw.type as string)) {
        // Update local room topic when topic state changes
        if (raw.type === "m.room.topic") {
          const room = getRoomById(roomId);
          if (room) {
            room.topic = ((raw.content as Record<string, unknown>).topic as string) || "";
          }
        }
        // Reload pinned messages when pinned events change
        if (raw.type === "m.room.pinned_events" && roomId === activeRoomId.value) {
          loadPinnedMessages(roomId);
        }
        const sysMsg = buildSystemMessage(raw, roomId);
        if (sysMsg) {
          addMessage(roomId, sysMsg);
        }
        return;
      }

      // Handle call hangup events as system messages in the timeline
      if (raw.type === "m.call.hangup") {
        const callContent = raw.content as Record<string, unknown>;
        const reason = callContent.reason as string | undefined;
        const isVideo = (callContent as any).offer_type === "video"
          || (callContent as any).version === 1;
        const durationMs = typeof callContent.duration === "number" ? callContent.duration : 0;
        // Determine if call was answered (has duration) or missed
        const sender = matrixIdToAddress(raw.sender as string);
        const senderName = getDisplayName(sender) || sender.slice(0, 8) + "...";
        let text: string;
        if (reason === "invite_timeout") {
          text = isVideo ? `Missed video call` : `Missed voice call`;
        } else {
          text = isVideo ? `Video call` : `Voice call`;
        }
        const sysMsg: Message = {
          id: raw.event_id as string,
          roomId,
          senderId: sender,
          content: text,
          timestamp: (raw.origin_server_ts as number) ?? 0,
          status: MessageStatus.sent,
          type: MessageType.system,
          callInfo: { callType: isVideo ? "video" : "voice", missed: reason === "invite_timeout", duration: Math.round(durationMs / 1000) },
        };
        addMessage(roomId, sysMsg);
        return;
      }

      // Handle poll start events (MSC3381)
      if (raw.type === "org.matrix.msc3381.poll.start") {
        const matrixService2 = getMatrixClientService();
        const myUserId2 = matrixService2.getUserId();
        if (myUserId2 && raw.sender === myUserId2) {
          const roomMsgs2 = messages.value[roomId];
          const hasPending2 = roomMsgs2?.some(
            (m) => m.senderId === matrixIdToAddress(myUserId2) && m.status === MessageStatus.sending
          );
          if (hasPending2) return; // skip own echo on sending device
        }
        const pollContent = raw.content as Record<string, unknown>;
        const pollStart = (pollContent["org.matrix.msc3381.poll.start"] ?? pollContent) as Record<string, unknown>;
        const question = ((pollStart.question as Record<string, unknown>)?.body as string) ?? (pollStart.question as string) ?? "";
        const answers = (pollStart.answers as Array<Record<string, unknown>>) ?? [];
        const options = answers.map((a) => ({
          id: (a.id as string) ?? "",
          text: (a.body as string) ?? ((a["org.matrix.msc1767.text"] as string) ?? ""),
        }));
        const pollInfo: PollInfo = { question, options, votes: {} };
        addMessage(roomId, {
          id: raw.event_id as string,
          roomId,
          senderId: matrixIdToAddress(raw.sender as string),
          content: question,
          timestamp: (raw.origin_server_ts as number) ?? Date.now(),
          status: MessageStatus.sent,
          type: MessageType.poll,
          pollInfo,
        });
        return;
      }

      // Handle poll response events — update vote on existing poll message
      if (raw.type === "org.matrix.msc3381.poll.response") {
        const content = raw.content as Record<string, unknown>;
        const relatesTo = content["m.relates_to"] as Record<string, unknown> | undefined;
        const pollEventId = relatesTo?.event_id as string;
        if (!pollEventId) return;
        const roomMsgs = messages.value[roomId];
        const pollMsg = roomMsgs?.find(m => m.id === pollEventId);
        if (!pollMsg?.pollInfo) return;
        const responseContent = (content["org.matrix.msc3381.poll.response"] ?? content) as Record<string, unknown>;
        const answers = (responseContent.answers as string[]) ?? [];
        const voterId = matrixIdToAddress(raw.sender as string);
        // Remove previous vote
        for (const optId of Object.keys(pollMsg.pollInfo.votes)) {
          pollMsg.pollInfo.votes[optId] = pollMsg.pollInfo.votes[optId].filter(v => v !== voterId);
        }
        // Add new vote
        if (answers.length > 0) {
          const optionId = answers[0];
          if (!pollMsg.pollInfo.votes[optionId]) pollMsg.pollInfo.votes[optionId] = [];
          pollMsg.pollInfo.votes[optionId].push(voterId);
        }
        const matrixService = getMatrixClientService();
        if (matrixService.isMe(raw.sender as string) && answers.length > 0) {
          pollMsg.pollInfo.myVote = answers[0];
        }
        triggerRef(messages);
        return;
      }

      // Handle poll end events
      if (raw.type === "org.matrix.msc3381.poll.end") {
        const content = raw.content as Record<string, unknown>;
        const relatesTo = content["m.relates_to"] as Record<string, unknown> | undefined;
        const pollEventId = relatesTo?.event_id as string;
        if (!pollEventId) return;
        const roomMsgs = messages.value[roomId];
        const pollMsg = roomMsgs?.find(m => m.id === pollEventId);
        if (!pollMsg?.pollInfo) return;
        pollMsg.pollInfo.ended = true;
        pollMsg.pollInfo.endedBy = matrixIdToAddress(raw.sender as string);
        triggerRef(messages);
        return;
      }

      if (raw.type !== "m.room.message") return;

      const content = raw.content as Record<string, unknown>;

      // Handle edit events (m.replace) — update existing message, don't add new
      const editRelatesTo = content["m.relates_to"] as Record<string, unknown> | undefined;
      if (editRelatesTo?.rel_type === "m.replace" && editRelatesTo?.event_id) {
        const targetId = editRelatesTo.event_id as string;
        let newBody: string;

        // Edit events in encrypted rooms: m.new_content holds the ciphertext
        const newContent = content["m.new_content"] as Record<string, unknown> | undefined;
        if (newContent?.msgtype === "m.encrypted" || content.msgtype === "m.encrypted") {
          const roomCrypto = await ensureRoomCrypto(roomId);
          if (roomCrypto) {
            try {
              const decrypted = await roomCrypto.decryptEvent(raw);
              newBody = decrypted.body;
            } catch {
              newBody = (newContent?.body as string) ?? (content.body as string) ?? "[decrypt error]";
            }
          } else {
            newBody = "[no room crypto]";
          }
        } else {
          newBody = (newContent?.body as string) ?? (content.body as string) ?? "";
        }

        updateMessageContent(roomId, targetId, newBody.replace(/^\* /, ""));
        return;
      }

      // Cross-device sync: only skip own echo on the SENDING device.
      // If there's a pending optimistic message (status=sending) in this room,
      // this is the sending device's echo — skip it (updateMessageId handles it).
      // Otherwise, this is from another device — process it normally.
      const matrixService = getMatrixClientService();
      const myUserId = matrixService.getUserId();
      if (myUserId && raw.sender === myUserId) {
        const roomMsgs = messages.value[roomId];
        const hasPending = roomMsgs?.some(
          (m) => m.senderId === matrixIdToAddress(myUserId) && m.status === MessageStatus.sending
        );
        if (hasPending) return;
        // No pending optimistic → message is from another device, continue processing
      }

      // Handle donation/transfer messages (m.notice with txId)
      const mtype0 = content.msgtype as string;
      if (mtype0 === "m.notice" && content.txId) {
        const txBody = (content.body as string) ?? `Sent ${content.amount} PKOIN`;
        addMessage(roomId, {
          id: raw.event_id as string,
          roomId,
          senderId: matrixIdToAddress(raw.sender as string),
          content: txBody,
          timestamp: (raw.origin_server_ts as number) ?? Date.now(),
          status: MessageStatus.sent,
          type: MessageType.transfer,
          transferInfo: {
            txId: content.txId as string,
            amount: content.amount as number,
            from: content.from as string,
            to: content.to as string,
            message: txBody || undefined,
          },
        });
        if (roomId === activeRoomId.value) {
          sendReadReceiptIfVisible(roomId, event);
        }
        return;
      }

      let body = (content.body as string) ?? "";
      let msgType = MessageType.text;

      // Decrypt if encrypted
      if (content.msgtype === "m.encrypted") {
        const roomCrypto = await ensureRoomCrypto(roomId);
        if (roomCrypto) {
          try {
            const decrypted = await roomCrypto.decryptEvent(raw);
            body = decrypted.body;
          } catch (e) {
            console.warn("[chat-store] handleTimelineEvent decrypt failed:", e);
            body = "[decrypt error: " + String(e) + "]";
          }
        } else {
          body = "[no room crypto]";
        }
      }

      // Detect transfer messages encoded as JSON (encrypted with Pcrypto)
      if (body.startsWith('{"_transfer":true')) {
        try {
          const transfer = JSON.parse(body);
          const displayBody = transfer.message || `Sent ${transfer.amount} PKOIN`;
          addMessage(roomId, {
            id: raw.event_id as string,
            roomId,
            senderId: matrixIdToAddress(raw.sender as string),
            content: displayBody,
            timestamp: (raw.origin_server_ts as number) ?? Date.now(),
            status: MessageStatus.sent,
            type: MessageType.transfer,
            transferInfo: {
              txId: transfer.txId as string,
              amount: transfer.amount as number,
              from: transfer.from as string,
              to: transfer.to as string,
              message: transfer.message || undefined,
            },
          });
          if (roomId === activeRoomId.value) {
            sendReadReceiptIfVisible(roomId, event);
          }
          return;
        } catch { /* not valid transfer JSON, continue as text */ }
      }

      const mtype = content.msgtype as string;
      let fileInfo: FileInfo | undefined;

      if (mtype === "m.image" || mtype === "m.file" || mtype === "m.audio" || mtype === "m.video") {
        fileInfo = parseFileInfo(content, mtype);
        if (fileInfo) {
          if (mtype === "m.image") msgType = MessageType.image;
          else if (mtype === "m.audio") msgType = MessageType.audio;
          else if (mtype === "m.video") msgType = MessageType.video;
          else msgType = messageTypeFromMime(fileInfo.type);
          body = fileInfo.name;
        } else {
          if (mtype === "m.image") msgType = MessageType.image;
          else if (mtype === "m.audio") msgType = MessageType.audio;
          else if (mtype === "m.video") msgType = MessageType.video;
          else msgType = MessageType.file;
        }
      }

      // Parse reply reference
      let replyTo: ReplyTo | undefined;
      const relatesTo = content["m.relates_to"] as Record<string, unknown> | undefined;
      const inReplyTo = relatesTo?.["m.in_reply_to"] as Record<string, unknown> | undefined;
      if (inReplyTo?.event_id) {
        const replyId = inReplyTo.event_id as string;
        // Try to find the referenced message in already loaded messages
        const referenced = messages.value[roomId]?.find(m => m.id === replyId);
        replyTo = {
          id: replyId,
          senderId: referenced?.senderId ?? "",
          content: referenced?.content.slice(0, 100) ?? "",
          type: referenced?.type,
        };
      }

      // Parse forwarded_from metadata
      let forwardedFrom: Message["forwardedFrom"] | undefined;
      const fwdMeta = content["forwarded_from"] as Record<string, unknown> | undefined;
      if (fwdMeta?.sender_id) {
        forwardedFrom = {
          senderId: fwdMeta.sender_id as string,
          senderName: (fwdMeta.sender_name as string) || undefined,
        };
      }

      const message: Message = {
        id: raw.event_id as string,
        roomId,
        senderId: matrixIdToAddress(raw.sender as string),
        content: body,
        timestamp: (raw.origin_server_ts as number) ?? Date.now(),
        status: MessageStatus.sent,
        type: msgType,
        fileInfo,
        replyTo,
        forwardedFrom,
      };

      addMessage(roomId, message);

      // Auto-send read receipt if this room is currently active (visibility-aware)
      if (roomId === activeRoomId.value) {
        sendReadReceiptIfVisible(roomId, event);
      }
    } catch (e) {
      console.error("[chat-store] handleTimelineEvent error:", e);
    }
  };

  /** Handle read receipt events from other users */
  const handleReceiptEvent = (event: unknown, room: unknown) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const receiptEvent = event as any;
      const roomObj = room as Record<string, unknown>;
      const roomId = roomObj?.roomId as string;
      if (!roomId) return;
      if (!roomId) return;

      const roomMessages = messages.value[roomId];
      if (!roomMessages) return;
      if (!roomMessages) return;

      const matrixService = getMatrixClientService();
      const myUserId = matrixService.getUserId();

      // Get receipt content: { eventId: { "m.read": { userId: { ts } } } }
      const content = receiptEvent?.getContent?.() ?? receiptEvent?.event?.content;
      if (!content) return;
      if (!content) return;

      for (const [eventId, receiptTypes] of Object.entries(content)) {
        const readReceipts = (receiptTypes as Record<string, unknown>)?.["m.read"] as Record<string, unknown> | undefined;
        if (!readReceipts) continue;

        for (const userId of Object.keys(readReceipts)) {
          if (userId === myUserId) continue; // skip our own receipts
          if (userId === myUserId) continue;

          const msgIdx = roomMessages.findIndex(m => m.id === eventId);
          if (msgIdx >= 0) {
            const myAddr = matrixIdToAddress(myUserId ?? "");
            // Mark this message and all earlier own messages as read
            for (let i = msgIdx; i >= 0; i--) {
              const msg = roomMessages[i];
              if (msg.senderId !== myAddr) continue;
              if (msg.status === MessageStatus.read) break;
              if (msg.status === MessageStatus.sent || msg.status === MessageStatus.delivered) {
                msg.status = MessageStatus.read;
              }
            }
          }
        }
      }
      triggerRef(messages);
    } catch (e) {
      console.warn("[chat-store] handleReceiptEvent error:", e);
    }
  };

  /** Handle redaction events (reaction removal, message deletion) */
  const handleRedactionEvent = (event: unknown, room: unknown) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ev = event as any;
      const redactedEventId: string = ev?.event?.redacts ?? ev?.getAssociatedId?.();
      if (!redactedEventId) return;

      const roomObj = room as Record<string, unknown>;
      const roomId = (roomObj?.roomId as string) ?? "";
      if (!roomId) return;

      const roomMessages = messages.value[roomId];
      if (!roomMessages) return;

      // Check if the redacted event was a reaction — find and remove it
      for (const msg of roomMessages) {
        if (!msg.reactions) continue;
        for (const [emoji, data] of Object.entries(msg.reactions)) {
          if (data.myEventId === redactedEventId) {
            // It's our own reaction being redacted
            const matrixService = getMatrixClientService();
            const myAddr = matrixIdToAddress(matrixService.getUserId() ?? "");
            data.users = data.users.filter(u => u !== myAddr);
            data.count = data.users.length;
            delete data.myEventId;
            if (data.count === 0) delete msg.reactions[emoji];
            triggerRef(messages);
            return;
          }
        }
      }

      // Check if the redacted event is a message — mark as deleted
      const redactedMsg = roomMessages.find(m => m.id === redactedEventId);
      if (redactedMsg && !redactedMsg.deleted) {
        redactedMsg.deleted = true;
        redactedMsg.content = "";
        redactedMsg.fileInfo = undefined;
        redactedMsg.replyTo = undefined;
        redactedMsg.reactions = undefined;
        redactedMsg.pollInfo = undefined;
        redactedMsg.transferInfo = undefined;
        redactedMsg.forwardedFrom = undefined;
        // Update room lastMessage preview
        const chatRoom = getRoomById(roomId);
        if (chatRoom && chatRoom.lastMessage?.id === redactedEventId) {
          chatRoom.lastMessage = { ...redactedMsg };
          triggerRef(rooms);
        }
        triggerRef(messages);
        return;
      }

      // If we didn't find it as a known reaction eventId or message, re-parse reactions
      // from the Matrix room timeline to get accurate state
      const matrixService = getMatrixClientService();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const matrixRoom = matrixService.getRoom(roomId) as any;
      if (matrixRoom) {
        rebuildReactionsForRoom(roomId, matrixRoom);
      }
    } catch (e) {
      console.warn("[chat-store] handleRedactionEvent error:", e);
    }
  };

  /** Rebuild reactions for all messages in a room from the Matrix timeline */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rebuildReactionsForRoom = (roomId: string, matrixRoom: any) => {
    const roomMessages = messages.value[roomId];
    if (!roomMessages) return;

    const timelineEvents = getTimelineEvents(matrixRoom);
    const matrixService = getMatrixClientService();

    // Collect all non-redacted reaction events
    const reactionMap = new Map<string, Record<string, { count: number; users: string[]; myEventId?: string }>>();

    for (const ev of timelineEvents) {
      const raw = getRawEvent(ev);
      if (!raw || raw.type !== "m.reaction") continue;
      // Skip redacted events (no content or unsigned.redacted_because)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const unsigned = (raw as any).unsigned;
      if (unsigned?.redacted_because) continue;
      const content = raw.content as Record<string, unknown>;
      if (!content) continue;

      const relatesTo = content["m.relates_to"] as Record<string, unknown> | undefined;
      if (!relatesTo) continue;
      const targetId = relatesTo.event_id as string;
      const emoji = relatesTo.key as string;
      if (!targetId || !emoji) continue;

      if (!reactionMap.has(targetId)) reactionMap.set(targetId, {});
      const targetReactions = reactionMap.get(targetId)!;
      if (!targetReactions[emoji]) targetReactions[emoji] = { count: 0, users: [] };

      const sender = matrixIdToAddress(raw.sender as string);
      const rd = targetReactions[emoji];
      if (!rd.users.includes(sender)) {
        rd.users.push(sender);
        rd.count++;
      }
      if (matrixService.isMe(raw.sender as string)) {
        rd.myEventId = raw.event_id as string;
      }
    }

    // Apply to stored messages
    for (const msg of roomMessages) {
      msg.reactions = reactionMap.get(msg.id) ?? undefined;
    }
    triggerRef(messages);
  };

  /** Handle being kicked/banned from a room — remove it from UI immediately */
  const handleKicked = (roomId: string) => {
    rooms.value = rooms.value.filter((r) => r.id !== roomId);
    roomsMap.delete(roomId);
    delete messages.value[roomId];
    triggerRef(messages);
    if (activeRoomId.value === roomId) {
      activeRoomId.value = null;
    }
  };

  /** Remove a room from the deletedRoomIds set (used when rejoining a previously-deleted room) */
  const clearDeletedRoom = (roomId: string) => {
    if (deletedRoomIds.value.has(roomId)) {
      const next = new Set(deletedRoomIds.value);
      next.delete(roomId);
      deletedRoomIds.value = next;
    }
  };

  /** Load rooms from IndexedDB cache for instant display before Matrix sync */
  const loadCachedRooms = async () => {
    if (rooms.value.length > 0) return; // already have rooms from Matrix
    try {
      const cached = await getCachedRooms();
      if (cached.length > 0 && rooms.value.length === 0) {
        const cachedRooms = cached as ChatRoom[];
        // Backfill callInfo for lastMessage in cached rooms
        const lastMsgs = cachedRooms.map(r => r.lastMessage).filter((m): m is Message => !!m);
        backfillCallInfo(lastMsgs);
        // Sanitize cached system messages that may contain raw Matrix IDs
        for (const m of lastMsgs) {
          if (m.content.includes("@") && /@[a-f0-9]{20,}:/i.test(m.content)) {
            m.content = cleanMatrixIds(m.content);
          }
        }
        // Room names are NOT patched here — resolved at render time.
        rooms.value = cachedRooms;
        rebuildRoomsMap();
        // User profiles loaded synchronously from localStorage — check if enough for name resolution
        const uStore = useUserStore();
        const cachedUserCount = Object.keys(uStore.users).length;
        if (cachedUserCount > 5) {
          namesReady.value = true;
        }
        // Eagerly load profiles for first viewport of cached rooms
        const viewportIds = sortedRooms.value.slice(0, 15).map(r => r.id);
        if (viewportIds.length > 0) loadProfilesForRoomIds(viewportIds);
      }
    } catch (e) {
      console.warn("[chat-store] loadCachedRooms failed:", e);
    }
  };

  /** Load cached messages for a room from IndexedDB (used as instant preview) */
  /** Backfill callInfo for cached system messages that look like call events */
  const backfillCallInfo = (msgs: Message[]) => {
    const callPatterns = [
      /^(Missed (?:voice |video )?call|Missed call from )/i,
      /^(Voice call|Video call|Call with )/i,
    ];
    for (const msg of msgs) {
      if (msg.type !== MessageType.system || msg.callInfo) continue;
      const text = msg.content;
      const isMissed = callPatterns[0].test(text);
      const isCall = isMissed || callPatterns[1].test(text);
      if (!isCall) continue;
      const isVideo = /video/i.test(text);
      msg.callInfo = { callType: isVideo ? "video" : "voice", missed: isMissed };
    }
  };

  const loadCachedMessages = async (roomId: string) => {
    if (messages.value[roomId]?.length) return; // already have messages
    try {
      const cached = await getCachedMessages(roomId);
      if (cached.length > 0 && !messages.value[roomId]?.length) {
        const msgs = cached as Message[];
        backfillCallInfo(msgs);
        // Sanitize cached messages that may contain raw Matrix IDs
        for (const m of msgs) {
          if (m.content.includes("@") && /@[a-f0-9]{20,}:/i.test(m.content)) {
            m.content = cleanMatrixIds(m.content);
          }
        }
        messages.value[roomId] = msgs;
        triggerRef(messages);
      }
    } catch (e) {
      console.warn("[chat-store] loadCachedMessages failed:", e);
    }
  };

  return {
    activeMediaMessages,
    activeMessages,
    activeRoom,
    activeRoomId,
    addMessage,
    addRoom,
    clearDeletedRoom,
    deletingMessage,
    editingMessage,
    enterSelectionMode,
    exitSelectionMode,
    forwardingMessages,
    getDisplayName,
    getRoomPowerLevels,
    getTypingUsers,
    handleKicked,
    handleReceiptEvent,
    handleRedactionEvent,
    handleTimelineEvent,
    inviteMember,
    isRoomPublic,
    joinRoomById,
    banMember,
    getBannedMembers,
    isMemberMuted,
    kickMember,
    leaveGroup,
    loadCachedMessages,
    loadCachedRooms,
    loadProfilesForRoomIds,
    loadAllMessages,
    loadPinnedMessages,
    loadMoreMessages,
    loadRoomMessages,
    markRoomAsRead,
    markRoomChanged,
    messages,
    mutedRoomIds,
    optimisticAddReaction,
    optimisticRemoveReaction,
    setReactionEventId,
    pinMessage,
    pinnedMessageIndex,
    pinnedMessages,
    pinnedRoomIds,
    preloadVisibleRooms,
    cyclePinnedMessage,
    refreshRooms,
    refreshRoomsNow,
    removeMessage,
    removeRoom,
    roomsInitialized,
    namesReady,
    replyingTo,
    rooms,
    selectedMessageIds,
    selectionMode,
    acceptInvite,
    declineInvite,
    inviteCount,
    setActiveRoom,
    setHelpers,
    muteMember,
    setMemberPowerLevel,
    setMessages,
    setRoomAvatar,
    setRoomPublic,
    setRoomTopic,
    setTypingUsers,
    sortedRooms,
    unbanMember,
    toggleMuteRoom,
    togglePinRoom,
    toggleSelection,
    totalUnread,
    typing,
    unpinMessage,
    updateMessageContent,
    updateMessageId,
    updateMessageStatus,
  };
});
