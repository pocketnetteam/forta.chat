import { getMatrixClientService } from "@/entities/matrix";
import type { MatrixKit } from "@/entities/matrix";
import type { Pcrypto, PcryptoRoomInstance } from "@/entities/matrix/model/matrix-crypto";
import { getmatrixid, hexEncode, hexDecode } from "@/shared/lib/matrix/functions";
import { matrixIdToAddress, messageTypeFromMime, parseFileInfo, cleanMatrixIds, looksLikeProperName } from "../lib/chat-helpers";
import { resetPowerLevel, isUserBanned } from "../lib/room-guards";
import { stripMentionAddresses, stripBastyonLinks } from "@/shared/lib/message-format";
import { getCachedRooms, getCachedMessages, getCacheTimestamp } from "@/shared/lib/cache/chat-cache";
import { useAuthStore } from "@/entities/auth/model/stores";
import { useUserStore } from "@/entities/user/model";
import { defineStore } from "pinia";
import { computed, reactive, ref, shallowRef, triggerRef, watch } from "vue";
import { perfMark, perfMeasure, perfCount } from "@/shared/lib/perf-markers";
import { yieldToMain, yieldEveryN } from "@/shared/lib/yield-to-main";
import { isNative } from "@/shared/lib/platform";


import type { ChatDbKit, ParsedMessage, LocalRoom } from "@/shared/lib/local-db";
import type { RoomChange } from "@/shared/lib/local-db";
import { ChatDatabase, useLiveQuery, localToMessages, localStatusToMessageStatus, deriveOutboundStatus } from "@/shared/lib/local-db";
import type { ChatRoom, FileInfo, LinkPreview, Message, PeerKeysStatus, PollInfo, ReplyTo, TransferInfo } from "./types";
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

/** Shallow-compare reaction maps by emoji keys and counts (avoids deep equality on user arrays).
 *  Returns true when both sides carry the same reaction set. */
function reactionsShallowEqual(
  a: Record<string, { count: number; users: string[]; myEventId?: string }> | undefined,
  b: Record<string, { count: number; users: string[]; myEventId?: string }> | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return a === b;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    const ra = a[k], rb = b[k];
    if (!rb || ra.count !== rb.count || ra.myEventId !== rb.myEventId) return false;
  }
  return true;
}

/** Shallow-compare poll info by vote counts and user vote. */
function pollInfoShallowEqual(a: PollInfo | undefined, b: PollInfo | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.myVote !== b.myVote || a.ended !== b.ended) return false;
  const aKeys = Object.keys(a.votes);
  const bKeys = Object.keys(b.votes);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if ((a.votes[k]?.length ?? 0) !== (b.votes[k]?.length ?? 0)) return false;
  }
  return true;
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
    // Find last actual message (including redacted/deleted)
    if (!lastMessage && raw.type === "m.room.message") {
      // Redacted message — content stripped by server
      const isRedacted = !raw.content
        || (typeof raw.content === "object" && Object.keys(raw.content as object).length === 0)
        || (raw.unsigned as any)?.redacted_because;
      if (isRedacted) {
        lastMessage = {
          id: raw.event_id as string,
          roomId,
          senderId: matrixIdToAddress((raw.sender as string) ?? ""),
          content: "",
          timestamp: (raw.origin_server_ts as number) ?? 0,
          status: MessageStatus.sent,
          type: MessageType.text,
          deleted: true,
        };
        continue;
      }
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
        const info = content.info as Record<string, unknown> | undefined;
        if (info?.videoNote) {
          previewBody = "[video message]";
          previewType = MessageType.videoCircle;
        } else {
          previewBody = "[video]";
          previewType = MessageType.video;
        }
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
        const isSelf = targetAddr === sender;
        let templateKey = "";
        if (membership === "join") { templateKey = isSelf ? "system.joined" : "system.added"; }
        else if (membership === "leave") { templateKey = isSelf ? "system.left" : "system.removed"; }
        else if (membership === "invite") { templateKey = "system.invited"; }
        if (templateKey) {
          lastSystemMessage = {
            id: raw.event_id as string, roomId, senderId: sender,
            content: senderName, timestamp: (raw.origin_server_ts as number) ?? 0,
            status: MessageStatus.sent, type: MessageType.system,
            systemMeta: { template: templateKey, senderAddr: sender, targetAddr: targetAddr !== sender ? targetAddr : undefined },
          };
        }
      } else if (raw.type === "m.call.hangup") {
        const callContent = raw.content as Record<string, unknown>;
        const reason = callContent.reason as string | undefined;
        const isVideo = (callContent as any).offer_type === "video"
          || (callContent as any).version === 1;
        const durationMs = typeof callContent.duration === "number" ? callContent.duration : 0;
        const sender = matrixIdToAddress(raw.sender as string);
        const callTemplateKey = reason === "invite_timeout"
          ? (isVideo ? "system.missedVideoCall" : "system.missedVoiceCall")
          : (isVideo ? "system.videoCall" : "system.voiceCall");
        lastSystemMessage = {
          id: raw.event_id as string, roomId, senderId: sender,
          content: "", timestamp: (raw.origin_server_ts as number) ?? 0,
          status: MessageStatus.sent, type: MessageType.system,
          callInfo: { callType: isVideo ? "video" : "voice", missed: reason === "invite_timeout", duration: Math.round(durationMs / 1000) },
          systemMeta: { template: callTemplateKey, senderAddr: sender },
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
    updatedAt: lastTs || (() => {
      // For invites, try to extract origin_server_ts from the invite event itself
      // instead of using Date.now() which inflates sort position
      if (membership === "invite") {
        try {
          // Primary: getMember().event (not always populated by SDK for invites)
          const memberObj = room.currentState?.getMember?.(myUserId);
          const inviteTs = memberObj?.event?.origin_server_ts;
          if (inviteTs && typeof inviteTs === "number") return inviteTs;
        } catch { /* ignore */ }
        try {
          // Fallback: getStateEvents('m.room.member', myUserId) — always has origin_server_ts
          const stateEvent = room.currentState?.getStateEvents?.("m.room.member", myUserId);
          const stateTs = stateEvent?.event?.origin_server_ts;
          if (stateTs && typeof stateTs === "number") return stateTs;
        } catch { /* ignore */ }
        try {
          // Last fallback: room creation event
          const createEvent = room.currentState?.getStateEvents?.("m.room.create", "");
          const createTs = createEvent?.event?.origin_server_ts;
          if (createTs && typeof createTs === "number") return createTs;
        } catch { /* ignore */ }
        return 1; // last resort: use minimal timestamp (never Date.now() — inflates sort)
      }
      return 0;
    })(),
    membership: membership === "invite" ? "invite" : "join",
    topic,
  };
}

export const useChatStore = defineStore(NAMESPACE, () => {
  const rooms = shallowRef<ChatRoom[]>([]);
  const roomsMap = new Map<string, ChatRoom>(); // O(1) lookup index
  const activeRoomId = ref<string | null>(null);
  // Message window size for pagination (increases on scroll-up, resets on room switch)
  const messageWindowSize = ref(50);
  // Debounced version for liveQuery deps — prevents re-subscription storms during scroll.
  // Resets synchronously when value decreases (room switch resets to 50).
  let _msgWindowDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  const debouncedMessageWindowSize = ref(50);
  watch(messageWindowSize, (val, oldVal) => {
    if (_msgWindowDebounceTimer) clearTimeout(_msgWindowDebounceTimer);
    if (val <= (oldVal ?? 50)) {
      // Immediate update on reset (room switch) — no debounce needed
      debouncedMessageWindowSize.value = val;
      return;
    }
    _msgWindowDebounceTimer = setTimeout(() => {
      debouncedMessageWindowSize.value = val;
      _msgWindowDebounceTimer = null;
    }, 200);
  });
  const messages = shallowRef<Record<string, Message[]>>({});
  const typing = ref<Record<string, string[]>>({});
  const replyingTo = ref<ReplyTo | null>(null);
  const isDetachedFromLatest = ref(false);

  // Shared counter: yields to main thread every 5 decryption calls across ALL
  // decrypt paths (edits, timeline events, etc.) to keep UI responsive.
  const maybeYieldDecrypt = yieldEveryN(5);

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
  const FULL_REFRESH_INTERVAL = 900_000; // 15 min — incremental + delta handles normal updates
  let membersLoadedOnce = false; // One-time member loading for stale lazy-load cache
  let fullRefreshInFlight = false; // Re-entrancy guard for async fullRoomRefresh

  /** Schedule a callback during browser idle time, with setTimeout fallback */
  const scheduleIdle = (cb: () => void, fallbackMs = 200) => {
    if (typeof requestIdleCallback !== "undefined") {
      requestIdleCallback(cb);
    } else {
      setTimeout(cb, fallbackMs);
    }
  };

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

  // Debounced room caching — no-op: Dexie is now the persistent store
  const debouncedCacheRooms = () => {};

  // Track rooms that failed decryption — retry with backoff instead of permanent block
  const decryptFailedRooms = new Map<string, { count: number; lastAttempt: number }>();

  // Track peer encryption key availability per room
  const peerKeysStatus = reactive(new Map<string, PeerKeysStatus>());
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

  // Room-level pin/mute (Batch 7) — per-account keys
  let _pinnedKey = "chat_pinned_rooms";
  let _mutedKey = "chat_muted_rooms";

  const pinnedRoomIds = ref<Set<string>>(new Set());
  const mutedRoomIds = ref<Set<string>>(new Set());

  /** Called from auth store on login/switch to bind per-account keys */
  const bindAccountKeys = (address: string) => {
    _pinnedKey = `chat_pinned_rooms:${address}`;
    _mutedKey = `chat_muted_rooms:${address}`;
    pinnedRoomIds.value = new Set(JSON.parse(localStorage.getItem(_pinnedKey) || "[]"));
    mutedRoomIds.value = new Set(JSON.parse(localStorage.getItem(_mutedKey) || "[]"));
  };

  const persistRoomSets = () => {
    localStorage.setItem(_pinnedKey, JSON.stringify([...pinnedRoomIds.value]));
    localStorage.setItem(_mutedKey, JSON.stringify([...mutedRoomIds.value]));
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

    const myAddr = useAuthStore().address;

    // Dexie-first path: query the DB for the last inbound timestamp
    if (chatDbKitRef.value && myAddr) {
      const clearedAtTs = chatDbKitRef.value.eventWriter.getClearedAtTs(roomId);
      chatDbKitRef.value.messages.getLastInboundTimestamp(roomId, myAddr, clearedAtTs)
        .then((lastInboundTs) => {
          if (lastInboundTs > 0) {
            return commitReadWatermark(roomId, lastInboundTs);
          } else {
            return chatDbKitRef.value?.eventWriter.clearUnread(roomId);
          }
        })
        .catch(() => {});
      return;
    }

    // Legacy fallback: read from in-memory store
    const roomMsgs = messages.value[roomId];
    const lastInboundTs = roomMsgs
      ?.filter(m => m.senderId !== myAddr)
      .reduce((max, m) => (m.timestamp > max ? m.timestamp : max), 0) ?? 0;

    if (lastInboundTs > 0) {
      commitReadWatermark(roomId, lastInboundTs).catch(() => {});
    }
  };

  // References to matrix helpers (set by auth store after init)
  const matrixKitRef = shallowRef<MatrixKit | null>(null);
  const pcryptoRef = shallowRef<Pcrypto | null>(null);
  const chatDbKitRef = shallowRef<ChatDbKit | null>(null);

  const setChatDbKit = (kit: ChatDbKit) => {
    chatDbKitRef.value = kit;
    // Enable batched writes for background rooms
    kit.eventWriter.enableBatching();
  };

  /** Get the Dexie kit (throws if not initialized) */
  const getDbKit = (): ChatDbKit => {
    if (!chatDbKitRef.value) throw new Error("[chat-store] ChatDbKit not initialized");
    return chatDbKitRef.value;
  };

  // Primary message source: Dexie liveQuery (auto-subscribes to DB changes)
  const { data: dexieMessages, isReady: dexieMessagesReady } = useLiveQuery(
    () => {
      if (!activeRoomId.value || !chatDbKitRef.value) return [] as import("@/shared/lib/local-db").LocalMessage[];
      const clearedAtTs = chatDbKitRef.value.eventWriter.getClearedAtTs(activeRoomId.value);
      return chatDbKitRef.value.messages.getMessages(
        activeRoomId.value,
        debouncedMessageWindowSize.value,
        undefined,
        clearedAtTs,
      );
    },
    () => [activeRoomId.value, debouncedMessageWindowSize.value, chatDbKitRef.value] as const,
    [] as import("@/shared/lib/local-db").LocalMessage[],
  );

  // Delta-based room tracking: one-time load + incremental updates via Dexie hooks.
  const dexieRooms = shallowRef<LocalRoom[]>([]);
  const dexieRoomsReady = ref(false);
  const dexieRoomMap = new Map<string, LocalRoom>();
  let dexieChangesUnsub: (() => void) | null = null;
  // Reactive version counter — incremented whenever dexieRoomMap is mutated.
  // This makes computed properties that read from dexieRoomMap properly reactive.
  const _dexieRoomMapVersion = ref(0);

  // Outbound watermark for active room — used to derive message statuses
  const activeRoomOutboundWatermark = computed(() => {
    // Access version counter to register reactive dependency on dexieRoomMap mutations
    void _dexieRoomMapVersion.value;
    if (!activeRoomId.value) return 0;
    const lr = dexieRoomMap.get(activeRoomId.value);
    return lr?.lastReadOutboundTs ?? 0;
  });

  const activeRoom = computed(() => {
    // Access rooms.value to register Vue reactive dependency
    void rooms.value;
    return activeRoomId.value ? getRoomById(activeRoomId.value) : undefined;
  });

  // Convert Dexie LocalMessage[] → Message[] for UI, fallback to old shallowRef during migration.
  // Memoization: reuse previous Message objects for items that haven't changed (same eventId+timestamp).
  // This prevents VList from re-rendering unchanged items when the array grows during pagination.
  let _prevDexieInput: import("@/shared/lib/local-db").LocalMessage[] = [];
  let _prevActiveOutput: Message[] = [];
  let _prevWatermark: number = 0;
  const activeMessages = computed<Message[]>(() => {
    let msgs: Message[];
    if (chatDbKitRef.value) {
      const raw = dexieMessages.value;
      const myAddr = useAuthStore().address ?? undefined;
      const watermark = activeRoomOutboundWatermark.value;

      // Fast path: reuse only if BOTH input array AND watermark are unchanged
      if (raw === _prevDexieInput && watermark === _prevWatermark && _prevActiveOutput.length > 0) {
        return _prevActiveOutput;
      }

      // Incremental conversion: reuse Message objects for unchanged LocalMessages.
      // Build a lookup from the previous output by eventId for O(1) reuse.
      const watermarkChanged = watermark !== _prevWatermark;
      const prevById = new Map<string, Message>();
      for (const m of _prevActiveOutput) {
        prevById.set(m.id, m);
      }

      msgs = raw.map(local => {
        const id = local.eventId ?? local.clientId;
        const prev = prevById.get(id);
        const isOwnMessage = myAddr && local.senderId === myAddr;
        // Reuse if content unchanged AND status wouldn't change.
        // Own messages must be re-derived when watermark changes (read receipt arrived).
        // Also invalidate when reactions or poll votes change — these update the LocalMessage
        // in Dexie without changing its timestamp.
        if (prev && prev.timestamp === local.timestamp
            && !(watermarkChanged && isOwnMessage)
            && reactionsShallowEqual(prev.reactions, local.reactions)
            && pollInfoShallowEqual(prev.pollInfo, local.pollInfo)
            && prev.deleted === local.deleted
            && prev.edited === local.edited
            && prev.status === localStatusToMessageStatus(local.status)
            && prev.uploadProgress === local.uploadProgress
            && prev.fileInfo?.url === (local.localBlobUrl || local.fileInfo?.url)) {
          return prev;
        }
        return localToMessages([local], watermark, myAddr)[0];
      });

      _prevDexieInput = raw;
      _prevWatermark = watermark;
    } else {
      msgs = activeRoomId.value ? (messages.value[activeRoomId.value] ?? []) : [];
    }

    // Deduplicate: a pending message (clientId) and its server echo (eventId)
    // can coexist briefly. Keep the one with a server eventId when both exist.
    if (msgs.length > 0) {
      const seen = new Set<string>();
      const deduped: Message[] = [];
      for (const m of msgs) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        deduped.push(m);
      }
      if (deduped.length !== msgs.length) msgs = deduped;
    }

    _prevActiveOutput = msgs;
    return msgs;
  });

  // Memoized: only recompute when activeMessages reference changes
  let _prevActiveMessagesRef: typeof activeMessages.value | null = null;
  let _cachedMediaMessages: typeof activeMessages.value = [];
  const activeMediaMessages = computed(() => {
    if (activeMessages.value !== _prevActiveMessagesRef) {
      _prevActiveMessagesRef = activeMessages.value;
      _cachedMediaMessages = activeMessages.value.filter(m => m.type === MessageType.image || m.type === MessageType.video);
    }
    return _cachedMediaMessages;
  });

  // Cache: reuse ChatRoom objects when LocalRoom hasn't changed (reduces GC pressure).
  // Invalidated by fields that affect display: timestamp, unread, name, membership.
  const _chatRoomFromDexieCache = new Map<string, {
    ts: number;
    unread: number;
    name: string;
    membership: string;
    preview: string | null | undefined;
    localStatus: string | null | undefined;
    readOutboundTs: number;
    lastMsgDecryptionStatus: string | undefined;
    room: ChatRoom;
  }>();

  // ---------------------------------------------------------------------------
  // Map a single LocalRoom → ChatRoom (extracted from old computeSortedRooms)
  // ---------------------------------------------------------------------------
  const mapLocalRoomToChatRoom = (lr: LocalRoom): ChatRoom => {
    const ts = lr.lastMessageTimestamp ?? 0;
    // Resolve effective preview: prefer decrypted cache over raw Dexie value
    let effectivePreview = lr.lastMessagePreview;
    if (effectivePreview != null && (effectivePreview === "[encrypted]" || effectivePreview === "m.bad.encrypted" || effectivePreview.startsWith("** Unable to decrypt"))) {
      const decrypted = decryptedPreviewCache.get(lr.id);
      if (decrypted) effectivePreview = decrypted;
    }

    const localStatus = lr.lastMessageLocalStatus;
    const readOutboundTs = lr.lastReadOutboundTs ?? 0;
    const lastMsgDecryptionStatus = lr.lastMessageDecryptionStatus;
    const cached = _chatRoomFromDexieCache.get(lr.id);
    if (
      cached &&
      cached.ts === ts &&
      cached.unread === lr.unreadCount &&
      cached.name === lr.name &&
      cached.membership === lr.membership &&
      cached.room.avatar === lr.avatar &&
      cached.preview === effectivePreview &&
      cached.localStatus === localStatus &&
      cached.readOutboundTs === readOutboundTs &&
      cached.lastMsgDecryptionStatus === lastMsgDecryptionStatus
    ) {
      return cached.room;
    }
    const room: ChatRoom = {
      id: lr.id,
      name: lr.name,
      avatar: lr.avatar,
      isGroup: lr.isGroup,
      members: lr.members,
      membership: lr.membership as "join" | "invite",
      unreadCount: lr.unreadCount,
      topic: lr.topic,
      updatedAt: lr.updatedAt,
      lastMessage: effectivePreview != null ? {
        id: "",
        roomId: lr.id,
        senderId: lr.lastMessageSenderId ?? "",
        content: effectivePreview,
        timestamp: ts,
        status: deriveOutboundStatus(
            lr.lastMessageLocalStatus ?? "synced",
            ts,
            lr.lastReadOutboundTs ?? 0,
          ),
        type: lr.lastMessageType ?? MessageType.text,
        decryptionStatus: lr.lastMessageDecryptionStatus,
        callInfo: lr.lastMessageCallInfo,
        systemMeta: lr.lastMessageSystemMeta,
      } as Message : undefined,
      lastMessageReaction: lr.lastMessageReaction ?? undefined,
    } as ChatRoom;
    _chatRoomFromDexieCache.set(lr.id, { ts, unread: lr.unreadCount, name: lr.name, membership: lr.membership, preview: effectivePreview, localStatus, readOutboundTs, lastMsgDecryptionStatus, room });
    return room;
  };

  // ---------------------------------------------------------------------------
  // Incremental sort helpers
  // ---------------------------------------------------------------------------

  const getSortKey = (room: ChatRoom): number =>
    room.lastMessage?.timestamp || room.updatedAt || 0;

  /** Binary search for insertion in descending-sorted array */
  const binarySearchDesc = (arr: ChatRoom[], key: number, pinned: ReadonlySet<string>, isPinned: boolean): number => {
    let lo: number, hi: number;
    if (isPinned) {
      lo = 0;
      hi = 0;
      while (hi < arr.length && pinned.has(arr[hi].id)) hi++;
    } else {
      lo = 0;
      while (lo < arr.length && pinned.has(arr[lo].id)) lo++;
      hi = arr.length;
    }
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (getSortKey(arr[mid]) > key) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  const _sortedRoomsRef = shallowRef<ChatRoom[]>([]);
  // Accumulate Dexie delta changes while suppressed, then apply incrementally
  let _deferredChanges: RoomChange[] = [];
  // Suppress Dexie-triggered recomputes during fullRoomRefresh to avoid
  // intermediate re-sorts while bulkSyncRooms writes are landing.
  let _suppressDexieRecompute = false;

  const computeSortedRoomsFallback = (source: ChatRoom[], pinned: ReadonlySet<string>): ChatRoom[] => {
    return [...source].sort((a, b) => {
      const aPinned = pinned.has(a.id) ? 1 : 0;
      const bPinned = pinned.has(b.id) ? 1 : 0;
      if (aPinned !== bPinned) return bPinned - aPinned;
      return getSortKey(b) - getSortKey(a);
    });
  };

  const patchSortedRooms = (changes: RoomChange[]) => {
    perfCount("sortedRooms:patch");
    const arr = [..._sortedRoomsRef.value];
    const pinned = pinnedRoomIds.value;
    for (const change of changes) {
      if (change.type === "delete") {
        const idx = arr.findIndex(r => r.id === change.roomId);
        if (idx !== -1) arr.splice(idx, 1);
        _chatRoomFromDexieCache.delete(change.roomId);
      } else {
        const chatRoom = mapLocalRoomToChatRoom(change.room);
        const oldIdx = arr.findIndex(r => r.id === change.room.id);
        if (oldIdx !== -1) arr.splice(oldIdx, 1);
        const key = getSortKey(chatRoom);
        const isPinned = pinned.has(change.room.id);
        const newIdx = binarySearchDesc(arr, key, pinned, isPinned);
        arr.splice(newIdx, 0, chatRoom);
      }
    }
    _sortedRoomsRef.value = arr;
  };

  // ---------------------------------------------------------------------------
  // Async full rebuild (chunked to avoid blocking event loop on large lists)
  // ---------------------------------------------------------------------------

  const fullRebuildSortedRoomsAsync = async () => {
    perfCount("sortedRooms:fullRebuild");
    const allRooms = Array.from(dexieRoomMap.values());
    if (allRooms.length === 0 && rooms.value.length > 0) {
      _sortedRoomsRef.value = computeSortedRoomsFallback(rooms.value, pinnedRoomIds.value);
      return;
    }
    const CHUNK = 5000;
    const mapped: ChatRoom[] = [];
    for (let i = 0; i < allRooms.length; i += CHUNK) {
      const end = Math.min(i + CHUNK, allRooms.length);
      for (let j = i; j < end; j++) {
        mapped.push(mapLocalRoomToChatRoom(allRooms[j]));
      }
      if (end < allRooms.length) await yieldToMain();
    }
    const pinned = pinnedRoomIds.value;
    mapped.sort((a, b) => {
      const aPinned = pinned.has(a.id) ? 1 : 0;
      const bPinned = pinned.has(b.id) ? 1 : 0;
      if (aPinned !== bPinned) return bPinned - aPinned;
      return getSortKey(b) - getSortKey(a);
    });
    _sortedRoomsRef.value = mapped;

    // Prune stale cache entries when cache grows beyond 1.5x current room count
    if (_chatRoomFromDexieCache.size > allRooms.length * 1.5) {
      const activeIds = new Set(allRooms.map(lr => lr.id));
      for (const key of _chatRoomFromDexieCache.keys()) {
        if (!activeIds.has(key)) _chatRoomFromDexieCache.delete(key);
      }
    }
  };

  let _cleanupTimer: ReturnType<typeof setTimeout> | null = null;
  let _cleanupInterval: ReturnType<typeof setInterval> | null = null;
  const CLEANUP_DELAY_MS = 30_000;
  const CLEANUP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

  const runRoomCleanup = async () => {
    if (!chatDbKitRef.value) return;
    const matrixService = getMatrixClientService();
    const { cleanupStaleRooms } = await import("./room-cleanup");
    await cleanupStaleRooms({
      getAllRooms: () => chatDbKitRef.value!.rooms.getAllRooms(),
      deleteRooms: (ids) => chatDbKitRef.value!.rooms.bulkRemoveRooms(ids).catch(() => {}),
      isRoomInSdk: (id) => !!matrixService.getRoom(id),
      getRoomHistoryVisibility: (id) => {
        try {
          const room = matrixService.getRoom(id) as any;
          const ev = room?.currentState?.getStateEvents?.("m.room.history_visibility", "");
          return ev?.getContent?.()?.history_visibility ?? null;
        } catch { return null; }
      },
    });
  };

  const scheduleRoomCleanup = () => {
    cancelRoomCleanup();
    _cleanupTimer = setTimeout(() => {
      runRoomCleanup();
      _cleanupInterval = setInterval(runRoomCleanup, CLEANUP_INTERVAL_MS);
    }, CLEANUP_DELAY_MS);
  };

  const cancelRoomCleanup = () => {
    if (_cleanupTimer) { clearTimeout(_cleanupTimer); _cleanupTimer = null; }
    if (_cleanupInterval) { clearInterval(_cleanupInterval); _cleanupInterval = null; }
  };

  let _fullRebuildTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleFullSortedRebuild = () => {
    if (_fullRebuildTimer) return;
    _fullRebuildTimer = setTimeout(() => {
      _fullRebuildTimer = null;
      fullRebuildSortedRoomsAsync();
    }, 50);
  };

  // ---------------------------------------------------------------------------
  // Delta-based Dexie room tracking
  // ---------------------------------------------------------------------------

  /** One-time: load all rooms from Dexie into memory */
  const initDexieRooms = async (dbKit: ChatDbKit) => {
    const allRooms = await dbKit.rooms.getAllRooms();
    dexieRoomMap.clear();
    for (const r of allRooms) dexieRoomMap.set(r.id, r);
    _dexieRoomMapVersion.value++;
    dexieRooms.value = allRooms;
    // Warm clearedAtTs cache from Dexie so write-guards work for all rooms on sync
    for (const r of allRooms) {
      if (r.clearedAtTs) dbKit.eventWriter.setClearedAtTs(r.id, r.clearedAtTs);
    }
    dexieRoomsReady.value = true;
    dexieChangesUnsub?.();
    dexieChangesUnsub = dbKit.rooms.observeRoomChanges((changes) => {
      applyDexieDeltas(changes);
    });
  };

  const applyDexieDeltas = (changes: RoomChange[]) => {
    // Always update dexieRoomMap (ground truth), but defer sort when suppressed
    const relevantChanges: RoomChange[] = [];
    for (const c of changes) {
      if (c.type === "delete") {
        if (dexieRoomMap.has(c.roomId)) {
          dexieRoomMap.delete(c.roomId);
          relevantChanges.push(c);
        }
      } else {
        const r = c.room;
        if ((r.membership === "join" || r.membership === "invite") && !r.isDeleted) {
          if (!r.updatedAt) r.updatedAt = r.lastMessageTimestamp || 1;
          dexieRoomMap.set(r.id, r);
          relevantChanges.push(c);
        } else if (dexieRoomMap.has(r.id)) {
          dexieRoomMap.delete(r.id);
          relevantChanges.push({ type: "delete", roomId: r.id });
        }
      }
    }
    if (relevantChanges.length === 0) return;
    _dexieRoomMapVersion.value++;

    if (_suppressDexieRecompute) {
      // Accumulate for deferred application — will be applied incrementally in finally block
      _deferredChanges.push(...relevantChanges);
      return;
    }

    dexieRooms.value = Array.from(dexieRoomMap.values());
    if (relevantChanges.length > 100) {
      scheduleFullSortedRebuild();
    } else {
      patchSortedRooms(relevantChanges);
    }
  };

  // Before Dexie init: rooms.value is the source of truth → sync fallback sort.
  // After Dexie init: delta tracking owns _sortedRoomsRef, rooms.value changes are ignored.
  // pinnedRoomIds changes always trigger rebuild (pin order affects sort).
  let _prevPinnedRef = pinnedRoomIds.value;
  watch(
    [rooms, pinnedRoomIds],
    () => {
      const dexieActive = chatDbKitRef.value && dexieRoomMap.size > 0;
      const pinsChanged = pinnedRoomIds.value !== _prevPinnedRef;
      _prevPinnedRef = pinnedRoomIds.value;

      if (dexieActive) {
        // Only rebuild if pinned rooms changed — rooms.value updates are
        // handled by Dexie delta tracking (observeRoomChanges → patchSortedRooms)
        if (pinsChanged) scheduleFullSortedRebuild();
      } else {
        _sortedRoomsRef.value = computeSortedRoomsFallback(rooms.value, pinnedRoomIds.value);
      }
    },
    { immediate: true, flush: "sync" },
  );

  // Watch for chatDbKit initialization
  watch(
    () => chatDbKitRef.value,
    async (kit) => {
      if (kit) {
        await initDexieRooms(kit);
        await fullRebuildSortedRoomsAsync();
        // Self-heal unread counts on first load (deferred to not block UI)
        queueMicrotask(() => healUnreadCounts());
      } else {
        dexieChangesUnsub?.();
        dexieChangesUnsub = null;
        dexieRoomMap.clear();
        _dexieRoomMapVersion.value++;
        dexieRooms.value = [];
        dexieRoomsReady.value = false;
        if (_fullRebuildTimer) { clearTimeout(_fullRebuildTimer); _fullRebuildTimer = null; }
        cancelRoomCleanup();
      }
    },
    { immediate: true },
  );

  const sortedRooms = computed(() => _sortedRoomsRef.value);

  const totalUnread = computed(() => {
    if (chatDbKitRef.value && dexieRoomMap.size > 0) {
      void dexieRooms.value; // register reactive dependency
      let sum = 0;
      for (const r of dexieRoomMap.values()) sum += r.unreadCount;
      return sum;
    }
    return rooms.value.reduce((sum, r) => sum + r.unreadCount, 0);
  });

  /** Set helper references from auth store */
  const setHelpers = (kit: MatrixKit, crypto: Pcrypto) => {
    matrixKitRef.value = kit;
    pcryptoRef.value = crypto;
  };


  /** Internal: actual refresh logic (called by debounced wrapper) */
  const PRELOAD_COUNT = 15;
  const NEIGHBOR_PRELOAD_COUNT = 1; // rooms above/below active to network-preload
  let preloadDone = false;

  // ── Viewport-fetch state machine ─────────────────────────────────
  // Replaces the old once-only preloadedRoomIds/cachePreloadedRoomIds Sets
  // with a proper per-room state machine that supports retry.

  interface RoomFetchState {
    status: "idle" | "loading" | "success" | "error";
    retryCount: number;
    lastAttemptAt: number;
    error?: string;
  }

  const VIEWPORT_FETCH_MAX_RETRY = 3;
  const VIEWPORT_FETCH_MAX_CONCURRENT = 5;
  let viewportFetchActiveCount = 0;
  /** Current viewport generation — when a new scroll position arrives, previous fetches are cancelled. */
  let currentViewportGeneration = 0;

  type FetchPriority = "high" | "low";
  interface PendingFetchItem {
    id: string;
    priority: FetchPriority;
    generation: number;
  }
  const pendingFetchQueue: PendingFetchItem[] = [];

  const roomFetchStates = reactive(new Map<string, RoomFetchState>());

  /** Fetch room data for viewport preview: cache first, then network (loadRoomMessages).
   *  Checks generation between async steps — if the user scrolled away, aborts early. */
  const fetchRoomPreview = async (roomId: string, generation: number): Promise<void> => {
    // Stale generation — user scrolled away, abort
    if (generation !== currentViewportGeneration) return;

    const prev = roomFetchStates.get(roomId);
    const retryCount = prev?.retryCount ?? 0;

    roomFetchStates.set(roomId, {
      status: "loading",
      retryCount,
      lastAttemptAt: Date.now(),
    });

    try {
      if (generation !== currentViewportGeneration) return;

      // Phase 1: cache (fast, from Dexie/localStorage)
      if (!messages.value[roomId]?.length) {
        await loadCachedMessages(roomId).catch(() => {});
      }

      if (generation !== currentViewportGeneration) return;

      // Phase 2: network — loadRoomMessages fetches from Matrix SDK (scrollback)
      await loadRoomMessages(roomId);

      if (generation !== currentViewportGeneration) return;

      roomFetchStates.set(roomId, {
        status: "success",
        retryCount,
        lastAttemptAt: Date.now(),
      });
    } catch (e) {
      // Don't mark error if generation is stale
      if (generation !== currentViewportGeneration) return;

      console.warn(`[viewport-fetch] Room ${roomId} failed (attempt ${retryCount + 1}):`, e);
      roomFetchStates.set(roomId, {
        status: "error",
        retryCount: retryCount + 1,
        lastAttemptAt: Date.now(),
        error: String(e),
      });
    }
  };

  /** Drain the pending fetch queue, respecting concurrency limit. */
  const drainFetchQueue = () => {
    while (pendingFetchQueue.length > 0 && viewportFetchActiveCount < VIEWPORT_FETCH_MAX_CONCURRENT) {
      const item = pendingFetchQueue.shift()!;

      // Skip stale generation items
      if (item.generation !== currentViewportGeneration) continue;

      // Skip if room was already loaded by another path while waiting in queue
      const currentState = roomFetchStates.get(item.id);
      if (currentState?.status === "success") continue;

      viewportFetchActiveCount++;
      fetchRoomPreview(item.id, item.generation).finally(() => {
        viewportFetchActiveCount--;
        drainFetchQueue();
      });
    }
  };

  /** Ensure rooms are loaded. Rooms in idle/error (with cooldown passed) will be fetched.
   *  Priority 'high' = viewport-visible rooms, enqueued at front.
   *  Priority 'low' = prefetch buffer rooms, enqueued at back.
   *  @param generation — viewport scroll generation; new generation cancels pending from old. */
  const ensureRoomsLoaded = (roomIds: string[], priority: FetchPriority = "high", generation?: number) => {
    // Update generation and clear stale queue items
    if (generation != null) {
      if (generation > currentViewportGeneration) {
        currentViewportGeneration = generation;
        // Clear queue — all pending items are from a stale viewport position
        pendingFetchQueue.length = 0;
        // Reset loading states for rooms that were queued but not yet fetched
        for (const [id, state] of roomFetchStates) {
          if (state.status === "loading") {
            roomFetchStates.set(id, { status: "idle", retryCount: state.retryCount, lastAttemptAt: state.lastAttemptAt });
          }
        }
      }
    }
    const gen = generation ?? currentViewportGeneration;

    for (const id of roomIds) {
      if (id === activeRoomId.value) continue;
      const room = getRoomById(id);
      if (!room || room.membership === "invite") continue;

      const state = roomFetchStates.get(id);

      // Already loaded or loading — skip
      if (state?.status === "success") continue;
      if (state?.status === "loading") continue;

      // Error — check retry limit and cooldown
      if (state?.status === "error") {
        if (state.retryCount >= VIEWPORT_FETCH_MAX_RETRY) continue;
        const cooldown = Math.min(1000 * Math.pow(2, state.retryCount - 1), 10_000);
        if (Date.now() - state.lastAttemptAt < cooldown) continue;
      }

      // Check if already in queue
      const existingIdx = pendingFetchQueue.findIndex(p => p.id === id);
      if (existingIdx >= 0) {
        // Promote to high priority if needed
        if (priority === "high" && pendingFetchQueue[existingIdx].priority === "low") {
          const [existing] = pendingFetchQueue.splice(existingIdx, 1);
          existing.priority = "high";
          const firstLowIdx = pendingFetchQueue.findIndex(p => p.priority === "low");
          if (firstLowIdx >= 0) {
            pendingFetchQueue.splice(firstLowIdx, 0, existing);
          } else {
            pendingFetchQueue.push(existing);
          }
        }
        continue;
      }

      // Mark as loading preemptively so concurrent calls don't double-enqueue
      roomFetchStates.set(id, {
        status: "loading",
        retryCount: state?.retryCount ?? 0,
        lastAttemptAt: Date.now(),
      });

      // Enqueue — high priority at front (after existing high), low at back
      const item: PendingFetchItem = { id, priority, generation: gen };
      if (priority === "high") {
        const firstLowIdx = pendingFetchQueue.findIndex(p => p.priority === "low");
        if (firstLowIdx >= 0) {
          pendingFetchQueue.splice(firstLowIdx, 0, item);
        } else {
          pendingFetchQueue.push(item);
        }
      } else {
        pendingFetchQueue.push(item);
      }
    }

    drainFetchQueue();
  };

  /** Manual retry for a specific room — resets retry count and immediately enqueues. */
  const retryRoomFetch = (roomId: string) => {
    roomFetchStates.set(roomId, {
      status: "idle",
      retryCount: 0,
      lastAttemptAt: 0,
    });
    ensureRoomsLoaded([roomId], "high");
  };

  /** Background-preload messages for rooms near the active room.
   *  Phase 1: active room + 2 neighbors get immediate network preload.
   *  Phase 2: remaining viewport rooms get cache-only preload via requestIdleCallback. */
  const preloadVisibleRooms = async () => {
    if (preloadDone) return;
    preloadDone = true;

    const sorted = sortedRooms.value;
    const activeId = activeRoomId.value;

    // Check if Matrix SDK has rooms — if not, defer preload
    try {
      const matrixService = getMatrixClientService();
      const sdkRooms = matrixService.getRooms() as unknown[];
      if ((!sdkRooms || sdkRooms.length === 0) && sorted.length > 0) {
        // SDK hasn't populated rooms yet — retry in 2s
        preloadDone = false;
        setTimeout(() => preloadVisibleRooms(), 2000);
        return;
      }
    } catch {
      // Matrix service not ready — retry later
      preloadDone = false;
      setTimeout(() => preloadVisibleRooms(), 2000);
      return;
    }

    // Priority: active room + N neighbors (immediate network preload)
    const activeIdx = activeId ? sorted.findIndex(r => r.id === activeId) : -1;
    const priorityRooms: typeof sorted = [];
    if (activeIdx >= 0) {
      for (let d = 1; d <= NEIGHBOR_PRELOAD_COUNT; d++) {
        if (activeIdx - d >= 0) priorityRooms.push(sorted[activeIdx - d]);
        if (activeIdx + d < sorted.length) priorityRooms.push(sorted[activeIdx + d]);
      }
    }
    const priorityFiltered = priorityRooms.filter(
      r => r.id !== activeId && r.membership !== "invite",
    );

    // Phase 1: cache + network for priority rooms via ensureRoomsLoaded
    ensureRoomsLoaded(priorityFiltered.map(r => r.id), "high");

    // Phase 2: cache-only preload for remaining viewport rooms via idle callback.
    // These rooms are NOT added to roomFetchStates — intentionally allowing
    // ensureRoomsLoaded to trigger a full network fetch when the user scrolls to them.
    const remaining = sorted
      .slice(0, PRELOAD_COUNT)
      .filter(r => r.id !== activeId && r.membership !== "invite" &&
        !roomFetchStates.has(r.id));

    if (remaining.length > 0) {
      const loadNextBatch = (offset: number) => {
        const batch = remaining.slice(offset, offset + 3);
        if (batch.length === 0) return;
        Promise.all(batch.map(room => {
          return messages.value[room.id]?.length ? Promise.resolve() : loadCachedMessages(room.id).catch(() => {});
        })).then(() => {
          if (offset + 3 < remaining.length) {
            scheduleIdle(() => loadNextBatch(offset + 3), 100);
          }
        });
      };
      scheduleIdle(() => loadNextBatch(0), 100);
    }
  };

  /** Viewport-based preload: preload messages for specific room IDs (called from contact list on scroll).
   *  Delegates to ensureRoomsLoaded with proper state tracking and retry support. */
  const preloadRoomsByIds = (roomIds: string[]) => {
    ensureRoomsLoaded(roomIds, "high");
  };

  /** Full room rebuild — used for initial sync and periodic reconciliation */
  const fullRoomRefresh = async (
    matrixRooms: any[],
    kit: MatrixKit,
    myUserId: string,
  ) => {
    if (fullRefreshInFlight) return;
    fullRefreshInFlight = true;
    _suppressDexieRecompute = true;
    try {
    perfMark("fullRoomRefresh-start");
    // Retry previously failed decryptions on full refresh
    decryptFailedRooms.clear();

    // Preserve existing room data — addRoom/addMessage/cache may have set data that Matrix can't resolve yet.
    // Single pass instead of 4 × O(n) map() calls — significant at 100k rooms.
    const prevNameMap = new Map<string, string>();
    const prevLastMessageMap = new Map<string, Message | undefined>();
    const prevMembersMap = new Map<string, string[]>();
    const prevAvatarMap = new Map<string, string>();
    for (const r of rooms.value) {
      prevNameMap.set(r.id, r.name);
      prevLastMessageMap.set(r.id, r.lastMessage);
      prevMembersMap.set(r.id, r.members);
      if (r.avatar) prevAvatarMap.set(r.id, r.avatar);
    }
    const prevActiveRoom = activeRoomId.value ? getRoomById(activeRoomId.value) : undefined;

    const interactiveRooms = filterInteractiveRooms(matrixRooms);
    if (import.meta.env.DEV) {
      console.log(`[perf] fullRoomRefresh: ${interactiveRooms.length} rooms to process`);
    }
    const prevActiveIsExternal = prevActiveRoom && !interactiveRooms.some((r: any) => (r.roomId as string) === prevActiveRoom.id);

    const ROOM_CHUNK = 50;
    const newRooms: ChatRoom[] = [];

    for (let i = 0; i < interactiveRooms.length; i += ROOM_CHUNK) {
      const slice = interactiveRooms.slice(i, i + ROOM_CHUNK);
      for (const r of slice) {
        const room = buildChatRoom(r, kit, myUserId, prevNameMap, prevLastMessageMap);
        const prevMembers = prevMembersMap.get(room.id);
        if (prevMembers && prevMembers.length > room.members.length) {
          room.members = prevMembers;
          const prevAvatar = prevAvatarMap.get(room.id);
          if (prevAvatar) room.avatar = prevAvatar;
        }
        newRooms.push(room);
      }

      // Yield between chunks to keep UI responsive, but do NOT publish
      // intermediate rooms.value — Dexie stale data provides first-paint.
      // Publishing per-chunk caused 4-6 intermediate re-sorts on large accounts.
      if (i + ROOM_CHUNK < interactiveRooms.length) {
        await yieldToMain();
      }
    }

    // Single atomic publish after all chunks are built
    {
      if (prevActiveRoom && !newRooms.some(r => r.id === prevActiveRoom.id)) {
        newRooms.push(prevActiveRoom);
      }
      rooms.value = newRooms;
      rebuildRoomsMap();
    }

    perfMark("fullRoomRefresh-allBuilt");
    perfMeasure("fullRoomRefresh:allBuilt", "fullRoomRefresh-start", "fullRoomRefresh-allBuilt");

    // Dual-write: sync room metadata to Dexie in a single transaction.
    // Single transaction = single liveQuery notification (instead of N).
    // Metadata fields are always updated. Unread/watermark: reconcile via
    // serverUnreadCount when server says 0 but local >0 (cross-device read sync).
    if (chatDbKitRef.value) {
      const dbKit = chatDbKitRef.value;
      const now = Date.now();
      const dexieSourceRooms = prevActiveIsExternal
        ? newRooms.filter(r => r.id !== prevActiveRoom!.id)
        : newRooms;

      // OPTIMIZATION: Only write rooms with display-relevant changes to Dexie
      const changedForDexie: ChatRoom[] = [];
      for (const r of dexieSourceRooms) {
        const prev = dexieRoomMap.get(r.id);
        if (!prev
          || prev.name !== r.name
          || prev.unreadCount !== r.unreadCount
          || (r.lastMessage?.timestamp ?? 0) !== (prev.lastMessageTimestamp ?? 0)
          || prev.membership !== (r.membership ?? "join")
          || prev.avatar !== r.avatar
        ) {
          changedForDexie.push(r);
        }
      }

      if (import.meta.env.DEV) {
        console.log(`[perf] fullRoomRefresh: ${dexieSourceRooms.length} total, ${changedForDexie.length} changed, ${dexieSourceRooms.length - changedForDexie.length} skipped`);
      }

      const updates = changedForDexie.map(r => ({
        id: r.id,
        name: r.name,
        avatar: r.avatar,
        isGroup: r.isGroup,
        members: r.members,
        membership: (r.membership ?? "join") as "join" | "invite" | "leave",
        topic: r.topic || "",
        syncedAt: now,
        updatedAt: r.updatedAt,
        lastMessageTimestamp: r.lastMessage?.timestamp || r.updatedAt || undefined,
        serverUnreadCount: r.unreadCount, // cross-device unread reconciliation
        // Full insert fields for genuinely new rooms
        unreadCount: r.unreadCount,
        lastMessagePreview: r.lastMessage?.deleted
          ? "🚫 Message deleted"
          : r.lastMessage?.content?.slice(0, 200),
        lastMessageSenderId: r.lastMessage?.senderId,
        lastMessageType: r.lastMessage?.type,
        lastMessageEventId: r.lastMessage?.id || undefined,
        lastMessageLocalStatus: (
          r.lastMessage?.status === MessageStatus.sending ? "pending"
          : r.lastMessage?.status === MessageStatus.failed ? "failed"
          : "synced"
        ) as import("@/shared/lib/local-db").LocalMessageStatus,
      }));
      // Await Dexie writes so that when _suppressDexieRecompute is lifted,
      // the recompute sees fresh timestamps — avoids stale sort order AND
      // avoids source-switching blink (Dexie→in-memory→Dexie).
      const DB_CHUNK = 100;
      for (let i = 0; i < updates.length; i += DB_CHUNK) {
        const chunk = updates.slice(i, i + DB_CHUNK);
        try {
          await dbKit.rooms.bulkSyncRooms(chunk);
        } catch (e) {
          console.warn("[chat-store] Dexie room sync chunk failed:", e);
          if (!chatDbKitRef.value) break; // DB torn down — abort remaining
        }
        if (i + DB_CHUNK < updates.length) {
          await yieldToMain();
        }
      }
    }

    // Build user display name cache from room members (sync — no API calls)
    // Only run loadMissingMembers once AND only when we have actual rooms
    const willLoadMembers = !membersLoadedOnce && interactiveRooms.length > 0;
    updateDisplayNames(interactiveRooms, kit, willLoadMembers);

    // Load profiles only for the first viewport of rooms (top ~15).
    // Remaining rooms get profiles on-demand via ContactList.loadVisibleRooms()
    // when the user scrolls. This avoids ~2000 getUserProfile requests on startup
    // for accounts with 1000+ rooms.
    const viewportIds = sortedRooms.value.slice(0, 15).map(r => r.id);
    if (viewportIds.length > 0) loadProfilesForRoomIds(viewportIds);

    // One-time: load members for viewport rooms only (lazy — others load on demand).
    // Previously loaded ALL rooms here, causing N×GET /members requests on startup.
    if (willLoadMembers) {
      membersLoadedOnce = true;
      const viewportRoomIds = new Set(viewportIds);
      const viewportMatrixRooms = interactiveRooms.filter(
        (mr: any) => viewportRoomIds.has(mr.roomId as string),
      );
      loadMissingMembers(viewportMatrixRooms, kit, myUserId);
    }

    // Decrypt [encrypted] previews asynchronously — results go to cache
    decryptRoomPreviews(interactiveRooms).then(() => debouncedCacheRooms());
    perfMark("fullRoomRefresh-end");
    perfMeasure("fullRoomRefresh", "fullRoomRefresh-start", "fullRoomRefresh-end");
    debouncedCacheRooms();
    } finally {
      fullRefreshInFlight = false;
      _suppressDexieRecompute = false;
      // Apply accumulated delta changes: incremental patch if few, full rebuild if many
      if (_deferredChanges.length > 0) {
        const deferred = _deferredChanges;
        _deferredChanges = [];
        dexieRooms.value = Array.from(dexieRoomMap.values());
        if (deferred.length > 100) {
          scheduleFullSortedRebuild();
        } else {
          patchSortedRooms(deferred);
        }
      }
      // Flush any room changes that accumulated while the chunked refresh was running.
      // Without this, changedRoomIds pile up because refreshRoomsImmediate() returns
      // early during fullRefreshInFlight, and no subsequent trigger may arrive to drain them.
      if (changedRoomIds.size > 0) {
        refreshRooms();
      }
    }
  };

  /** One-time: load members from server for rooms with only self as member.
   *  Updates room member lists + avatars. Profile loading is handled lazily by loadProfilesForRoomIds. */
  const loadMissingMembers = async (matrixRooms: any[], kit: MatrixKit, myUserId: string) => {
    const myHexId = getmatrixid(myUserId);
    const toLoad: any[] = [];

    // Find rooms that need member loading (only self as member from SDK).
    // Skip rooms where Dexie/roomsMap already has resolved members (e.g. from cache).
    for (const mr of matrixRooms) {
      const members = kit.getRoomMembers(mr);
      const memberIds = members.map((m: Record<string, unknown>) => getmatrixid(m.userId as string));
      const others = memberIds.filter(id => id !== myHexId);

      if (others.length === 0 && typeof mr.loadMembersIfNeeded === "function") {
        // Check if roomsMap already has members from Dexie cache
        const existing = roomsMap.get(mr.roomId as string);
        if (existing && existing.members.length > 1) continue;
        toLoad.push(mr);
      }
    }

    // Phase 1: Load missing members from server (no reactive updates)
    if (toLoad.length > 0) {
      const BATCH = 20;
      for (let i = 0; i < toLoad.length; i += BATCH) {
        const batch = toLoad.slice(i, i + BATCH);
        await Promise.all(batch.map(async (mr: any) => {
          try { await mr.loadMembersIfNeeded(); } catch (e) {
            console.warn(`[chat-store] loadMembersIfNeeded failed for ${mr.roomId}:`, e);
          }
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

  /** Incremental room refresh — only processes changed rooms.
   *  Fetches individual rooms by ID from SDK instead of scanning all rooms (O(changed) not O(n)). */
  const incrementalRoomRefresh = (
    kit: MatrixKit,
    myUserId: string,
    changed: Set<string>,
  ) => {
    const matrixService = getMatrixClientService();
    let removed = false;

    // Rebuild only changed rooms — fetch each individually from SDK
    const changedMatrixRooms: any[] = [];
    const removedIds = new Set<string>();
    for (const roomId of changed) {
      const matrixRoom = matrixService.getRoom(roomId) as any;
      if (!matrixRoom) {
        // Room gone from SDK — collect for batch removal
        if (roomsMap.has(roomId)) {
          roomsMap.delete(roomId);
          removedIds.add(roomId);
          removed = true;
        }
        continue;
      }

      // Check this room is still interactive
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

    // Batch-remove rooms in single O(n) pass instead of O(n) per room
    if (removedIds.size > 0) {
      rooms.value = rooms.value.filter(r => !removedIds.has(r.id));
    }

    if (changed.size > 0 || removed) {
      triggerRef(rooms);
    }

    // Dual-write changed rooms to Dexie in a single transaction.
    // Includes cross-device unread reconciliation via serverUnreadCount.
    if (chatDbKitRef.value && changed.size > 0) {
      const dbKit = chatDbKitRef.value;
      const now = Date.now();
      const updates = [...changed]
        .map(roomId => roomsMap.get(roomId))
        .filter((r): r is ChatRoom => !!r)
        .map(r => ({
          id: r.id,
          name: r.name,
          avatar: r.avatar,
          isGroup: r.isGroup,
          members: r.members,
          membership: (r.membership ?? "join") as "join" | "invite" | "leave",
          topic: r.topic || "",
          syncedAt: now,
          updatedAt: r.updatedAt,
          lastMessageTimestamp: r.lastMessage?.timestamp || r.updatedAt || undefined,
          serverUnreadCount: r.unreadCount, // cross-device unread reconciliation
          unreadCount: r.unreadCount,
          lastMessagePreview: r.lastMessage?.deleted
            ? "🚫 Message deleted"
            : r.lastMessage?.content?.slice(0, 200),
          lastMessageSenderId: r.lastMessage?.senderId,
          lastMessageType: r.lastMessage?.type,
          lastMessageEventId: r.lastMessage?.id || undefined,
          lastMessageLocalStatus: (
            r.lastMessage?.status === MessageStatus.sending ? "pending"
            : r.lastMessage?.status === MessageStatus.failed ? "failed"
            : "synced"
          ) as import("@/shared/lib/local-db").LocalMessageStatus,
        }));
      if (updates.length > 0) {
        dbKit.rooms.bulkSyncRooms(updates).catch(e =>
          console.warn("[chat-store] Dexie incremental room sync failed:", e)
        );
      }
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

  /** Filter Matrix rooms to interactive ones (joined/invited, non-spaces).
   *  Tombstone check is done in Dexie queries, not here — this only filters Matrix SDK rooms. */
  const filterInteractiveRooms = (matrixRooms: any[]): any[] => {
    return matrixRooms.filter((r) => {
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
    // Clear-history guard: discard candidates older than the clear marker.
    const roomClearedAtTs = chatDbKitRef.value?.eventWriter.getClearedAtTs(chatRoom.id);
    const candidates: Array<Message | undefined> = [chatRoom.lastMessage];
    const loadedMsgs = messages.value[chatRoom.id];
    if (loadedMsgs?.length) candidates.push(loadedMsgs[loadedMsgs.length - 1]);
    const prevLast = prevLastMessageMap ? prevLastMessageMap.get(chatRoom.id) : prev?.lastMessage;
    if (prevLast) candidates.push(prevLast);

    let best: Message | undefined;
    for (const c of candidates) {
      if (!c) continue;
      if (roomClearedAtTs && c.timestamp <= roomClearedAtTs) continue;
      const cEncrypted = c.content === "[encrypted]";
      const bestEncrypted = best ? best.content === "[encrypted]" : true;
      if (!best || (bestEncrypted && !cEncrypted) || (bestEncrypted === cEncrypted && c.timestamp > best.timestamp)) {
        best = c;
      }
    }
    if (best) {
      // Preserve the most advanced status from all candidates with the same ID.
      // matrixRoomToChatRoom always returns status=sent, but loaded messages
      // may have status=read from receipts — keep the most advanced one.
      const statusPriority = { [MessageStatus.sending]: 0, [MessageStatus.failed]: 0, [MessageStatus.sent]: 1, [MessageStatus.delivered]: 2, [MessageStatus.read]: 3 };
      for (const c of candidates) {
        if (!c || c.id !== best.id) continue;
        if ((statusPriority[c.status] ?? 0) > (statusPriority[best.status] ?? 0)) {
          best = { ...best, status: c.status };
        }
      }
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
   *  Only marks a room as "requested" if we actually found addresses to load or all are cached.
   *  On batch load failure, unblocks affected rooms so retry can happen on next call. */
  const loadProfilesForRoomIds = (roomIds: string[]) => {
    const uStore = useUserStore();
    const addressesToLoad: string[] = [];
    const roomsInThisBatch: string[] = [];
    for (const roomId of roomIds) {
      if (profilesRequestedForRooms.has(roomId)) continue;

      // Prefer Matrix SDK addresses (populated by updateDisplayNames)
      const sdkAddrs = matrixRoomAddresses.get(roomId);
      if (sdkAddrs && sdkAddrs.length > 0) {
        profilesRequestedForRooms.add(roomId);
        roomsInThisBatch.push(roomId);
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
      if (foundAddrs) {
        profilesRequestedForRooms.add(roomId);
        roomsInThisBatch.push(roomId);
      }
    }
    if (addressesToLoad.length > 0) {
      // Use DataLoader pattern: requests are collected within a microtick
      // and sent in batches of 30 with yielding between them
      uStore.enqueueProfiles([...new Set(addressesToLoad)]);
    }
  };

  const refreshRoomsImmediate = () => {
    const matrixService = getMatrixClientService();
    const kit = matrixKitRef.value;
    if (!matrixService.isReady() || !kit) {
      return;
    }

    // Skip if a chunked full refresh is still running — changedRoomIds
    // will accumulate and be processed when the next refresh fires.
    if (fullRefreshInFlight) return;

    const myUserId = matrixService.getUserId() ?? "";

    // Determine if we need a full rebuild or incremental update
    const isInitial = lastSyncState === "PREPARED" || !roomsInitialized.value;
    const forceFullRefresh = Date.now() - lastFullRefresh > FULL_REFRESH_INTERVAL;
    const changed = new Set(changedRoomIds);
    changedRoomIds.clear();

    if (isInitial || forceFullRefresh) {
      lastFullRefresh = Date.now();
      // Full refresh needs all rooms from SDK
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const matrixRooms = matrixService.getRooms() as any[];
      fullRoomRefresh(matrixRooms, kit, myUserId);
    } else {
      // Incremental: only process changed room IDs, don't scan all rooms
      incrementalRoomRefresh(kit, myUserId, changed);
    }

    // Mark rooms as initialized (first sync-based refresh complete)
    if (!roomsInitialized.value) {
      roomsInitialized.value = true;
      // Start background preloading after rooms are built
      // Delay lets the UI render the room list and decrypt previews first
      setTimeout(() => preloadVisibleRooms(), 500);

      // Schedule room cleanup 30s after init, then every 30 minutes
      scheduleRoomCleanup();
    }
  };

  /** Debounced refresh: batches multiple rapid calls into one (150ms window) */
  const refreshRooms = (state?: "PREPARED" | "SYNCING") => {
    if (state) lastSyncState = state;
    if (refreshDebounceTimer) clearTimeout(refreshDebounceTimer);
    refreshDebounceTimer = setTimeout(() => {
      refreshDebounceTimer = null;
      refreshRoomsImmediate();
      // Retry pending read watermarks — timeline may now have the events we need
      flushPendingReadWatermarks();
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
      if (!lmc || lmc !== "[encrypted]") continue;
      toDecrypt.push({ roomId, matrixRoom });
    }
    if (toDecrypt.length === 0) return;

    // Cap at 20 rooms per cycle to avoid blocking
    const capped = toDecrypt.slice(0, 20);

    // Decrypt sequentially with yield between each room to keep UI responsive.
    // Previously used Promise.all(batch of 5) which ran 5 heavy ECDH+pbkdf2
    // computations without yielding — causing 370ms+ long tasks.
    const decryptedResults: Array<{ roomId: string; body: string }> = [];

    for (const { roomId, matrixRoom } of capped) {
      try {
        const roomCrypto = await ensureRoomCrypto(roomId);
        if (!roomCrypto) continue;

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
              decryptedResults.push({ roomId, body: decrypted.body });
            }
          } catch {
            decryptFailedRooms.set(roomId, { count: (decryptFailedRooms.get(roomId)?.count ?? 0) + 1, lastAttempt: Date.now() });
          }
          break;
        }
      } catch {
        decryptFailedRooms.set(roomId, { count: (decryptFailedRooms.get(roomId)?.count ?? 0) + 1, lastAttempt: Date.now() });
      }

      // Yield to main thread between each room decryption
      await yieldToMain();
    }

    // Apply ALL decrypted results in one pass with a single triggerRef
    if (decryptedResults.length > 0) {
      for (const { roomId, body } of decryptedResults) {
        decryptedPreviewCache.set(roomId, body);
        const room = getRoomById(roomId);
        if (room?.lastMessage) {
          room.lastMessage = { ...room.lastMessage, content: body };
        }
      }
      triggerRef(rooms);
    }
  };

  // Pending read receipts: queued when tab is hidden, sent when visible.
  // Uses Map to support multiple rooms (previous single-receipt design lost all but last).
  const pendingReadReceipts = new Map<string, unknown>(); // roomId → Matrix event

  // Pending read watermarks: rooms where Dexie was updated but Matrix receipt
  // could not be sent (event not found in timeline, HTTP error, tab hidden, etc.).
  // Retried on every sync cycle so the server eventually learns about reads.
  const pendingReadWatermarks = new Map<string, number>();

  /** Send a read receipt if the page is visible, otherwise queue for later.
   *  On native platforms (Capacitor WebView), document.visibilityState is unreliable —
   *  it can report "hidden" even when the app is in foreground — so we always send. */
  const sendReadReceiptIfVisible = async (roomId: string, event: unknown): Promise<boolean> => {
    const shouldSend = isNative || document.visibilityState === "visible";
    if (shouldSend) {
      try {
        const matrixService = getMatrixClientService();
        const success = await matrixService.sendReadReceipt(event);
        if (!success) {
          // HTTP error (e.g. 500) — queue the watermark for retry on next sync
          const ts = (event as any)?.getTs?.() ?? (event as any)?.event?.origin_server_ts ?? 0;
          if (ts > 0) pendingReadWatermarks.set(roomId, ts);
        }
        return success;
      } catch (e) {
        console.warn("[chat-store] sendReadReceipt error:", e);
        return false;
      }
    } else {
      pendingReadReceipts.set(roomId, event);
      return false;
    }
  };

  /** Self-heal unread counts by recalculating from watermarks + actual messages.
   *  Called on app resume and after initial sync to fix any accumulated drift. */
  const healUnreadCounts = () => {
    if (!chatDbKitRef.value) return;
    const myAddr = useAuthStore().address;
    if (!myAddr) return;

    const dbKit = chatDbKitRef.value;
    dbKit.rooms.recalculateAllUnreadCounts(
      myAddr,
      (roomId, afterTs, excludeSenderId, clearedAtTs?) =>
        dbKit.messages.countInboundAfter(roomId, afterTs, excludeSenderId, clearedAtTs),
    ).then(corrected => {
      if (corrected > 0) {
        console.log(`[chat-store] self-healed unreadCount for ${corrected} room(s)`);
      }
    }).catch(e => {
      console.warn("[chat-store] healUnreadCounts failed:", e);
    });
  };

  // Listen for visibility changes to send pending read receipts
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && pendingReadReceipts.size > 0) {
        const matrixService = getMatrixClientService();
        for (const [roomId, event] of pendingReadReceipts) {
          matrixService.sendReadReceipt(event).then((success) => {
            if (!success) {
              const ts = (event as any)?.getTs?.() ?? (event as any)?.event?.origin_server_ts ?? 0;
              if (ts > 0) pendingReadWatermarks.set(roomId, ts);
            }
          }).catch(() => {});
        }
        pendingReadReceipts.clear();
      }
    });
  }

  // Capacitor native: resume sync + flush receipts when app returns to foreground.
  // visibilitychange is unreliable in WebView — use Capacitor's appStateChange instead.
  // Without this, WebView suspension causes up to 60s delay before new messages appear.
  if (isNative) {
    import("@capacitor/app").then(({ App }) => {
      App.addListener("appStateChange", ({ isActive }) => {
        if (isActive) {
          // 1. Kick Matrix sync — WebView suspension aborts the pending /sync long-poll,
          //    leaving the SDK in backoff. retryImmediately() bypasses backoff delay.
          try {
            const matrixService = getMatrixClientService();
            if (matrixService.client) {
              matrixService.client.retryImmediately();
            }
          } catch { /* matrix not ready yet */ }

          // 2. Process any room changes that accumulated during background
          refreshRooms();

          // 3. Flush pending read receipts
          flushPendingReadWatermarks();

          // 4. Self-heal unread counts — fix any drift accumulated during suspension
          healUnreadCounts();
        }
      });
    }).catch(() => {});
  }

  /** Find a Matrix event in the room timeline closest to (<=) the given timestamp.
   *  Falls back to the latest event if no exact match found. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const findMatrixEventForTimestamp = (roomId: string, timestamp: number): any | null => {
    try {
      const matrixService = getMatrixClientService();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const matrixRoom = matrixService.getRoom(roomId) as any;
      if (!matrixRoom) return null;

      const events = matrixRoom.getLiveTimeline?.()?.getEvents?.()
                     ?? matrixRoom.timeline
                     ?? [];
      if (events.length === 0) return null;

      // Strategy 1: find event with ts <= timestamp (closest from below)
      for (let i = events.length - 1; i >= 0; i--) {
        const ts = events[i].getTs?.() ?? events[i].event?.origin_server_ts ?? 0;
        if (ts <= timestamp) {
          return events[i];
        }
      }

      // Strategy 2: if all events are newer (rare), use the latest event
      // as fallback — better to send a slightly wrong receipt than none
      return events[events.length - 1];
    } catch {
      return null;
    }
  };

  /** Per-room cooldown for network receipt sends (local Dexie commit is always instant) */
  const RECEIPT_COOLDOWN_MS = 3000;
  const receiptCooldowns = new Map<string, number>();

  /** Atomically commit a read watermark: update Dexie (instant UI) + send
   *  Matrix receipt (server sync) with per-room throttling.
   *  Local commit is always immediate; network send is throttled to max 1/3s per room. */
  const commitReadWatermark = async (roomId: string, timestamp: number) => {
    // 1. LOCAL COMMIT — instant, UI reacts via liveQuery
    if (chatDbKitRef.value) {
      await chatDbKitRef.value.rooms.markAsRead(roomId, timestamp);
    }

    // 2. SERVER SYNC — throttled per room
    const now = Date.now();
    const lastSent = receiptCooldowns.get(roomId) ?? 0;
    if (now - lastSent < RECEIPT_COOLDOWN_MS) {
      // Queue for next flush — don't spam the server
      pendingReadWatermarks.set(roomId, timestamp);
      return;
    }

    const event = findMatrixEventForTimestamp(roomId, timestamp);
    if (event) {
      receiptCooldowns.set(roomId, now);
      const success = await sendReadReceiptIfVisible(roomId, event);
      if (success) {
        pendingReadWatermarks.delete(roomId);
        watermarkQueuedAt.delete(roomId);
      }
    } else {
      pendingReadWatermarks.set(roomId, timestamp);
      if (!watermarkQueuedAt.has(roomId)) watermarkQueuedAt.set(roomId, Date.now());
    }
  };

  /** Retry pending read watermarks — called on sync cycles, throttled globally */
  const WATERMARK_FLUSH_INTERVAL = 5000;
  const STALE_WATERMARK_WARN_MS = 30_000; // warn if a receipt is stuck for >30s
  let lastWatermarkFlush = 0;
  /** Track when each pending watermark was first queued (for staleness warnings) */
  const watermarkQueuedAt = new Map<string, number>();
  const flushPendingReadWatermarks = () => {
    const now = Date.now();
    if (now - lastWatermarkFlush < WATERMARK_FLUSH_INTERVAL) return;
    if (pendingReadWatermarks.size === 0) return;
    lastWatermarkFlush = now;

    // Warn about stale pending receipts
    for (const [roomId] of pendingReadWatermarks) {
      const queuedAt = watermarkQueuedAt.get(roomId);
      if (queuedAt && now - queuedAt > STALE_WATERMARK_WARN_MS) {
        console.warn(`[chat-store] stale read receipt for room ${roomId} — pending for ${Math.round((now - queuedAt) / 1000)}s`);
      } else if (!queuedAt) {
        watermarkQueuedAt.set(roomId, now);
      }
    }

    // Snapshot entries to avoid mutation-during-iteration
    const entries = [...pendingReadWatermarks];
    for (const [roomId, timestamp] of entries) {
      const event = findMatrixEventForTimestamp(roomId, timestamp);
      if (event) {
        receiptCooldowns.set(roomId, now);
        sendReadReceiptIfVisible(roomId, event).then((success) => {
          if (success) {
            pendingReadWatermarks.delete(roomId);
            watermarkQueuedAt.delete(roomId);
          }
        }).catch(() => {});
      }
    }

    // Evict stale cooldown entries to prevent unbounded growth
    const COOLDOWN_EVICT_AGE = 30_000;
    for (const [rid, ts] of receiptCooldowns) {
      if (now - ts > COOLDOWN_EVICT_AGE) receiptCooldowns.delete(rid);
    }
  };

  const setActiveRoom = (roomId: string | null) => {
    perfMark("setActiveRoom-start");
    // Flush buffered background writes before switching rooms.
    // Fire-and-forget: setActiveRoom is synchronous, but flush is best-effort.
    // The liveQuery will pick up any stragglers on the next Dexie notification.
    chatDbKitRef.value?.eventWriter.flushWriteBuffer();
    activeRoomId.value = roomId;
    messageWindowSize.value = 50; // Reset pagination window
    if (roomId) {
      // Load profiles only if not already loaded (removed unconditional delete
      // that caused re-fetching already-cached profiles on every room open)
      if (!profilesRequestedForRooms.has(roomId)) {
        loadProfilesForRoomIds([roomId]);
      }

      // Don't auto-join invited rooms — let the user preview first
      const room = getRoomById(roomId);
      if (room?.membership === "invite") return;

      // Lazy load members on demand — rooms outside viewport didn't load
      // members at startup, so load them now when user actually opens the room
      try {
        const matrixService = getMatrixClientService();
        const matrixRoom = matrixService.getRoom(roomId);
        if (matrixRoom && typeof (matrixRoom as any).loadMembersIfNeeded === "function") {
          (matrixRoom as any).loadMembersIfNeeded().then(() => {
            // After members load, ensure profiles are fetched for new members
            if (!profilesRequestedForRooms.has(roomId)) {
              loadProfilesForRoomIds([roomId]);
            }
          }).catch(() => {});
        }
      } catch {
        // Matrix service not ready yet — members will load on next sync
      }

      // Bootstrap clearedAtTs from Matrix account_data (cross-device sync)
      if (chatDbKitRef.value) {
        try {
          const matrixService = getMatrixClientService();
          const data = matrixService.getRoomAccountData(roomId, "m.bastyon.clear_history");
          if (data?.cleared_at_ts && typeof data.cleared_at_ts === "number") {
            const existingTs = chatDbKitRef.value.eventWriter.getClearedAtTs(roomId);
            if (!existingTs || data.cleared_at_ts > existingTs) {
              chatDbKitRef.value.eventWriter.setClearedAtTs(roomId, data.cleared_at_ts as number);
              // Fire-and-forget: purge stale messages in background
              (async () => {
                try {
                  const localRoom = await chatDbKitRef.value!.rooms.getRoom(roomId);
                  if (!localRoom?.clearedAtTs || localRoom.clearedAtTs < (data.cleared_at_ts as number)) {
                    await chatDbKitRef.value!.rooms.clearHistory(roomId, data.cleared_at_ts as number);
                    await chatDbKitRef.value!.messages.purgeBeforeTimestamp(roomId, data.cleared_at_ts as number);
                  }
                } catch (e) {
                  console.warn("[chat-store] Failed to bootstrap clearedAtTs:", e);
                }
              })();
            }
          }
        } catch {
          // Matrix service not ready yet — will sync via Room.accountData event later
        }
      }

      // Self-healing: check if we still have access to this room via Matrix SDK.
      // If the room was left/forgotten on another device but our local Dexie
      // cache still has it, tombstone it and clear the active room.
      // Guard: only run AFTER initial sync completes. Before that, SDK doesn't
      // have rooms loaded yet, so getRoom() returns null for valid rooms —
      // causing false-positive tombstoning that removes the room from the list.
      if (roomsInitialized.value) {
        selfHealZombieRoom(roomId);
      }

      // NOTE: Do NOT mark as read here. Reading happens incrementally
      // via IntersectionObserver in MessageList as user scrolls.
    }
    perfMark("setActiveRoom-end");
    perfMeasure("setActiveRoom", "setActiveRoom-start", "setActiveRoom-end");
  };

  /** Self-healing: detect zombie rooms (left on another device but still in local cache)
   *  and tombstone them. Called when user tries to open a room. */
  const selfHealZombieRoom = (roomId: string) => {
    try {
      const matrixService = getMatrixClientService();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const matrixRoom = matrixService.getRoom(roomId) as any;

      // Room doesn't exist in Matrix SDK at all — definitely a zombie
      if (!matrixRoom) {
        console.warn("[chat-store] selfHeal: room not found in Matrix SDK, tombstoning", roomId);
        tombstoneAndRedirect(roomId, "removed");
        return;
      }

      // Room exists but membership is not "join" or "invite" — zombie
      const membership = matrixRoom.selfMembership ?? matrixRoom.getMyMembership?.();
      if (membership !== "join" && membership !== "invite") {
        console.warn("[chat-store] selfHeal: membership is", membership, "— tombstoning", roomId);
        const reason = membership === "ban" ? "banned" as const : "left" as const;
        tombstoneAndRedirect(roomId, reason);
        return;
      }
    } catch {
      // Matrix service not ready — skip self-healing, will catch on next interaction
    }
  };

  /** Tombstone a zombie room in Dexie, clear active room, and remove from UI */
  const tombstoneAndRedirect = (roomId: string, reason: "left" | "kicked" | "banned" | "removed") => {
    if (chatDbKitRef.value) {
      chatDbKitRef.value.rooms.tombstoneRoom(roomId, reason).catch((e: unknown) => {
        console.warn("[chat-store] tombstoneAndRedirect failed:", e);
      });
    }
    optimisticRemoveRoom(roomId);
  };

  /** Coalescing state for advanceInboundWatermark — reduces Dexie writes during fast scroll.
   *  Instead of writing every 2s batch immediately, waits 100ms to merge rapid bursts. */
  let watermarkCoalesceTimer: ReturnType<typeof setTimeout> | null = null;
  let watermarkCoalesceRoomId: string | null = null;
  let watermarkCoalesceTs = 0;

  /** Advance the inbound read watermark (called by read tracker on batch flush).
   *  Coalesces rapid updates: waits 100ms before committing to Dexie + Matrix,
   *  so fast scrolling through 100 messages produces ~1 write instead of many. */
  const advanceInboundWatermark = async (roomId: string, timestamp: number) => {
    // Room changed — flush previous immediately
    if (watermarkCoalesceRoomId && watermarkCoalesceRoomId !== roomId) {
      if (watermarkCoalesceTimer !== null) {
        clearTimeout(watermarkCoalesceTimer);
        watermarkCoalesceTimer = null;
      }
      const prevRoom = watermarkCoalesceRoomId;
      const prevTs = watermarkCoalesceTs;
      watermarkCoalesceRoomId = null;
      watermarkCoalesceTs = 0;
      commitReadWatermark(prevRoom, prevTs).catch(() => {});
    }

    watermarkCoalesceRoomId = roomId;
    watermarkCoalesceTs = Math.max(watermarkCoalesceTs, timestamp);

    if (watermarkCoalesceTimer !== null) return; // already scheduled

    watermarkCoalesceTimer = setTimeout(async () => {
      watermarkCoalesceTimer = null;
      const coalescedRoom = watermarkCoalesceRoomId;
      const coalescedTs = watermarkCoalesceTs;
      watermarkCoalesceRoomId = null;
      watermarkCoalesceTs = 0;
      if (coalescedRoom && coalescedTs > 0) {
        await commitReadWatermark(coalescedRoom, coalescedTs);
      }
    }, 100);
  };

  /** Expand the message window for scroll-up pagination.
   *  Default 25 matches prefetchNextBatch size — smaller batches = less re-render work. */
  const expandMessageWindow = (amount = 25) => {
    messageWindowSize.value += amount;
  };

  /** Accept an invite: join the room and update membership */
  const acceptInvite = async (roomId: string) => {
    try {
      const matrixService = getMatrixClientService();
      // Security (best-effort): block join if local state shows user is banned.
      // Authoritative enforcement is server-side; this avoids a wasted network call.
      const myUserId = matrixService.getUserId() ?? "";
      if (isUserBanned(roomId, myUserId)) {
        console.warn("[chat-store] acceptInvite blocked: user is banned from room", roomId);
        return;
      }
      await matrixService.joinRoom(roomId);

      // Update local membership to "join" and trigger Vue reactivity.
      // rooms is a shallowRef and activeRoom computed returns the room object
      // by reference. In-place mutation (room.membership = "join") wouldn't
      // propagate: activeRoom would return the same reference, Vue would see
      // no change (Object.is), and isInvite would stay stale.
      // Fix: replace with a shallow copy so activeRoom returns a new reference.
      const room = getRoomById(roomId);
      if (room) {
        const updated = { ...room, membership: "join" as const };
        const idx = rooms.value.indexOf(room);
        if (idx !== -1) rooms.value[idx] = updated;
        roomsMap.set(roomId, updated);
      }
      triggerRef(rooms);

      // Mark room as changed so the debounced refresh picks it up for Dexie sync
      markRoomChanged(roomId);
      refreshRooms();

      // Force reload active room data — activeRoomId didn't change so watchers
      // won't fire. Re-calling setActiveRoom triggers profile/member loading
      // and clears the invite preview.
      if (activeRoomId.value === roomId) {
        profilesRequestedForRooms.delete(roomId);
        setActiveRoom(roomId);
      }
    } catch (e) {
      console.warn("[chat-store] acceptInvite error:", e);
    }
  };

  /** Decline an invite: leave the room and remove from list */
  const declineInvite = async (roomId: string) => {
    // Tombstone in Dexie (cross-device visible)
    if (chatDbKitRef.value) {
      await chatDbKitRef.value.rooms.tombstoneRoom(roomId, "left");
    }

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

  /** Count of rooms with pending invitations.
   *  Reads from sortedRooms (Dexie-backed) to stay in sync with the displayed list. */
  const inviteCount = computed(() =>
    sortedRooms.value.filter((r) => r.membership === "invite").length
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

  /** Helper: optimistically remove a room from runtime UI state */
  const optimisticRemoveRoom = (roomId: string) => {
    rooms.value = rooms.value.filter((r) => r.id !== roomId);
    roomsMap.delete(roomId);
    delete messages.value[roomId];
    triggerRef(messages);
    if (activeRoomId.value === roomId) {
      activeRoomId.value = null;
    }
  };

  /** Remove a room: kick other members → leave → forget → remove from local state.
   *  Kicks all other joined members so the chat disappears for everyone (both 1:1 and groups). */
  const removeRoom = async (roomId: string) => {
    // Tombstone in Dexie — cross-device visible, survives reload
    if (chatDbKitRef.value) {
      await chatDbKitRef.value.rooms.tombstoneRoom(roomId, "removed");
    }

    // Optimistic: remove from UI immediately
    optimisticRemoveRoom(roomId);

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
                // Security: reset power level before kick
                await resetPowerLevel(roomId, memberId);
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

  /** Clear chat history for current user only. Room membership is NOT affected.
   *  1. Save marker to Matrix room account_data (cross-device sync)
   *  2. Save marker to Dexie LocalRoom.clearedAtTs
   *  3. Purge old timeline events from Dexie
   *  4. Reset room preview and pagination state
   *  5. Clear in-memory messages */
  const clearHistory = async (roomId: string) => {
    const now = Date.now();

    // 1. Save marker to Matrix account_data (cross-device)
    try {
      const matrixService = getMatrixClientService();
      await matrixService.setRoomAccountData(roomId, "m.bastyon.clear_history", {
        cleared_at_ts: now,
      });
    } catch (e) {
      console.warn("[chat-store] clearHistory: failed to set account_data, continuing with local-only clear:", e);
    }

    // 2-4. Dexie: set marker + purge messages + reset preview/pagination
    if (chatDbKitRef.value) {
      chatDbKitRef.value.eventWriter.setClearedAtTs(roomId, now);
      await chatDbKitRef.value.rooms.clearHistory(roomId, now);
      await chatDbKitRef.value.messages.purgeBeforeTimestamp(roomId, now);
    }

    // 5. Invalidate caches so room list rebuilds from fresh Dexie data
    decryptedPreviewCache.delete(roomId);
    _chatRoomFromDexieCache.delete(roomId);

    // 6. Clear in-memory messages for this room
    messages.value[roomId] = [];
    triggerRef(messages);

    // Reset message window so liveQuery re-fires with empty result
    if (activeRoomId.value === roomId) {
      messageWindowSize.value = 50;
    }
  };

  /** Leave a group chat without kicking other members. */
  const leaveGroup = async (roomId: string) => {
    // Tombstone in Dexie — cross-device visible
    if (chatDbKitRef.value) {
      await chatDbKitRef.value.rooms.tombstoneRoom(roomId, "left");
    }

    // Optimistic: remove from UI
    optimisticRemoveRoom(roomId);

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
      // Security: reset power level before kick to prevent resurrection with elevated PL
      await resetPowerLevel(roomId, targetMatrixId);
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
      // Security: reset power level before ban
      await resetPowerLevel(roomId, targetMatrixId);
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
      // Security: don't invite banned users
      if (isUserBanned(roomId, targetMatrixId)) {
        console.warn("[chat-store] inviteMember blocked: target is banned from room", roomId);
        return false;
      }
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
      // Security (best-effort): block join if local state shows user is banned.
      // Authoritative enforcement is server-side; this avoids a wasted network call.
      const myUserId = matrixService.getUserId() ?? "";
      if (isUserBanned(roomId, myUserId)) {
        console.warn("[chat-store] joinRoomById blocked: user is banned from room", roomId);
        return false;
      }
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

    // Stamp a stable render key that never changes — used by DynamicScroller's
    // key-field so that updateMessageId (tempId→serverId) doesn't cause
    // an unmount/remount blink.
    if (!(message as any)._key) (message as any)._key = message.id;

    // Replace the array reference (not push) so activeMessages computed returns
    // a new reference and Vue triggers watchers (scrollToBottom, etc.).
    // With shallowRef + no-spread in activeMessages, in-place push wouldn't
    // change the reference and watchers wouldn't fire.
    messages.value[roomId] = [...messages.value[roomId], message];
    triggerRef(messages);

    // Update room's last message and timestamp
    const room = getRoomById(roomId);
    if (room) {
      room.lastMessage = message;
      room.updatedAt = message.timestamp;
      if (roomId !== activeRoomId.value && message.senderId !== useAuthStore().address) {
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
    const existing = messages.value[roomId];
    if (existing?.length && msgs.length) {
      // Smart merge: reuse existing message objects to minimize Vue re-renders.
      // DynamicScroller keeps height cache per item — reusing objects avoids full remount.
      const existingMap = new Map(existing.map(m => [m.id, m]));
      const merged: Message[] = [];
      const mergedIds = new Set<string>();
      for (const msg of msgs) {
        const prev = existingMap.get(msg.id);
        if (prev) {
          // Update in-place so Vue only patches changed properties
          Object.assign(prev, msg);
          merged.push(prev);
        } else {
          merged.push(msg);
        }
        mergedIds.add(msg.id);
      }
      // Preserve optimistic messages (tempId, status=sending/failed) that haven't
      // been confirmed by the server yet — they'd be dropped by the merge otherwise.
      for (const msg of existing) {
        if (!mergedIds.has(msg.id) && (msg.status === MessageStatus.sending || msg.status === MessageStatus.failed)) {
          merged.push(msg);
        }
      }
      messages.value[roomId] = merged;
    } else {
      messages.value[roomId] = msgs;
    }
    triggerRef(messages);

    // Sync sidebar: update room.lastMessage status from loaded messages
    if (msgs.length > 0) {
      const room = getRoomById(roomId);
      if (room) {
        const lastMsg = msgs[msgs.length - 1];
        // Always sync lastMessage so sidebar reflects correct read/sent status
        if (!room.lastMessage || room.lastMessage.id === lastMsg.id || lastMsg.timestamp >= (room.lastMessage.timestamp || 0)) {
          room.lastMessage = { ...lastMsg };
          triggerRef(rooms);
        }
      }
    }
  };

  /** Enter detached mode: replace active messages with a context window around a target message. */
  const enterDetachedMode = (roomId: string, msgs: Message[]) => {
    messages.value[roomId] = msgs;
    triggerRef(messages);
    isDetachedFromLatest.value = true;
  };

  /** Exit detached mode: reload the room's latest messages and scroll to bottom. */
  const exitDetachedMode = async (roomId: string) => {
    isDetachedFromLatest.value = false;
    await loadRoomMessages(roomId, { waitForSdk: true });
  };

  /** Replace a temporary message ID with the server-assigned event_id */
  const updateMessageId = (roomId: string, tempId: string, serverId: string) => {
    const roomMessages = messages.value[roomId];
    if (roomMessages) {
      const idx = roomMessages.findIndex((m) => m.id === tempId);
      if (idx >= 0) {
        const msg = roomMessages[idx];
        // Create a new object so Vue detects the prop change.
        // _key stays as tempId so DynamicScroller doesn't unmount/remount.
        const updated = { ...msg, id: serverId };
        const newArray = [...roomMessages];
        newArray[idx] = updated;
        messages.value[roomId] = newArray;
        triggerRef(messages);

        // Sync sidebar: update room.lastMessage if this was the last message
        const room = getRoomById(roomId);
        if (room?.lastMessage && room.lastMessage.id === tempId) {
          room.lastMessage = { ...updated };
          triggerRef(rooms);
        }
      }
    }
  };

  /** Atomically update both message id AND status in a single array replacement.
   *  Avoids two consecutive array copies + two triggerRef calls that would cause
   *  DynamicScroller to process two separate item updates (potential blink). */
  const updateMessageIdAndStatus = (
    roomId: string,
    tempId: string,
    serverId: string,
    status: Message["status"]
  ) => {
    const roomMessages = messages.value[roomId];
    if (!roomMessages) return;
    const idx = roomMessages.findIndex((m) => m.id === tempId);
    if (idx < 0) return;
    const msg = roomMessages[idx];
    const updated = { ...msg, id: serverId, status };
    const newArray = [...roomMessages];
    newArray[idx] = updated;
    messages.value[roomId] = newArray;
    triggerRef(messages);

    const room = getRoomById(roomId);
    if (room?.lastMessage && (room.lastMessage.id === tempId || room.lastMessage.id === serverId)) {
      room.lastMessage = { ...updated };
      triggerRef(rooms);
    }
  };

  const updateMessageStatus = (
    roomId: string,
    messageId: string,
    status: Message["status"]
  ) => {
    const roomMessages = messages.value[roomId];
    if (roomMessages) {
      const idx = roomMessages.findIndex((m) => m.id === messageId);
      if (idx >= 0) {
        const msg = roomMessages[idx];
        if (msg.status === status) return; // no change
        // Create a new object so Vue detects the prop change and re-renders
        // MessageBubble (in-place mutation of the same reference is invisible to Vue).
        const updated = { ...msg, status };
        const newArray = [...roomMessages];
        newArray[idx] = updated;
        messages.value[roomId] = newArray;
        triggerRef(messages);

        // Sync sidebar: update room.lastMessage if this message is the last one
        const room = getRoomById(roomId);
        if (room?.lastMessage && room.lastMessage.id === messageId) {
          room.lastMessage = { ...updated };
          triggerRef(rooms);
        }
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

        // Sync sidebar: update room.lastMessage if this was the last message
        const room = getRoomById(roomId);
        if (room?.lastMessage && room.lastMessage.id === messageId) {
          room.lastMessage = { ...msg };
          triggerRef(rooms);
        }
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

    let templateKey = "";
    let targetAddr: string | undefined;
    let extraMeta: Record<string, string> | undefined;

    if (eventType === "m.room.member") {
      const membership = content.membership as string;
      const stateKey = raw.state_key as string | undefined;
      targetAddr = stateKey ? matrixIdToAddress(stateKey) : sender;
      const isSelf = targetAddr === sender;

      if (membership === "join") {
        templateKey = isSelf ? "system.joined" : "system.added";
      } else if (membership === "leave") {
        templateKey = isSelf ? "system.left" : "system.removed";
      } else if (membership === "ban") {
        templateKey = "system.banned";
      } else if (membership === "invite") {
        templateKey = "system.invited";
      } else {
        return null;
      }
    } else if (eventType === "m.room.name") {
      const newName = (content.name as string) || "";
      const isHash = /^#?[0-9a-f]{20,}$/i.test(newName);
      if (isHash || !newName) {
        templateKey = "system.updatedRoom";
      } else {
        templateKey = "system.changedName";
        extraMeta = { name: newName };
      }
    } else if (eventType === "m.room.power_levels") {
      templateKey = "system.changedPermissions";
    } else if (eventType === "m.room.avatar") {
      templateKey = "system.changedPhoto";
    } else if (eventType === "m.room.topic") {
      const newTopic = (content.topic as string) || "";
      templateKey = newTopic ? "system.setDescription" : "system.clearedDescription";
    } else if (eventType === "m.room.pinned_events") {
      templateKey = "system.pinnedMessage";
    } else {
      return null;
    }

    // content stores a snapshot for Dexie preview (English fallback);
    // the real display text is resolved at render time via systemMeta.template + i18n
    const senderName = getDisplayName(sender) || sender.slice(0, 8) + "...";
    const targetName = targetAddr && targetAddr !== sender
      ? (getDisplayName(targetAddr) || targetAddr.slice(0, 8) + "...")
      : senderName;
    const fallbackText = templateKey
      .replace("system.", "")
      .replace(/([A-Z])/g, " $1")
      .toLowerCase();
    const snapshotText = cleanMatrixIds(
      `${senderName} ${fallbackText}${targetAddr && targetAddr !== sender ? ` ${targetName}` : ""}`,
    );

    return {
      id: raw.event_id as string,
      roomId,
      senderId: sender,
      content: snapshotText,
      timestamp: (raw.origin_server_ts as number) ?? 0,
      status: MessageStatus.sent,
      type: MessageType.system,
      systemMeta: {
        template: templateKey,
        senderAddr: sender,
        targetAddr: targetAddr !== sender ? targetAddr : undefined,
        ...extraMeta && { extra: extraMeta },
      },
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
      let callTemplateKey: string;
      if (reason === "invite_timeout") {
        callTemplateKey = isVideo ? "system.missedVideoCall" : "system.missedVoiceCall";
      } else {
        callTemplateKey = isVideo ? "system.videoCall" : "system.voiceCall";
      }
      return {
        id: raw.event_id as string,
        roomId,
        senderId: sender,
        content: "",
        timestamp: (raw.origin_server_ts as number) ?? 0,
        status: MessageStatus.sent,
        type: MessageType.system,
        callInfo: { callType: isVideo ? "video" : "voice", missed: reason === "invite_timeout", duration: Math.round(durationMs / 1000) },
        systemMeta: { template: callTemplateKey, senderAddr: sender },
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
        body = "[encrypted]";
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
        else if (mtype === "m.video") msgType = fileInfo.videoNote ? MessageType.videoCircle : MessageType.video;
        else msgType = messageTypeFromMime(fileInfo.type);
        body = fileInfo.name;
      } else {
        if (mtype === "m.image") msgType = MessageType.image;
        else if (mtype === "m.audio") msgType = MessageType.audio;
        else if (mtype === "m.video") msgType = MessageType.video;
        else msgType = MessageType.file;
      }
    }

    // Parse reply reference — supports both:
    // 1. Standard Matrix: m.relates_to.m.in_reply_to.event_id
    // 2. Old bastyon-chat: m.relates_to.rel_type === "m.reference" + m.relates_to.event_id
    let replyTo: ReplyTo | undefined;
    const relatesTo = content["m.relates_to"] as Record<string, unknown> | undefined;
    const inReplyTo = relatesTo?.["m.in_reply_to"] as Record<string, unknown> | undefined;
    if (inReplyTo?.event_id) {
      replyTo = {
        id: inReplyTo.event_id as string,
        senderId: "",
        content: "",
      };
    } else if (relatesTo?.rel_type === "m.reference" && relatesTo?.event_id) {
      // Old bastyon-chat reply format (backwards compatibility)
      replyTo = {
        id: relatesTo.event_id as string,
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

    // Extract link preview from event content
    let linkPreview: LinkPreview | undefined;
    const urlPreview = content.url_preview as Record<string, unknown> | undefined;
    if (urlPreview?.url) {
      linkPreview = {
        url: urlPreview.url as string,
        siteName: urlPreview.site_name as string | undefined,
        title: urlPreview.title as string | undefined,
        description: urlPreview.description as string | undefined,
        imageUrl: urlPreview.image_url as string | undefined,
        imageWidth: urlPreview.image_width as number | undefined,
        imageHeight: urlPreview.image_height as number | undefined,
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
      linkPreview,
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

    const msgs = results.filter((m): m is Message => m !== null && (m.content !== "" || m.deleted === true || m.type === MessageType.system));

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
            editBody = "[encrypted]";
          }
        } else {
          editBody = (newContent?.body as string) ?? (content.body as string) ?? "";
        }

        target.content = editBody.replace(/^\* /, "");
        target.edited = true;

        // Persist edit to Dexie so it survives reload
        await chatDbKitRef.value?.eventWriter.writeEdit(roomId, {
          targetEventId: targetId,
          newContent: target.content,
          editTs: typeof raw.origin_server_ts === "number" ? raw.origin_server_ts : undefined,
        });
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
    const unresolvedReplyMsgs: Message[] = [];
    for (const msg of msgs) {
      if (msg.replyTo?.id) {
        const referenced = msgMap.get(msg.replyTo.id);
        if (referenced) {
          msg.replyTo.senderId = referenced.senderId;
          msg.replyTo.content = stripBastyonLinks(stripMentionAddresses(referenced.content)).slice(0, 100);
          msg.replyTo.type = referenced.type;
          if (referenced.deleted) msg.replyTo.deleted = true;
        } else {
          unresolvedReplyMsgs.push(msg);
        }
      }
    }

    // Fallback: resolve unresolved reply references from Dexie (single batched query)
    if (unresolvedReplyMsgs.length > 0 && chatDbKitRef.value) {
      const db = chatDbKitRef.value;
      const unresolvedIds = unresolvedReplyMsgs.map(m => m.replyTo!.id);
      const storedMsgs = await db.messages.getByEventIds(unresolvedIds);
      const storedMap = new Map(storedMsgs.map(m => [m.eventId!, m]));
      for (const msg of unresolvedReplyMsgs) {
        const replyTo = msg.replyTo!;
        const stored = storedMap.get(replyTo.id);
        if (stored) {
          if (stored.deleted || stored.softDeleted) {
            replyTo.deleted = true;
          } else {
            replyTo.senderId = stored.senderId;
            replyTo.content = stripBastyonLinks(stripMentionAddresses(stored.content)).slice(0, 100);
            replyTo.type = stored.type;
          }
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
   *  from a non-self user, and seeds the outbound watermark in Dexie.
   *  Also updates in-memory message statuses for the fallback path. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const applyExistingReceipts = (matrixRoom: any, timelineEvents: unknown[], msgs: Message[], myUserId: string | null) => {
    if (!myUserId || msgs.length === 0) return;
    try {
      const myAddr = matrixIdToAddress(myUserId);
      const roomId = (matrixRoom.roomId ?? matrixRoom.room_id) as string;

      // Find the latest event that has a read receipt from a non-self user
      let readUpToEventId: string | null = null;
      let readUpToTimestamp = 0;
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
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          readUpToTimestamp = (ev as any)?.getTs?.() ?? (ev as any)?.event?.origin_server_ts ?? 0;
          break;
        }
      }
      if (!readUpToEventId) return;

      // Seed outbound watermark in Dexie — this is the key fix for initial load
      if (chatDbKitRef.value && roomId && readUpToTimestamp > 0) {
        chatDbKitRef.value.rooms.updateOutboundWatermark(roomId, readUpToTimestamp).catch(() => {});
      }

      // Also update in-memory message statuses (for non-Dexie fallback path)
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

  /**
   * Enrich unresolved reply previews for in-memory messages.
   * Finds messages with empty replyTo (senderId="", not deleted) and tries
   * to fill them from Dexie. If found, updates in-memory state + triggers reactivity.
   * Called after initial load and loadMore to handle cross-batch references.
   */
  const enrichUnresolvedReplies = async (roomId: string): Promise<void> => {
    if (!chatDbKitRef.value) return;
    const db = chatDbKitRef.value;

    // Step 1: Find unresolved replies in Dexie (source of truth for UI)
    const clearedAtTs = db.eventWriter.getClearedAtTs(roomId);
    const roomMsgs = await db.messages.getMessages(roomId, 200, undefined, clearedAtTs);
    const unresolved = roomMsgs.filter(
      m => m.replyTo && !m.replyTo.deleted && !m.replyTo.senderId && !m.replyTo.content,
    );
    if (unresolved.length === 0) return;

    // Step 2: Look up referenced messages from Dexie
    const ids = unresolved.map(m => m.replyTo!.id);
    const stored = await db.messages.getByEventIds(ids);
    const storedMap = new Map(stored.map(m => [m.eventId!, m]));

    // Step 3: For IDs not found in Dexie, fetch from Matrix server
    const missingIds = ids.filter(id => !storedMap.has(id));
    if (missingIds.length > 0) {
      try {
        const matrixService = getMatrixClientService();
        if (matrixService.client) {
          const roomCrypto = await ensureRoomCrypto(roomId);
          // Fetch missing events in parallel (capped at 10 to avoid flooding)
          const fetches = missingIds.slice(0, 10).map(async (eventId) => {
            try {
              const raw = await matrixService.client!.fetchRoomEvent(roomId, eventId);
              if (!raw) return;

              let body = "";
              let senderId = "";
              let msgType = MessageType.text;
              const content = raw.content as Record<string, unknown> | undefined;

              senderId = matrixIdToAddress((raw.sender as string) ?? "");

              // Decrypt if needed
              if (content?.msgtype === "m.encrypted" && roomCrypto) {
                try {
                  const decrypted = await roomCrypto.decryptEvent(raw as Record<string, unknown>);
                  body = decrypted.body ?? "";
                } catch {
                  body = "";
                }
              } else {
                body = (content?.body as string) ?? "";
              }

              // Detect message type
              const mtype = content?.msgtype as string;
              if (mtype === "m.image") msgType = MessageType.image;
              else if (mtype === "m.audio") msgType = MessageType.audio;
              else if (mtype === "m.video") msgType = MessageType.video;
              else if (mtype === "m.file") msgType = MessageType.file;

              if (senderId) {
                storedMap.set(eventId, {
                  eventId,
                  senderId,
                  content: body,
                  type: msgType,
                } as import("@/shared/lib/local-db/schema").LocalMessage);
              }
            } catch {
              // Server fetch failed for this event — skip
            }
          });
          await Promise.all(fetches);
        }
      } catch {
        // Matrix service not available — continue with what we have
      }
    }

    // Step 4: Build patches for resolved replies
    const patches: { eventId: string; replyTo: import("./types").ReplyTo }[] = [];
    for (const msg of unresolved) {
      const replyTo = msg.replyTo!;
      const original = storedMap.get(replyTo.id);
      if (original && msg.eventId) {
        if (original.deleted || original.softDeleted) {
          patches.push({
            eventId: msg.eventId,
            replyTo: { id: replyTo.id, senderId: "", content: "", deleted: true },
          });
        } else {
          patches.push({
            eventId: msg.eventId,
            replyTo: {
              id: replyTo.id,
              senderId: original.senderId,
              content: stripBastyonLinks(stripMentionAddresses(original.content)).slice(0, 100),
              type: original.type,
            },
          });
        }
      }
    }

    // Step 5: Patch Dexie — liveQuery auto-propagates to UI
    if (patches.length > 0) {
      await db.messages.patchUnresolvedReplies(patches);
    }

    // Step 6: Also update in-memory store for non-Dexie consumers
    const inMemMsgs = messages.value[roomId];
    if (inMemMsgs) {
      let changed = false;
      for (const patch of patches) {
        const msg = inMemMsgs.find(m => m.id === patch.eventId);
        if (msg && msg.replyTo) {
          msg.replyTo.senderId = patch.replyTo.senderId;
          msg.replyTo.content = patch.replyTo.content;
          msg.replyTo.type = patch.replyTo.type;
          if (patch.replyTo.deleted) msg.replyTo.deleted = true;
          changed = true;
        }
      }
      if (changed) triggerRef(messages);
    }
  };

  /** Load timeline events for a room and convert to Messages */
  const loadRoomMessages = async (roomId: string, { waitForSdk = false } = {}) => {
    try {
      // Capture whether this room is the active room RIGHT NOW.
      // The activeRoomId early-exit optimization only applies when the user
      // navigated TO this room and then switched away (stale scrollback).
      // Viewport-fetch rooms are never the active room — they must not bail.
      const wasActiveRoom = activeRoomId.value === roomId;

      const matrixService = getMatrixClientService();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let matrixRoom = matrixService.getRoom(roomId) as any;

      // When called from MessageList (user opened a room), SDK may still be
      // processing the sync — wait briefly. Background preloads should NOT wait.
      if (!matrixRoom && waitForSdk) {
        for (let attempt = 0; attempt < 5 && !matrixRoom; attempt++) {
          await new Promise(r => setTimeout(r, 600));
          matrixRoom = matrixService.getRoom(roomId) as any;
        }
      }
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
        // Brief yield if timeline is empty — sync may not have populated it yet
        if (timelineEvents.length === 0) {
          await new Promise(r => setTimeout(r, 300));
          timelineEvents = getTimelineEvents(matrixRoom);
          msgCount = countMessages(timelineEvents);
        }

        // Keep scrolling back until we have enough messages or hit the beginning.
        // Check activeRoomId between iterations — if user switched rooms, bail
        // early to avoid piling up stale scrollback/crypto work.
        // Only applies when the room WAS active (user opened it, then navigated away).
        // Viewport-fetch rooms were never active — they must complete to provide previews.
        for (let attempt = 0; attempt < MAX_SCROLLBACK_ATTEMPTS && msgCount < MIN_MESSAGES; attempt++) {
          if (wasActiveRoom && activeRoomId.value !== roomId) return;
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

      // Bail if user already switched to another room — no point parsing/writing
      // stale data that will saturate Dexie transactions and block the active room.
      // Only applies when the room WAS active (viewport-fetch rooms were never active).
      if (wasActiveRoom && activeRoomId.value !== roomId) return;

      const msgs = await parseTimelineEvents(timelineEvents, roomId);

      // Apply existing read receipts to determine message status.
      // Walk timeline backwards, find the latest read receipt from a non-self user,
      // and mark all own messages up to that point as "read".
      applyExistingReceipts(matrixRoom, timelineEvents, msgs, matrixService.getUserId());

      // Filter out messages before the clear-history marker so they never
      // pollute messages.value (used as a lastMessage candidate in buildChatRoom).
      const clearedAtTs = chatDbKitRef.value?.eventWriter.getClearedAtTs(roomId);
      const filteredMsgs = clearedAtTs ? msgs.filter(m => m.timestamp > clearedAtTs) : msgs;
      setMessages(roomId, filteredMsgs);

      // Dual-write: persist all parsed messages to Dexie.
      // For the active room: awaited so data reaches IndexedDB before a potential F5.
      // For stale rooms (user switched away): fire-and-forget to avoid blocking
      // Dexie transactions that the active room needs.
      const isActiveRoom = activeRoomId.value === roomId;
      if (chatDbKitRef.value && msgs.length > 0) {
        const parsedMessages: ParsedMessage[] = msgs
          .filter(m => m.id && !m.id.startsWith("msg_")) // Skip optimistic temp messages
          .map(m => ({
            eventId: m.id,
            roomId: m.roomId,
            senderId: m.senderId,
            content: m.content,
            timestamp: m.timestamp,
            type: m.type,
            fileInfo: m.fileInfo,
            replyTo: m.replyTo,
            forwardedFrom: m.forwardedFrom,
            callInfo: m.callInfo,
            pollInfo: m.pollInfo,
            transferInfo: m.transferInfo,
            linkPreview: m.linkPreview,
            deleted: m.deleted,
            systemMeta: m.systemMeta,
            reactions: m.reactions,
          }));
        const dexieWriteWork = async () => {
          await chatDbKitRef.value!.eventWriter.writeMessages(parsedMessages);

          // Patch Dexie records where parseTimelineEvents resolved a reply
          // but bulkInsert skipped the message (already existed with empty replyTo).
          const resolvedReplies = parsedMessages
            .filter(m => m.replyTo?.senderId && m.eventId)
            .map(m => ({ eventId: m.eventId!, replyTo: m.replyTo! }));
          if (resolvedReplies.length > 0) {
            await chatDbKitRef.value!.messages.patchUnresolvedReplies(resolvedReplies);
          }

          // Also try to resolve any remaining unresolved replies from Dexie
          await enrichUnresolvedReplies(roomId);

          // Sync reactions to Dexie for messages that already existed (bulkInsert skips duplicates).
          // This ensures Dexie has up-to-date reactions from the timeline.
          const dbKit = chatDbKitRef.value!;
          for (const m of msgs) {
            if (m.reactions && Object.keys(m.reactions).length > 0 && m.id && !m.id.startsWith("msg_")) {
              dbKit.messages.updateReactions(m.id, m.reactions).catch(() => {});
            }
          }
        };

        if (isActiveRoom) {
          // Active room: await so data is persisted before user can F5
          try {
            await dexieWriteWork();
          } catch (e) {
            console.warn("[chat-store] EventWriter.writeMessages failed:", e);
          }
        } else {
          // Stale room: fire-and-forget to unblock Dexie for the active room
          dexieWriteWork().catch(e => {
            console.warn("[chat-store] EventWriter.writeMessages (background) failed:", e);
          });
        }
      }

      // Load server-synced pinned messages after messages are available
      if (roomId === activeRoomId.value) {
        await loadPinnedMessages(roomId);
      }

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

      // Dual-write: persist scrollback messages to Dexie so that
      // expandMessageWindow() can serve older messages from local cache
      // without a network round-trip (Telegram-like instant history).
      if (chatDbKitRef.value && msgs.length > 0) {
        const parsedMessages: ParsedMessage[] = msgs
          .filter(m => m.id && !m.id.startsWith("msg_"))
          .map(m => ({
            eventId: m.id,
            roomId: m.roomId,
            senderId: m.senderId,
            content: m.content,
            timestamp: m.timestamp,
            type: m.type,
            fileInfo: m.fileInfo,
            replyTo: m.replyTo,
            forwardedFrom: m.forwardedFrom,
            callInfo: m.callInfo,
            pollInfo: m.pollInfo,
            transferInfo: m.transferInfo,
            linkPreview: m.linkPreview,
            deleted: m.deleted,
            systemMeta: m.systemMeta,
            reactions: m.reactions,
          }));
        chatDbKitRef.value.eventWriter.writeMessages(parsedMessages).catch(e => {
          console.warn("[chat-store] loadMoreMessages Dexie write failed:", e);
        });
      }

      // Enrich any still-unresolved reply previews from Dexie (non-blocking)
      enrichUnresolvedReplies(roomId).catch(() => {});

      return true;
    } catch (e) {
      console.error("[chat-store] loadMoreMessages error:", e);
      return false;
    }
  };

  /** Prefetch one batch of older messages into Dexie (background, no UI).
   *  Calls Matrix scrollback once (25 messages), writes to IndexedDB only.
   *  Does NOT touch any reactive UI state — data sits silently in Dexie
   *  until expandMessageWindow() reads it on scroll-up.
   *  Returns true if there are more messages to fetch. */
  let prefetchInFlight = false;
  const prefetchNextBatch = async (roomId: string): Promise<boolean> => {
    if (prefetchInFlight) return true;
    prefetchInFlight = true;
    try {
      const matrixService = getMatrixClientService();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const matrixRoom = matrixService.getRoom(roomId) as any;
      if (!matrixRoom) return false;
      if (activeRoomId.value !== roomId) return false;

      const prevCount = getTimelineEvents(matrixRoom).length;
      try {
        await matrixService.scrollback(roomId, 25);
      } catch {
        return false;
      }

      const newCount = getTimelineEvents(matrixRoom).length;
      if (newCount <= prevCount) return false; // no more history

      // Write ONLY to Dexie — no reactive state changes
      const events = getTimelineEvents(matrixRoom);
      const msgs = await parseTimelineEvents(events, roomId);

      if (chatDbKitRef.value && msgs.length > 0) {
        const parsedMessages: ParsedMessage[] = msgs
          .filter(m => m.id && !m.id.startsWith("msg_"))
          .map(m => ({
            eventId: m.id,
            roomId: m.roomId,
            senderId: m.senderId,
            content: m.content,
            timestamp: m.timestamp,
            type: m.type,
            fileInfo: m.fileInfo,
            replyTo: m.replyTo,
            forwardedFrom: m.forwardedFrom,
            callInfo: m.callInfo,
            pollInfo: m.pollInfo,
            transferInfo: m.transferInfo,
            linkPreview: m.linkPreview,
            deleted: m.deleted,
            systemMeta: m.systemMeta,
            reactions: m.reactions,
          }));
        await chatDbKitRef.value.eventWriter.writeMessages(parsedMessages);
      }

      return true;
    } catch (e) {
      console.warn("[chat-store] prefetchNextBatch error:", e);
      return false;
    } finally {
      prefetchInFlight = false;
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

    const reactionSender = matrixIdToAddress(raw.sender as string);
    const matrixService = getMatrixClientService();
    const isMine = matrixService.isMe(raw.sender as string);

    // In-memory update (best-effort — messages may not be loaded in shallowRef)
    const roomMessages = messages.value[roomId];
    const targetMsg = roomMessages?.find(m => m.id === targetEventId);
    if (targetMsg) {
      if (!targetMsg.reactions) targetMsg.reactions = {};
      if (!targetMsg.reactions[emoji]) {
        targetMsg.reactions[emoji] = { count: 0, users: [] };
      }
      const reactionData = targetMsg.reactions[emoji];
      if (!reactionData.users.includes(reactionSender)) {
        reactionData.users.push(reactionSender);
        reactionData.count++;
      }
      const incomingId = raw.event_id as string;
      if (isMine && incomingId) {
        const currentId = reactionData.myEventId;
        if (!currentId || !currentId.startsWith("$") || incomingId.startsWith("$")) {
          reactionData.myEventId = incomingId;
        }
      }
      triggerRef(messages);
    }

    // Always persist to Dexie — even if message not in memory (e.g. other user's view)
    if (chatDbKitRef.value) {
      chatDbKitRef.value.eventWriter.writeReaction({
        eventId: raw.event_id as string,
        targetEventId,
        emoji,
        senderAddress: reactionSender,
        isMine,
      }).catch((e) => {
        console.warn("[chat-store] writeReaction to Dexie failed:", e);
      });
    }
  };

  /** Set the server-confirmed event ID for an own reaction */
  const setReactionEventId = (roomId: string, messageId: string, emoji: string, eventId: string) => {
    // In-memory update (fallback path)
    const roomMessages = messages.value[roomId];
    if (roomMessages) {
      const msg = roomMessages.find(m => m.id === messageId);
      if (msg?.reactions?.[emoji]) {
        msg.reactions[emoji].myEventId = eventId;
        triggerRef(messages);
      }
    }

    // Dexie write: persist the server event ID so removal works
    if (chatDbKitRef.value) {
      chatDbKitRef.value.messages.getByEventId(messageId).then(local => {
        if (!local?.reactions?.[emoji]) return;
        local.reactions[emoji].myEventId = eventId;
        return chatDbKitRef.value!.messages.updateReactions(messageId, local.reactions);
      }).catch((e) => {
        console.warn("[chat-store] setReactionEventId Dexie write failed:", e);
      });
    }
  };

  /** Optimistic add: instantly show a reaction before server confirms */
  const optimisticAddReaction = (roomId: string, messageId: string, emoji: string, userAddress: string) => {
    // In-memory update (fallback path)
    const roomMessages = messages.value[roomId];
    if (roomMessages) {
      const msg = roomMessages.find(m => m.id === messageId);
      if (msg) {
        if (!msg.reactions) msg.reactions = {};
        if (!msg.reactions[emoji]) {
          msg.reactions[emoji] = { count: 0, users: [] };
        }
        const rd = msg.reactions[emoji];
        if (!rd.users.includes(userAddress)) {
          rd.users.push(userAddress);
          rd.count++;
        }
        rd.myEventId = "__optimistic__";
        triggerRef(messages);
      }
    }

    // Dexie write: liveQuery will auto-update UI
    if (chatDbKitRef.value) {
      chatDbKitRef.value.messages.getByEventId(messageId).then(local => {
        if (!local) return;
        const reactions = local.reactions ?? {};
        if (!reactions[emoji]) {
          reactions[emoji] = { count: 0, users: [] };
        }
        const rd = reactions[emoji];
        if (!rd.users.includes(userAddress)) {
          rd.users.push(userAddress);
          rd.count = rd.users.length;
        }
        // Don't overwrite a real server ID if echo arrived before this async write
        if (!rd.myEventId || !rd.myEventId.startsWith("$")) {
          rd.myEventId = "__optimistic__";
        }
        return chatDbKitRef.value!.messages.updateReactions(messageId, reactions);
      }).catch((e) => {
        console.warn("[chat-store] optimisticAddReaction Dexie write failed:", e);
      });
    }
  };

  /** Optimistic remove: instantly hide a reaction before server confirms */
  const optimisticRemoveReaction = (roomId: string, messageId: string, emoji: string, userAddress: string) => {
    // In-memory update (fallback path)
    const roomMessages = messages.value[roomId];
    if (roomMessages) {
      const msg = roomMessages.find(m => m.id === messageId);
      if (msg?.reactions?.[emoji]) {
        const rd = msg.reactions[emoji];
        rd.users = rd.users.filter(u => u !== userAddress);
        rd.count = rd.users.length;
        delete rd.myEventId;
        if (rd.count === 0) {
          delete msg.reactions[emoji];
        }
        triggerRef(messages);
      }
    }

    // Dexie write: liveQuery will auto-update UI
    if (chatDbKitRef.value) {
      chatDbKitRef.value.messages.getByEventId(messageId).then(local => {
        if (!local?.reactions?.[emoji]) return;
        const reactions = local.reactions;
        const rd = reactions[emoji];
        rd.users = rd.users.filter(u => u !== userAddress);
        rd.count = rd.users.length;
        delete rd.myEventId;
        if (rd.count === 0) {
          delete reactions[emoji];
        }
        return chatDbKitRef.value!.messages.updateReactions(messageId, reactions);
      }).catch((e) => {
        console.warn("[chat-store] optimisticRemoveReaction Dexie write failed:", e);
      });
    }
  };

  /** Dual-write: persist a parsed message to Dexie alongside the in-memory store */
  const dexieWriteMessage = (msg: Message, roomId: string, raw: Record<string, unknown>) => {
    if (!chatDbKitRef.value) return;
    const isEncrypted = msg.content === "[encrypted]";
    const parsed: ParsedMessage = {
      eventId: raw.event_id as string,
      roomId,
      senderId: msg.senderId,
      content: msg.content,
      timestamp: msg.timestamp,
      type: msg.type,
      clientId: (raw.unsigned as any)?.transaction_id,
      fileInfo: msg.fileInfo,
      replyTo: msg.replyTo,
      forwardedFrom: msg.forwardedFrom,
      callInfo: msg.callInfo,
      pollInfo: msg.pollInfo,
      transferInfo: msg.transferInfo,
      linkPreview: msg.linkPreview,
      deleted: msg.deleted,
      systemMeta: msg.systemMeta,
      // Preserve raw event for decryption retry
      encryptedRaw: isEncrypted ? raw : undefined,
    };
    const myAddr = useAuthStore().address ?? "";
    const isActiveRoom = roomId === activeRoomId.value;
    if (isActiveRoom) {
      // Active room: write immediately for instant UI feedback
      chatDbKitRef.value.eventWriter.writeMessage(parsed, myAddr, activeRoomId.value).then(result => {
        // Enqueue decryption retry if message couldn't be decrypted
        if (isEncrypted && result !== "duplicate" && chatDbKitRef.value?.decryptionWorker) {
          chatDbKitRef.value.decryptionWorker.enqueue(
            raw.event_id as string,
            roomId,
            JSON.stringify(raw),
          ).catch(() => {});
        }
      }).catch(e => {
        console.warn("[chat-store] EventWriter.writeMessage failed:", e);
      });
    } else {
      // Background room: batch writes to reduce liveQuery notifications
      chatDbKitRef.value.eventWriter.writeMessageBuffered(parsed, myAddr, activeRoomId.value);
      if (isEncrypted && chatDbKitRef.value?.decryptionWorker) {
        chatDbKitRef.value.decryptionWorker.enqueue(
          raw.event_id as string,
          roomId,
          JSON.stringify(raw),
        ).catch(() => {});
      }
    }
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
          dexieWriteMessage(sysMsg, roomId, raw);
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
        const sender = matrixIdToAddress(raw.sender as string);
        let callTemplateKey: string;
        if (reason === "invite_timeout") {
          callTemplateKey = isVideo ? "system.missedVideoCall" : "system.missedVoiceCall";
        } else {
          callTemplateKey = isVideo ? "system.videoCall" : "system.voiceCall";
        }
        const sysMsg: Message = {
          id: raw.event_id as string,
          roomId,
          senderId: sender,
          content: "",
          timestamp: (raw.origin_server_ts as number) ?? 0,
          status: MessageStatus.sent,
          type: MessageType.system,
          callInfo: { callType: isVideo ? "video" : "voice", missed: reason === "invite_timeout", duration: Math.round(durationMs / 1000) },
          systemMeta: { template: callTemplateKey, senderAddr: sender },
        };
        addMessage(roomId, sysMsg);
        dexieWriteMessage(sysMsg, roomId, raw);
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
        const pollMsg: Message = {
          id: raw.event_id as string,
          roomId,
          senderId: matrixIdToAddress(raw.sender as string),
          content: question,
          timestamp: (raw.origin_server_ts as number) ?? Date.now(),
          status: MessageStatus.sent,
          type: MessageType.poll,
          pollInfo,
        };
        addMessage(roomId, pollMsg);
        dexieWriteMessage(pollMsg, roomId, raw);
        return;
      }

      // Handle poll response events — update vote on existing poll message
      if (raw.type === "org.matrix.msc3381.poll.response") {
        const content = raw.content as Record<string, unknown>;
        const relatesTo = content["m.relates_to"] as Record<string, unknown> | undefined;
        const pollEventId = relatesTo?.event_id as string;
        if (!pollEventId) return;
        const responseContent = (content["org.matrix.msc3381.poll.response"] ?? content) as Record<string, unknown>;
        const answers = (responseContent.answers as string[]) ?? [];
        const voterId = matrixIdToAddress(raw.sender as string);
        const matrixService = getMatrixClientService();
        const isMine = matrixService.isMe(raw.sender as string);

        // In-memory update (best-effort — poll message may not be in shallowRef)
        const roomMsgs = messages.value[roomId];
        const pollMsg = roomMsgs?.find(m => m.id === pollEventId);
        if (pollMsg?.pollInfo) {
          for (const optId of Object.keys(pollMsg.pollInfo.votes)) {
            pollMsg.pollInfo.votes[optId] = pollMsg.pollInfo.votes[optId].filter(v => v !== voterId);
          }
          if (answers.length > 0) {
            const optionId = answers[0];
            if (!pollMsg.pollInfo.votes[optionId]) pollMsg.pollInfo.votes[optionId] = [];
            pollMsg.pollInfo.votes[optionId].push(voterId);
          }
          if (isMine && answers.length > 0) {
            pollMsg.pollInfo.myVote = answers[0];
          }
          triggerRef(messages);
        }

        // Always persist to Dexie — even if poll message not in memory
        if (chatDbKitRef.value && answers.length > 0) {
          chatDbKitRef.value.eventWriter.writePollVote(
            pollEventId, voterId, answers[0], isMine,
          ).catch((e) => {
            console.warn("[chat-store] writePollVote to Dexie failed:", e);
          });
        }
        return;
      }

      // Handle poll end events
      if (raw.type === "org.matrix.msc3381.poll.end") {
        const content = raw.content as Record<string, unknown>;
        const relatesTo = content["m.relates_to"] as Record<string, unknown> | undefined;
        const pollEventId = relatesTo?.event_id as string;
        if (!pollEventId) return;
        const endedBy = matrixIdToAddress(raw.sender as string);

        // In-memory update (best-effort)
        const roomMsgs = messages.value[roomId];
        const pollMsg = roomMsgs?.find(m => m.id === pollEventId);
        if (pollMsg?.pollInfo) {
          pollMsg.pollInfo.ended = true;
          pollMsg.pollInfo.endedBy = endedBy;
          triggerRef(messages);
        }

        // Always persist to Dexie
        if (chatDbKitRef.value) {
          chatDbKitRef.value.eventWriter.writePollEnd(pollEventId, endedBy).catch((e) => {
            console.warn("[chat-store] writePollEnd to Dexie failed:", e);
          });
        }
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
              await maybeYieldDecrypt();
              const decrypted = await roomCrypto.decryptEvent(raw);
              newBody = decrypted.body;
            } catch {
              newBody = (newContent?.body as string) ?? (content.body as string) ?? "[decrypt error]";
            }
          } else {
            newBody = "[encrypted]";
          }
        } else {
          newBody = (newContent?.body as string) ?? (content.body as string) ?? "";
        }

        const cleanBody = newBody.replace(/^\* /, "");

        // Persist to Dexie (survives reload, triggers useLiveQuery)
        chatDbKitRef.value?.eventWriter.writeEdit(roomId, {
          targetEventId: targetId,
          newContent: cleanBody,
          editTs: typeof raw.origin_server_ts === "number" ? raw.origin_server_ts : undefined,
        });

        // Immediate in-memory update (no Dexie round-trip delay)
        updateMessageContent(roomId, targetId, cleanBody);
        return;
      }

      // Own-echo dedup: suppress echoes of messages sent from THIS device,
      // but allow cross-device messages (same user, different device) through
      // the normal processing pipeline so they get fully decrypted and stored.
      const matrixService = getMatrixClientService();
      const myUserId = matrixService.getUserId();
      if (myUserId && raw.sender === myUserId) {
        const eventId = raw.event_id as string;

        // Always skip local SDK event IDs (~! prefix) — the real $ event will follow
        if (eventId.startsWith("~")) {
          return;
        }

        if (chatDbKitRef.value) {
          // Check if this is an echo of a message sent from THIS device.
          // Match by clientId (unsigned.transaction_id) against pending messages.
          const transactionId = (raw.unsigned as any)?.transaction_id;
          if (transactionId) {
            const pending = await chatDbKitRef.value.messages.getByClientId(transactionId);
            if (pending) {
              // This device sent it — confirmSent() already handled or will handle
              return;
            }
          }

          // Also check: if the eventId already exists in Dexie, skip (duplicate sync)
          const existing = await chatDbKitRef.value.messages.getByEventId(eventId);
          if (existing) return;

          // Bastyon SDK doesn't set transaction_id — fall back to matching pending
          // messages by checking if any ACTIVELY SENDING message in this room could be
          // this echo. Only consider "pending"/"syncing" (not "failed") and only if
          // created very recently (within 10s) to minimize false suppression of
          // cross-device messages.
          const pendingMsgs = await chatDbKitRef.value.messages.getPendingMessages(roomId);
          const now = Date.now();
          const eventTs = (raw.origin_server_ts as number) ?? now;
          const recentSending = pendingMsgs.filter(m =>
            m.senderId === matrixIdToAddress(myUserId) &&
            (m.status === "pending" || m.status === "syncing") &&
            Math.abs(eventTs - m.timestamp) < 10_000
          );
          if (recentSending.length > 0) {
            // Likely an echo from this device — confirmSent() will reconcile
            return;
          }

          // This is a cross-device message — fall through to normal processing.
          // Do NOT return here — let the standard decrypt-and-write pipeline handle it.
        } else {
          // Legacy path (no Dexie): check in-memory pending messages
          const roomMsgs = messages.value[roomId];
          const hasPending = roomMsgs?.some(
            (m) => m.senderId === matrixIdToAddress(myUserId) && m.status === MessageStatus.sending
          );
          if (hasPending) return;
        }
      }

      // Handle donation/transfer messages (m.notice with txId)
      const mtype0 = content.msgtype as string;
      if (mtype0 === "m.notice" && content.txId) {
        const txBody = (content.body as string) ?? `Sent ${content.amount} PKOIN`;
        const transferMsg: Message = {
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
        };
        addMessage(roomId, transferMsg);
        dexieWriteMessage(transferMsg, roomId, raw);
        if (roomId === activeRoomId.value) {
          // Local Dexie + throttled network receipt (no per-message spam)
          advanceInboundWatermark(roomId, transferMsg.timestamp);
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
            await maybeYieldDecrypt();
            perfMark("decrypt-event:start");
            const decrypted = await roomCrypto.decryptEvent(raw);
            perfMark("decrypt-event:end");
            perfMeasure("decrypt-event", "decrypt-event:start", "decrypt-event:end");
            body = decrypted.body;
          } catch (e) {
            perfMark("decrypt-event:end");
            perfMeasure("decrypt-event", "decrypt-event:start", "decrypt-event:end");
            console.warn("[chat-store] handleTimelineEvent decrypt failed:", e);
            body = "[encrypted]";
          }
        } else {
          body = "[encrypted]";
        }
      }

      // Detect transfer messages encoded as JSON (encrypted with Pcrypto)
      if (body.startsWith('{"_transfer":true')) {
        try {
          const transfer = JSON.parse(body);
          const displayBody = transfer.message || `Sent ${transfer.amount} PKOIN`;
          const encTransferMsg: Message = {
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
          };
          addMessage(roomId, encTransferMsg);
          dexieWriteMessage(encTransferMsg, roomId, raw);
          if (roomId === activeRoomId.value) {
            advanceInboundWatermark(roomId, encTransferMsg.timestamp);
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

      // Parse reply reference — supports both:
      // 1. Standard Matrix: m.relates_to.m.in_reply_to.event_id
      // 2. Old bastyon-chat: m.relates_to.rel_type === "m.reference" + m.relates_to.event_id
      let replyTo: ReplyTo | undefined;
      const relatesTo = content["m.relates_to"] as Record<string, unknown> | undefined;
      const inReplyTo = relatesTo?.["m.in_reply_to"] as Record<string, unknown> | undefined;
      let replyEventId: string | undefined;
      if (inReplyTo?.event_id) {
        replyEventId = inReplyTo.event_id as string;
      } else if (relatesTo?.rel_type === "m.reference" && relatesTo?.event_id) {
        // Old bastyon-chat reply format (backwards compatibility)
        replyEventId = relatesTo.event_id as string;
      }
      if (replyEventId) {
        // Try to find the referenced message in already loaded messages
        const referenced = messages.value[roomId]?.find(m => m.id === replyEventId);
        if (referenced) {
          replyTo = {
            id: replyEventId,
            senderId: referenced.senderId,
            content: stripBastyonLinks(stripMentionAddresses(referenced.content)).slice(0, 100),
            type: referenced.type,
            deleted: referenced.deleted || undefined,
          };
        } else {
          // Fallback: try Dexie for messages outside the current viewport
          let stored: import("@/shared/lib/local-db/schema").LocalMessage | undefined;
          if (chatDbKitRef.value) {
            stored = await chatDbKitRef.value.messages.getByEventId(replyEventId);
          }
          if (stored) {
            const isDeleted = stored.deleted || stored.softDeleted;
            replyTo = {
              id: replyEventId,
              senderId: isDeleted ? "" : stored.senderId,
              content: isDeleted ? "" : stripBastyonLinks(stripMentionAddresses(stored.content)).slice(0, 100),
              type: isDeleted ? undefined : stored.type,
              deleted: isDeleted || undefined,
            };
          } else {
            // Original message not available — leave empty (UI shows "..." not "Deleted")
            replyTo = {
              id: replyEventId,
              senderId: "",
              content: "",
            };
          }
        }
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
      dexieWriteMessage(message, roomId, raw);

      // Mark as read locally + throttled network receipt (max 1/3s per room).
      // The useReadTracker batch path handles viewport-based reads every 2s.
      if (roomId === activeRoomId.value) {
        advanceInboundWatermark(roomId, message.timestamp);
      }
    } catch (e) {
      console.error("[chat-store] handleTimelineEvent error:", e);
    }
  };

  /** Handle read receipt events — both from other users (outbound watermark)
   *  and from ourselves on another device (inbound watermark / cross-device sync). */
  /** Resolve message timestamp for a receipt: try in-memory first, fall back to Dexie.
   *  Returns 0 if the message is not found anywhere. */
  const resolveReceiptTimestamp = async (
    roomId: string,
    eventId: string,
    receiptTs: number,
  ): Promise<number> => {
    // 1. In-memory (fast path — works for active room)
    const roomMessages = messages.value[roomId];
    const msg = roomMessages?.find(m => m.id === eventId);
    if (msg?.timestamp) return msg.timestamp;

    // 2. Dexie (background rooms where messages.value is empty)
    if (chatDbKitRef.value) {
      try {
        const dexieMsg = await chatDbKitRef.value.messages.getByEventId(eventId);
        if (dexieMsg?.timestamp) return dexieMsg.timestamp;
      } catch { /* DB may be torn down */ }
    }

    // 3. Fallback: receipt's own timestamp (less precise but usable)
    return receiptTs;
  };

  const handleReceiptEvent = (event: unknown, room: unknown) => {
    try {
      const receiptEvent = event as any;
      const roomObj = room as Record<string, unknown>;
      const roomId = roomObj?.roomId as string;
      if (!roomId) return;

      const matrixService = getMatrixClientService();
      const myUserId = matrixService.getUserId();

      const content = receiptEvent?.getContent?.() ?? receiptEvent?.event?.content;
      if (!content) return;

      for (const [eventId, receiptTypes] of Object.entries(content)) {
        const readReceipts = (receiptTypes as Record<string, unknown>)?.["m.read"] as Record<string, unknown> | undefined;
        if (!readReceipts) continue;

        for (const userId of Object.keys(readReceipts)) {
          const receiptData = (readReceipts[userId] as Record<string, unknown>) ?? {};
          const receiptTs = (receiptData.ts as number) ?? 0;

          if (userId === myUserId) {
            // Own receipt from another device → advance inbound read watermark.
            // This is the key cross-device sync path: when desktop reads a message,
            // mobile receives our own receipt via /sync and clears unread here.
            // Also clear in-memory unread for immediate reactivity
            const inMemRoom = getRoomById(roomId);
            if (inMemRoom) inMemRoom.unreadCount = 0;

            // Async: resolve precise timestamp, then commit watermark to Dexie
            resolveReceiptTimestamp(roomId, eventId, receiptTs).then(timestamp => {
              if (timestamp > 0 && chatDbKitRef.value) {
                chatDbKitRef.value.rooms.markAsRead(roomId, timestamp).catch(() => {});
              }
            }).catch(() => {});
            continue;
          }

          // Other user's receipt → advance outbound watermark (they read our messages)
          if (chatDbKitRef.value) {
            resolveReceiptTimestamp(roomId, eventId, receiptTs).then(timestamp => {
              if (timestamp > 0 && chatDbKitRef.value) {
                chatDbKitRef.value.eventWriter.writeReceipt({
                  eventId,
                  readerAddress: matrixIdToAddress(userId),
                  roomId,
                  timestamp,
                }).catch(() => {});
              }
            }).catch(() => {});
          }
        }
      }

      // Trigger reactivity for in-memory path
      triggerRef(rooms);
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

      console.info("[Redaction] processing", { redactedEventId, roomId });

      const roomMessages = messages.value[roomId];
      if (!roomMessages) {
        console.info("[Redaction] no in-memory messages for room, writing to Dexie only");
        // Still write to Dexie even if in-memory store is empty
        if (chatDbKitRef.value && redactedEventId) {
          chatDbKitRef.value.eventWriter.writeRedaction({
            redactedEventId,
            roomId,
          }).catch((e) => {
            console.warn("[chat-store] writeRedaction failed:", e);
          });
        }
        return;
      }

      // Check if the redacted event was a reaction — find and remove it
      for (const msg of roomMessages) {
        if (!msg.reactions) continue;
        for (const [emoji, data] of Object.entries(msg.reactions)) {
          if (data.myEventId === redactedEventId) {
            // It's our own reaction being redacted
            console.info("[Redaction] matched own reaction", { msgId: msg.id, emoji, redactedEventId });
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

      // Persist redaction to Dexie (handles room preview update internally)
      if (chatDbKitRef.value && redactedEventId) {
        chatDbKitRef.value.eventWriter.writeRedaction({
          redactedEventId,
          roomId,
        }).catch((e) => {
          console.warn("[chat-store] writeRedaction failed:", e);
        });
      }

      // Check if the redacted event is a message — mark as deleted
      const redactedMsg = roomMessages.find(m => m.id === redactedEventId);
      if (redactedMsg && !redactedMsg.deleted) {
        console.info("[Redaction] marking message as deleted", { msgId: redactedMsg.id });
        redactedMsg.deleted = true;
        redactedMsg.content = "";
        redactedMsg.fileInfo = undefined;
        redactedMsg.replyTo = undefined;
        redactedMsg.reactions = undefined;
        redactedMsg.pollInfo = undefined;
        redactedMsg.transferInfo = undefined;
        redactedMsg.forwardedFrom = undefined;

        // Mark replyTo.deleted on any in-memory message that references the redacted one
        for (const msg of roomMessages) {
          if (msg.replyTo?.id === redactedEventId) {
            msg.replyTo.deleted = true;
            msg.replyTo.senderId = "";
            msg.replyTo.content = "";
          }
        }

        // Update room lastMessage preview — show deleted placeholder
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
      console.warn("[Redaction] event not found as reaction or message, triggering full rebuild", { redactedEventId, roomId });
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

  /** Rebuild reactions for all messages in a room from the Matrix timeline.
   *  Merges Dexie-persisted reactions with timeline data so that reactions
   *  outside the current (possibly short) timeline window are preserved. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rebuildReactionsForRoom = (roomId: string, matrixRoom: any) => {
    const roomMessages = messages.value[roomId];
    if (!roomMessages) return;

    const timelineEvents = getTimelineEvents(matrixRoom);
    const matrixService = getMatrixClientService();

    // Collect all non-redacted reaction events from the timeline
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

    // Merge: for messages NOT in the timeline reaction map, preserve Dexie reactions
    // so that reactions outside the current (short) timeline window survive.
    for (const msg of roomMessages) {
      const timelineReactions = reactionMap.get(msg.id);
      if (timelineReactions) {
        // Timeline has reactions for this message — use them (server is authoritative)
        msg.reactions = timelineReactions;
      }
      // If timeline has NO reactions for this message, keep existing msg.reactions
      // (they came from Dexie via liveQuery and are still valid).
      // Only clear if timeline explicitly showed zero reactions for a message
      // that WAS in the timeline window.
    }
    triggerRef(messages);

    // Also sync Dexie with the merged state (non-blocking)
    if (chatDbKitRef.value) {
      for (const msg of roomMessages) {
        if (msg.reactions) {
          chatDbKitRef.value.messages.updateReactions(msg.id, msg.reactions).catch((e) => {
            console.warn("[chat-store] rebuildReactions Dexie sync failed:", e);
          });
        }
      }
    }
  };

  /** Handle being kicked/banned from a room — tombstone in Dexie + remove from UI */
  const handleKicked = (roomId: string, reason: "kicked" | "banned" = "kicked") => {
    // Tombstone in Dexie (async, non-blocking for UI)
    if (chatDbKitRef.value) {
      chatDbKitRef.value.rooms.tombstoneRoom(roomId, reason).catch((e: unknown) => {
        console.warn("[chat-store] handleKicked: tombstone failed", e);
      });
    }
    optimisticRemoveRoom(roomId);
  };

  /** Handle Room.accountData events — cross-device sync for clear-history markers */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleRoomAccountData = async (event: any, room: any) => {
    if (event.getType?.() !== "m.bastyon.clear_history") return;
    const content = event.getContent?.();
    const clearedAtTs = content?.cleared_at_ts;
    if (!clearedAtTs || typeof clearedAtTs !== "number") return;

    const roomId = room?.roomId ?? room?.getId?.();
    if (!roomId) return;

    // Check if this is newer than what we have locally
    if (chatDbKitRef.value) {
      const existingTs = chatDbKitRef.value.eventWriter.getClearedAtTs(roomId);
      if (existingTs && existingTs >= clearedAtTs) return;

      chatDbKitRef.value.eventWriter.setClearedAtTs(roomId, clearedAtTs);
      await chatDbKitRef.value.rooms.clearHistory(roomId, clearedAtTs);
      await chatDbKitRef.value.messages.purgeBeforeTimestamp(roomId, clearedAtTs);

      // Invalidate caches
      decryptedPreviewCache.delete(roomId);
      _chatRoomFromDexieCache.delete(roomId);

      // Clear in-memory messages if this room is active
      if (activeRoomId.value === roomId) {
        messages.value[roomId] = [];
        triggerRef(messages);
        messageWindowSize.value = 50;
      }
    }
  };

  /** Revive a tombstoned room (used when rejoining a previously-deleted room) */
  const clearDeletedRoom = (roomId: string) => {
    if (chatDbKitRef.value) {
      chatDbKitRef.value.rooms.reviveRoom(roomId).catch((e: unknown) => {
        console.warn("[chat-store] clearDeletedRoom: revive failed", e);
      });
    }
  };

  /** Load rooms from Dexie IndexedDB for instant display before auth/Matrix init.
   *  Reads the user address from localStorage and opens the Dexie DB directly,
   *  bypassing the full auth flow. This gives ~50ms first-paint instead of 2-3s. */
  const loadCachedRooms = async () => {
    if (rooms.value.length > 0) return; // already have rooms

    try {
      // Read address from localStorage without going through auth store init
      const raw = localStorage.getItem("forta-chat:auth");
      const address = raw ? JSON.parse(raw)?.address : null;
      if (!address) return;

      // Open Dexie DB directly — ChatDatabase constructor is synchronous,
      // actual DB open happens on first query (fast for local IndexedDB).
      const db = new ChatDatabase(address);
      const localRooms = await db.rooms
        .where("membership")
        .anyOf(["join", "invite"])
        .and((r: LocalRoom) => !r.isDeleted)
        .toArray();
      db.close();

      if (localRooms.length === 0 || rooms.value.length > 0) return;

      // Sort by last activity (newest first)
      localRooms.sort((a, b) =>
        (b.lastMessageTimestamp || b.updatedAt || 0) - (a.lastMessageTimestamp || a.updatedAt || 0),
      );

      // Convert LocalRoom → lightweight ChatRoom for display
      const cachedRooms: ChatRoom[] = localRooms.map(lr => ({
        id: lr.id,
        name: lr.name,
        avatar: lr.avatar,
        isGroup: lr.isGroup,
        members: lr.members,
        membership: lr.membership as "join" | "invite",
        unreadCount: lr.unreadCount,
        topic: lr.topic,
        updatedAt: lr.updatedAt,
        lastMessage: lr.lastMessagePreview != null ? {
          id: lr.lastMessageEventId ?? "",
          roomId: lr.id,
          senderId: lr.lastMessageSenderId ?? "",
          content: lr.lastMessagePreview,
          timestamp: lr.lastMessageTimestamp ?? lr.updatedAt ?? 0,
          status: deriveOutboundStatus(
            lr.lastMessageLocalStatus ?? "synced",
            lr.lastMessageTimestamp ?? 0,
            lr.lastReadOutboundTs ?? 0,
          ),
          type: lr.lastMessageType ?? MessageType.text,
          decryptionStatus: lr.lastMessageDecryptionStatus,
          callInfo: lr.lastMessageCallInfo,
          systemMeta: lr.lastMessageSystemMeta,
        } as Message : undefined,
        lastMessageReaction: lr.lastMessageReaction ?? undefined,
      } as ChatRoom));

      rooms.value = cachedRooms;
      rebuildRoomsMap();
      namesReady.value = true; // Dexie has resolved names from previous session
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

  /** Load cached messages. Returns cache age in ms (0 if no cache). */
  const loadCachedMessages = async (roomId: string): Promise<number> => {
    if (messages.value[roomId]?.length) return 0; // already have messages

    // Primary path: read from Dexie (local-first source of truth)
    if (chatDbKitRef.value) {
      try {
        const clearedAtTs = chatDbKitRef.value.eventWriter.getClearedAtTs(roomId);
        const localMsgs = await chatDbKitRef.value.messages.getMessages(roomId, 50, undefined, clearedAtTs);
        if (localMsgs.length > 0) {
          // Dexie data will arrive via liveQuery → activeMessages computed.
          // No need to write to messages.value — just signal that cache exists.
          return 0;
        }
      } catch (e) {
        console.warn("[chat-store] loadCachedMessages (Dexie) failed:", e);
      }
      return 0;
    }

    // Fallback: old localStorage cache (only when Dexie not yet initialized)
    try {
      const cached = await getCachedMessages(roomId);
      if (cached.length > 0 && !messages.value[roomId]?.length) {
        const msgs = cached as Message[];
        const cleaned = msgs.filter(
          m => m.status !== MessageStatus.sending && m.status !== MessageStatus.failed,
        );
        backfillCallInfo(cleaned);
        for (const m of cleaned) {
          if (m.content.includes("@") && /@[a-f0-9]{20,}:/i.test(m.content)) {
            m.content = cleanMatrixIds(m.content);
          }
        }
        messages.value[roomId] = cleaned;
        triggerRef(messages);
        const cachedAt = getCacheTimestamp(roomId);
        return cachedAt ? Date.now() - cachedAt : Infinity;
      }
    } catch (e) {
      console.warn("[chat-store] loadCachedMessages failed:", e);
    }
    return 0;
  };

  /** Check if all peers in a room have published encryption keys.
   *  Updates peerKeysStatus map and returns the status. */
  const checkPeerKeys = async (roomId: string): Promise<PeerKeysStatus> => {
    const authStore = useAuthStore();
    const roomCrypto = authStore.pcrypto?.rooms[roomId];
    if (!roomCrypto) {
      peerKeysStatus.set(roomId, "unknown");
      return "unknown";
    }

    const canEncrypt = roomCrypto.canBeEncrypt();
    const status: PeerKeysStatus = canEncrypt ? "available" : "missing";
    peerKeysStatus.set(roomId, status);
    return status;
  };

  /** Reset all in-memory state and account-specific localStorage (called on logout) */
  const cleanup = () => {
    rooms.value = [];
    roomsMap.clear();
    activeRoomId.value = null;
    messages.value = {};
    typing.value = {};
    replyingTo.value = null;
    isDetachedFromLatest.value = false;
    roomsInitialized.value = false;
    namesReady.value = false;
    editingMessage.value = null;
    deletingMessage.value = null;
    userDisplayNames.value = {};
    selectionMode.value = false;
    selectedMessageIds.value = new Set();
    forwardingMessages.value = false;
    pinnedMessages.value = [];
    pinnedMessageIndex.value = 0;
    pinnedRoomIds.value = new Set();
    mutedRoomIds.value = new Set();
    matrixKitRef.value = null;
    pcryptoRef.value = null;
    chatDbKitRef.value = null;
    decryptedPreviewCache.clear();
    changedRoomIds.clear();
    decryptFailedRooms.clear();
    peerKeysStatus.clear();
    matrixRoomAddresses.clear();
    profilesRequestedForRooms.clear();
    roomFetchStates.clear();
    _sortedRoomsRef.value = [];
    messageWindowSize.value = 50;

    // Clear localStorage account data
    localStorage.removeItem(_pinnedKey);
    localStorage.removeItem(_mutedKey);
  };

  return {
    activeMediaMessages,
    activeMessages,
    activeRoom,
    activeRoomId,
    addMessage,
    addRoom,
    advanceInboundWatermark,
    checkPeerKeys,
    cleanup,
    clearDeletedRoom,
    deletingMessage,
    editingMessage,
    enterDetachedMode,
    enterSelectionMode,
    exitSelectionMode,
    forwardingMessages,
    getDisplayName,
    getRoomPowerLevels,
    getTypingUsers,
    handleKicked,
    handleRoomAccountData,
    handleReceiptEvent,
    handleRedactionEvent,
    handleTimelineEvent,
    exitDetachedMode,
    inviteMember,
    isDetachedFromLatest,
    isRoomPublic,
    joinRoomById,
    bindAccountKeys,
    banMember,
    getBannedMembers,
    isMemberMuted,
    kickMember,
    clearHistory,
    leaveGroup,
    loadCachedMessages,
    loadCachedRooms,
    loadProfilesForRoomIds,
    loadAllMessages,
    loadPinnedMessages,
    loadMoreMessages,
    loadRoomMessages,
    prefetchNextBatch,
    markRoomAsRead,
    markRoomChanged,
    messages,
    messagesMap: messages,
    mutedRoomIds,
    optimisticAddReaction,
    optimisticRemoveReaction,
    peerKeysStatus,
    setReactionEventId,
    pinMessage,
    pinnedMessageIndex,
    pinnedMessages,
    pinnedRoomIds,
    preloadRoomsByIds,
    preloadVisibleRooms,
    ensureRoomsLoaded,
    roomFetchStates,
    retryRoomFetch,
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
    updateMessageIdAndStatus,
    updateMessageStatus,
    chatDbKitRef,
    setChatDbKit,
    getDbKit,
    dexieMessagesReady,
    dexieRoomsReady,
    expandMessageWindow,
    messageWindowSize,
    /** Clear profile-requested flags for given rooms so loadProfilesForRoomIds retries them */
    clearProfileCache(roomIds: string[]) {
      for (const id of roomIds) profilesRequestedForRooms.delete(id);
    },
    /** Load members from server for rooms with incomplete member lists, then re-fetch profiles.
     *  This resolves room names for 1:1 chats where members weren't loaded during initial sync. */
    async loadMembersForRooms(roomIds: string[]) {
      try {
        const matrixService = getMatrixClientService();
        if (!matrixService.isReady()) return;
        const kit = matrixKitRef.value;
        await Promise.all(roomIds.map(async (roomId) => {
          const matrixRoom = matrixService.getRoom(roomId);
          if (matrixRoom && typeof (matrixRoom as any).loadMembersIfNeeded === "function") {
            try {
              await (matrixRoom as any).loadMembersIfNeeded();
              // Update display names from new member data
              if (kit) updateDisplayNames([matrixRoom], kit);
              profilesRequestedForRooms.delete(roomId);
            } catch { /* ignore per-room failures */ }
          }
        }));
        loadProfilesForRoomIds(roomIds);
      } catch { /* matrix service not ready */ }
    },
    /** Dispose write buffer (call on logout / cleanup) */
    disposeWriteBuffer() {
      chatDbKitRef.value?.eventWriter.disposeBuffer();
    },
  };
});
