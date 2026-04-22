<script setup lang="ts">
import { ref, computed, watch, onMounted, nextTick, onUnmounted, provide } from "vue";
import { useChatStore, MessageType } from "@/entities/chat";
import { useAuthStore } from "@/entities/auth";
import { useThemeStore } from "@/entities/theme";
import { isConsecutiveMessage } from "@/entities/chat/lib/message-utils";
import { cleanMatrixIds, resolveSystemText } from "@/entities/chat/lib/chat-helpers";
import { formatDate } from "@/shared/lib/format";
import { UserAvatar } from "@/entities/user";
import { useMessages } from "../model/use-messages";
import { useScrollToMessage, toMessage } from "../model/use-scroll-to-message";
import { getChatDb, isChatDbReady } from "@/shared/lib/local-db";
import { useToast } from "@/shared/lib/use-toast";
import MessageBubble from "./MessageBubble.vue";
import CallEventCard from "./CallEventCard.vue";
import { MessageSkeleton } from "@/shared/ui/skeleton";
import MessageContextMenu from "./MessageContextMenu.vue";
import EmojiPicker from "./EmojiPicker.vue";
import MediaViewer from "./MediaViewer.vue";
import ReactionEffect from "./ReactionEffect.vue";
import TypingBubble from "./TypingBubble.vue";
import ChatVirtualScroller from "@/shared/ui/ChatVirtualScroller.vue";
import { useI18n } from "@/shared/lib/i18n";
import { useUnreadBanner } from "../model/use-unread-banner";
import { useReadTracker } from "../model/use-read-tracker";
import UnreadBanner from "./UnreadBanner.vue";

const chatStore = useChatStore();
const authStore = useAuthStore();
const themeStore = useThemeStore();
const { loadMessages, toggleReaction, deleteMessage, deleteMessages, votePoll, endPoll, retryMediaUpload, retryMessage, cancelMediaUpload } = useMessages();
const { toast } = useToast();
const { t } = useI18n();

const { bannerState, freezeBanner, dismissBanner, forceDismiss, hasBanner } = useUnreadBanner();

/** Resolve system message text dynamically using current display names + i18n */
const resolveSystemMsg = (msg: { content: string; systemMeta?: { template: string; senderAddr: string; targetAddr?: string; extra?: Record<string, string> } }): string => {
  if (msg.systemMeta?.template) {
    const text = resolveSystemText(
      msg.systemMeta.template, msg.systemMeta.senderAddr, msg.systemMeta.targetAddr,
      (addr) => chatStore.getDisplayName(addr), t, msg.systemMeta.extra,
    );
    // Guard: never render hex/address strings — show safe fallback
    if (/[a-f0-9]{16,}/i.test(text)) return t("system.unknownEvent");
    return text;
  }
  // Legacy messages without systemMeta — sanitize and guard
  const cleaned = cleanMatrixIds(msg.content);
  if (/[a-f0-9]{16,}/i.test(cleaned)) return t("system.unknownEvent");
  return cleaned;
};

// Provide search query for MessageContent highlighting
const searchQuery = ref("");
provide("searchQuery", searchQuery);

// Bulk path takes precedence when deletingMessages is populated.
const isBulkDelete = computed(() => chatStore.deletingMessages.length > 0);
const deleteCount = computed(() =>
  isBulkDelete.value ? chatStore.deletingMessages.length : 1,
);

const closeDeleteModal = () => {
  chatStore.deletingMessage = null;
  chatStore.deletingMessages = [];
  chatStore.exitSelectionMode();
};

const handleDeleteForMe = async () => {
  if (isBulkDelete.value) {
    const ids = chatStore.deletingMessages.map((m) => m.id);
    const result = await deleteMessages(ids, false);
    if (result.failed > 0) {
      toast(t("messageList.deleteResultSummary", {
        succeeded: result.succeeded, failed: result.failed,
      }));
    }
    closeDeleteModal();
    return;
  }
  if (chatStore.deletingMessage) {
    deleteMessage(chatStore.deletingMessage.id, false);
    chatStore.deletingMessage = null;
  }
};

const handleDeleteForEveryone = async () => {
  if (isBulkDelete.value) {
    const ids = chatStore.deletingMessages.map((m) => m.id);
    const result = await deleteMessages(ids, true);
    if (result.failed > 0) {
      toast(t("messageList.deleteResultSummary", {
        succeeded: result.succeeded, failed: result.failed,
      }));
    }
    closeDeleteModal();
    return;
  }
  if (chatStore.deletingMessage) {
    deleteMessage(chatStore.deletingMessage.id, true);
    chatStore.deletingMessage = null;
  }
};

const contextMenu = ref<{ show: boolean; x: number; y: number; message: import("@/entities/chat").Message | null; isOwn: boolean }>({
  show: false, x: 0, y: 0, message: null, isOwn: false,
});

const openContextMenu = (payload: { message: import("@/entities/chat").Message; x: number; y: number }) => {
  if (payload.message.deleted) return;
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
      navigator.clipboard.writeText(message.content).then(() => toast(t("chat.copiedToClipboard")));
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
      chatStore.initForward(message);
      break;
    case "pin":
      chatStore.pinMessage(message.id);
      break;
    case "unpin":
      chatStore.unpinMessage(message.id);
      break;
  }
  closeContextMenu();
};

const handlePollVote = (messageId: string, optionId: string) => {
  votePoll(messageId, optionId);
};

const handlePollEnd = (messageId: string) => {
  endPoll(messageId);
};

const handleToggleReactionWithEffect = (messageId: string, emoji: string) => {
  toggleReaction(messageId, emoji);
  if (themeStore.animatedReactions) {
    lastReactionEmoji.value = emoji;
    setTimeout(() => { lastReactionEmoji.value = null; }, 100);
  }
};

const handleContextReaction = (emoji: string, message: import("@/entities/chat").Message) => {
  toggleReaction(message.id, emoji);
  themeStore.addRecentEmoji(emoji);
  if (themeStore.animatedReactions) {
    lastReactionEmoji.value = emoji;
    setTimeout(() => { lastReactionEmoji.value = null; }, 100);
  }
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

const lastReactionEmoji = ref<string | null>(null);

const listRef = ref<HTMLElement>();
const scrollerRef = ref<{ scrollToBottom: () => void; scrollToIndex: (idx: number, opts?: { align?: "start" | "center" | "end" }) => void; getContainerEl: () => HTMLElement | null }>();
const isNearBottom = ref(true);
const showScrollFab = ref(false);
const loading = ref(false);
const loadingMore = ref(false);
const switching = ref(false); // true during room switch — suppresses watchers
const settled = ref(false); // false until messages loaded + scrolled — hides scroller to prevent flicker
const refreshingStaleCache = ref(false); // true when showing stale cached messages while fresh data loads
const loadEverAttempted = ref(false); // true only after at least one load cycle ran for the current room
const hasMore = ref(true);
const newMessageCount = ref(0);

const fabBadgeCount = computed(() => {
  const c = hasBanner() ? bannerState.value.frozenUnreadCount : newMessageCount.value;
  return c > 99 ? '99+' : c;
});

// --- Scroll threshold state ---
const LOAD_THRESHOLD = 1200; // px from max scroll — trigger expand
const VELOCITY_BOOST_THRESHOLD = 1500; // px/s — fast scroll triggers early thresholds
const networkWaiting = ref(false); // true when Dexie cache exhausted, waiting for network
let lastScrollTop = 0;
let lastScrollTime = 0;
let scrollVelocity = 0; // px per second (positive = scrolling toward older)

/** Flatten messages + date separators into a single virtual list */
interface VirtualItem {
  id: string;
  type: "message" | "date-separator" | "typing" | "unread-banner";
  message?: import("@/entities/chat").Message;
  label?: string;
  index?: number;
  unreadCount?: number;
  /** Satisfies ChatVirtualScroller ChatVirtualItem index signature */
  [key: string]: unknown;
}

const virtualItems = computed<VirtualItem[]>(() => {
  const msgs = chatStore.activeMessages;
  const items: VirtualItem[] = [];
  const { frozenLastReadId, frozenUnreadCount } = bannerState.value;
  const myAddr = authStore.address;

  // Track whether we've found the last-read message and need to insert the banner.
  // The banner goes BEFORE the first inbound (not own) message after the last-read marker.
  // This ensures own messages sent after the watermark stay ABOVE the banner.
  let bannerPending = false;
  let bannerInserted = false;

  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i];

    // Skip ghost messages: no content, no media, not deleted, not system.
    // NEVER skip messages with pending/failed decryption — they must remain visible
    // so the user sees that a new message exists (shown as "[encrypted]" placeholder).
    if (
      !msg.deleted &&
      !msg.content &&
      !msg.fileInfo &&
      !msg.pollInfo &&
      !msg.callInfo &&
      !msg.transferInfo &&
      msg.type !== "system" &&
      !msg.decryptionStatus
    ) {
      if (import.meta.env.DEV) {
        console.warn("[MessageList] ghost message filtered:", msg.id, msg.senderId, msg.status);
      }
      continue;
    }

    const prevMsg = msgs[i - 1];
    const dateLabel = getDateLabel(msg.timestamp, prevMsg?.timestamp);

    // If banner is pending and this is an inbound message, insert banner BEFORE it
    // (before its date separator if one exists, so the banner sits right above the first unread)
    if (bannerPending && !bannerInserted && msg.senderId !== myAddr) {
      // Insert banner before the date separator (if any) for this message
      if (dateLabel) {
        const stableId = (msg as any)._key || msg.id;
        items.push({ id: "unread-banner", type: "unread-banner", unreadCount: frozenUnreadCount });
        items.push({ id: `date-${stableId}`, type: "date-separator", label: dateLabel });
      } else {
        items.push({ id: "unread-banner", type: "unread-banner", unreadCount: frozenUnreadCount });
      }
      bannerInserted = true;
    } else if (dateLabel) {
      const stableId = (msg as any)._key || msg.id;
      items.push({ id: `date-${stableId}`, type: "date-separator", label: dateLabel });
    }

    // Use _key (stable across tempId→serverId rename) for consistent item identity.
    items.push({ id: (msg as any)._key || msg.id, type: "message", message: msg, index: i });

    // Mark the last-read message — banner will be inserted before the next inbound message
    if (!bannerInserted && frozenLastReadId && frozenUnreadCount > 0) {
      const msgKey = (msg as any)._key;
      if (msg.id === frozenLastReadId || (msgKey && msgKey === frozenLastReadId)) {
        bannerPending = true;
      }
    }
  }

  // Typing indicator
  if (typingText.value) {
    items.push({ id: "typing-indicator", type: "typing" });
  }

  return items;
});

/** Newest-first for the inverted scroller (index 0 = visual bottom).
 *  Requires `activeMessages` / `virtualItems` in chronological order (oldest→newest).
 *  History loading appends at the chronological end = far end here = visual TOP = no scroll jump. */
const reversedItems = computed<VirtualItem[]>(() => virtualItems.value.slice().reverse());

/** Get the actual scroll container element from the scroller component. */
const getScrollContainer = (): HTMLElement | null => {
  return scrollerRef.value?.getContainerEl?.() ?? listRef.value ?? null;
};

/** Find timestamp of the latest inbound message (for read-on-open fallback). */
const findLatestInboundTimestamp = (): number => {
  const msgs = chatStore.activeMessages;
  const myAddr = authStore.address;
  // Messages are sorted oldest→newest; scan from end for latest inbound
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].senderId !== myAddr) return msgs[i].timestamp;
  }
  return 0;
};

const readTracker = useReadTracker({
  containerRef: computed(() => getScrollContainer()),
  getMessageTs: (el: HTMLElement) => {
    const ts = el.dataset.messageTs;
    if (!ts) return null;
    return parseInt(ts, 10);
  },
  onBatchReady: (highestTs: number) => {
    const roomId = chatStore.activeRoomId;
    if (roomId) {
      chatStore.advanceInboundWatermark(roomId, highestTs);
    }
  },
});

/** Custom directive: auto-observe inbound message elements for read tracking */
const vTrackRead = {
  mounted(el: HTMLElement) {
    if (el.dataset.messageTs) {
      readTracker.observeElement(el);
    }
  },
  unmounted(el: HTMLElement) {
    if (el.dataset.messageTs) {
      readTracker.unobserveElement(el);
    }
  },
};

const { scrollToMessage, scrollTarget } = useScrollToMessage(
  reversedItems,
  scrollerRef,
  getScrollContainer,
);

const handleReturnToLatest = async () => {
  const roomId = chatStore.activeRoomId;
  if (!roomId) return;
  await chatStore.exitDetachedMode(roomId);
  await nextTick();
  scrollToBottom();
};

/** Check if user is scrolled near the bottom.
 *  In column-reverse: scrollTop=0 means at the bottom (newest messages).
 *  Chrome returns negative scrollTop for column-reverse — use abs. */
const checkScroll = () => {
  const el = getScrollContainer();
  if (!el) return;
  const dist = Math.abs(el.scrollTop);
  isNearBottom.value = dist < 100;
  showScrollFab.value = dist > 300;
  if (isNearBottom.value) {
    newMessageCount.value = 0;
    // dismissBanner() respects grace period inside the composable —
    // no-op during the first 2s after freeze, preventing race condition.
    if (hasBanner()) dismissBanner();
  }
};

let pendingScrollToBottom = false;
let scrollStableTimer: ReturnType<typeof setTimeout> | undefined;
/** Scroll to newest messages (bottom of chat = scrollTop 0 in column-reverse). */
const scrollToBottom = (_smooth = false, onSettled?: () => void) => {
  newMessageCount.value = 0;
  clearTimeout(scrollStableTimer);
  pendingScrollToBottom = true;

  nextTick(() => {
    const el = getScrollContainer();
    if (el) el.scrollTop = 0;
    // Wait for content to settle (images loading, reactions expanding)
    requestAnimationFrame(() => {
      const el2 = getScrollContainer();
      if (el2) el2.scrollTop = 0;
      resetStableTimer(onSettled);
    });
  });
};

const resetStableTimer = (onSettled?: () => void) => {
  clearTimeout(scrollStableTimer);
  scrollStableTimer = setTimeout(() => {
    pendingScrollToBottom = false;
    onSettled?.();
  }, 300);
};

/** Two-step FAB: first press → first unread, second press → bottom */
const handleFabClick = () => {
  if (hasBanner()) {
    const bannerIdx = reversedItems.value.findIndex(item => item.type === "unread-banner");
    if (bannerIdx >= 0) {
      scrollerRef.value?.scrollToIndex(bannerIdx, { align: "start" });
      return;
    }
  }
  if (chatStore.isDetachedFromLatest) {
    handleReturnToLatest();
  } else {
    scrollToBottom(true);
  }
};

// --- Message entrance animation ---
const recentMessageIds = ref(new Set<string>());

// --- Floating date header (declared early so watches below can reference it) ---
const currentDateLabel = ref("");
const showDateHeader = ref(false);
let dateHideTimer: ReturnType<typeof setTimeout> | undefined;

// Version counter: increments on every watch invocation. After each await,
// the callback checks if its version is still current — if not, a newer
// invocation has started and this one should bail. Handles both different-room
// switches AND same-room re-invocations (e.g. during store init).
let watchVersion = 0;
let scrollThrottleRaf: number | null = null;
// Track the settled safety timeout so it can be cleared on room switch
let pendingSettledTimeout: ReturnType<typeof setTimeout> | null = null;

// Load messages when active room changes
watch(
  () => chatStore.activeRoomId,
  async (roomId) => {
    const myVersion = ++watchVersion;
    const isStale = () => watchVersion !== myVersion;

    if (!roomId) return;

    // ═══ PHASE 1: FREEZE STATE ═══
    switching.value = true;
    settled.value = false;
    loading.value = false;
    loadEverAttempted.value = false;
    refreshingStaleCache.value = false;
    newMessageCount.value = 0;
    hasMore.value = true;
    showScrollFab.value = false;
    showDateHeader.value = false;
    recentMessageIds.value.clear();
    isNearBottom.value = true;
    networkWaiting.value = false;
    lastScrollTop = 0;
    lastScrollTime = 0;
    scrollVelocity = 0;
    if (chatStore.isDetachedFromLatest) {
      chatStore.isDetachedFromLatest = false;
    }
    if (scrollThrottleRaf !== null) {
      cancelAnimationFrame(scrollThrottleRaf);
      scrollThrottleRaf = null;
    }
    if (pendingSettledTimeout !== null) {
      clearTimeout(pendingSettledTimeout);
      pendingSettledTimeout = null;
    }
    forceDismiss();
    readTracker.stopTracking();

    // ═══ PHASE 2: DETERMINE ANCHOR ═══
    let anchorItemIndex = -1;
    let scrollToBanner = false;

    if (isChatDbReady()) {
      const dbKit = getChatDb();
      const room = await dbKit.rooms.getRoom(roomId);
      if (isStale()) return;

      const watermarkTs = room?.lastReadInboundTs ?? 0;
      const myAddr = authStore.address ?? "";
      const clearedAtTs = dbKit.eventWriter.getClearedAtTs(roomId);

      if (import.meta.env.DEV) {
        console.log("[unread-banner] roomId=%s watermarkTs=%d myAddr=%s", roomId, watermarkTs, myAddr);
      }

      if (watermarkTs > 0) {
        const unreadCount = await dbKit.messages.countInboundAfter(roomId, watermarkTs, myAddr, clearedAtTs);
        if (isStale()) return;

        if (import.meta.env.DEV) {
          console.log("[unread-banner] unreadCount=%d", unreadCount);
        }

        if (unreadCount > 0) {
          const lastReadMsg = await dbKit.messages.getLastMessageAtOrBefore(roomId, watermarkTs, clearedAtTs);
          if (isStale()) return;

          const lastReadId = lastReadMsg?.eventId ?? lastReadMsg?.clientId ?? null;

          if (import.meta.env.DEV) {
            console.log("[unread-banner] lastReadId=%s lastReadMsg.ts=%d", lastReadId, lastReadMsg?.timestamp);
          }

          freezeBanner(lastReadId, unreadCount);

          // Ensure the Dexie liveQuery window is large enough to include the
          // last-read message so the banner can match it in virtualItems.
          const neededWindow = unreadCount + 20;
          if (neededWindow > chatStore.messageWindowSize) {
            chatStore.expandMessageWindow(neededWindow - chatStore.messageWindowSize);
          }

          scrollToBanner = true;
        }
      } else {
        // Bootstrap watermark for legacy rooms (first visit after feature was added).
        // Set the watermark to the latest message so future visits can detect unread.
        const latestMsg = await dbKit.messages.getLastNonDeleted(roomId, clearedAtTs);
        if (isStale()) return;
        if (latestMsg && latestMsg.timestamp > 0) {
          await dbKit.rooms.markAsRead(roomId, latestMsg.timestamp);
        }
      }
    }

    // If no anchor was set, do normal load.
    // Guard: verify messages belong to the TARGET room, not stale liveQuery data
    // from the previous room (useLiveQuery intentionally keeps stale data during re-subscription).
    const hasValidMessages = chatStore.activeMessages.length > 0
      && chatStore.activeMessages[0]?.roomId === roomId;
    if (anchorItemIndex === -1 && !hasValidMessages) {
      const cacheAge = await chatStore.loadCachedMessages(roomId);
      if (isStale()) return;

      // liveQuery can lag behind a Dexie read in loadCachedMessages — avoid treating
      // a non-empty local DB as "no cache" and forcing Matrix scrollback + loading spinner.
      if (isChatDbReady()) {
        const dbKit = getChatDb();
        const clearedAtPeek = dbKit.eventWriter.getClearedAtTs(roomId);
        const peek = await dbKit.messages.getMessages(roomId, 1, undefined, clearedAtPeek);
        if (peek.length > 0) {
          const dexieWaitDeadline = Date.now() + 2000;
          while (Date.now() < dexieWaitDeadline) {
            if (isStale()) return;
            const am = chatStore.activeMessages;
            if (am.length > 0 && am[0]?.roomId === roomId) break;
            await new Promise<void>(r => setTimeout(r, 10));
          }
        }
      }

      if (chatStore.chatDbKitRef && !chatStore.dexieMessagesReady) {
        const readyDeadline = Date.now() + 500;
        while (!chatStore.dexieMessagesReady && Date.now() < readyDeadline) {
          await new Promise(r => setTimeout(r, 10));
          if (isStale()) return;
        }
      }

      const hasCached = chatStore.activeMessages.length > 0
        && chatStore.activeMessages[0]?.roomId === roomId;
      const STALE_THRESHOLD = 60_000;

      if (!hasCached) {
        loading.value = true;
        try {
          await loadMessages(roomId);
        } catch { /* ignore */ }
        if (isStale()) return;

        if (chatStore.activeMessages.length === 0) {
          // Skip waiting for messages if history was cleared — no messages will arrive
          const dbKit = getChatDb();
          const hasClearedHistory = dbKit?.eventWriter.getClearedAtTs(roomId);
          if (!hasClearedHistory) {
            const SYNC_WAIT_MS = 8_000;
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, SYNC_WAIT_MS);
              const stopWatch = watch(
                () => chatStore.activeMessages.length,
                (len) => { if (len > 0) { clearTimeout(timer); stopWatch(); resolve(); } },
              );
              setTimeout(() => stopWatch(), SYNC_WAIT_MS + 50);
            });
            if (isStale()) return;
          }
        }
        loading.value = false;
      } else if (cacheAge > STALE_THRESHOLD) {
        refreshingStaleCache.value = true;
        loadMessages(roomId).catch(() => {}).finally(() => { refreshingStaleCache.value = false; });
      } else {
        loadMessages(roomId).catch(() => {});
      }
    }

    // Mark that at least one load cycle completed for this room.
    // Empty state is only allowed after this flag is set.
    loadEverAttempted.value = true;

    if (isStale()) return;

    // ═══ PHASE 3: RENDER + SCROLL ═══
    await nextTick();
    if (isStale()) return;
    await nextTick();
    if (isStale()) return;

    // Safety net: if rAF never fires or scroll stabilization hangs
    // (e.g. large rooms with slow rendering), force-reveal after 3s
    // so the user never sees an empty screen indefinitely.
    pendingSettledTimeout = setTimeout(() => {
      pendingSettledTimeout = null;
      if (!settled.value && !isStale()) {
        console.warn("[MessageList] settled safety timeout — force revealing scroller");
        settled.value = true;
        switching.value = false;
      }
    }, 3000);

    requestAnimationFrame(() => {
      if (pendingSettledTimeout !== null) {
        clearTimeout(pendingSettledTimeout);
        pendingSettledTimeout = null;
      }
      if (isStale()) return;

      const el = getScrollContainer();
      if (scrollToBanner && hasBanner()) {
        const bannerIdx = virtualItems.value.findIndex(item => item.type === "unread-banner");
        if (import.meta.env.DEV) {
          console.log("[unread-banner] PHASE3 bannerIdx=%d items=%d", bannerIdx, virtualItems.value.length);
        }
        if (bannerIdx >= 0) {
          // Convert to reversed index for the inverted scroller
          const reversedIdx = reversedItems.value.findIndex(item => item.type === "unread-banner");
          if (reversedIdx >= 0) {
            scrollerRef.value?.scrollToIndex(reversedIdx, { align: "start" });
          }
        } else if (el) {
          el.scrollTop = 0; // column-reverse: bottom = scrollTop 0
        }
      } else if (el) {
        el.scrollTop = 0; // column-reverse: bottom = scrollTop 0
      }

      // ═══ PHASE 4: REVEAL ═══
      settled.value = true;
      switching.value = false;
      checkScroll();

      // Prefetch first batch of older messages into Dexie so they're
      // ready when user scrolls up — zero network latency on scroll path.
      startPrefetch(roomId);

      // Grace period is now handled inside useUnreadBanner (dismiss lock).

      // Start read tracking with container polling instead of fixed timeout.
      // getScrollContainer() may return null if VList hasn't created its
      // internal scroll element yet — poll until available (max ~1s).
      const startReadTracking = async () => {
        const MAX_ATTEMPTS = 40; // 40×50ms = 2s — mobile may need longer for layout to settle
        const POLL_MS = 50;
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
          if (chatStore.activeRoomId !== roomId) return; // room changed
          const container = getScrollContainer();
          if (container && container.scrollHeight > 0) {
            const started = readTracker.startTracking(container);
            if (started) {
              // Wait one frame for layout to fully settle, then re-scan
              requestAnimationFrame(() => {
                readTracker.performManualScan();
                readTracker.flushNow();

                // Mobile fix: if user lands at the bottom on chat open,
                // immediately mark the latest inbound message as read.
                // IntersectionObserver may not fire in mobile WebViews
                // (column-reverse + dynamic toolbar layout shifts).
                if (isNearBottom.value) {
                  const latestTs = findLatestInboundTimestamp();
                  if (latestTs > 0) {
                    chatStore.advanceInboundWatermark(roomId, latestTs);
                  }
                }
              });
              return;
            }
          }
          await new Promise<void>(r => setTimeout(r, POLL_MS));
        }
        // Last resort: try anyway (container may have zero scrollHeight initially)
        if (chatStore.activeRoomId === roomId) {
          const container = getScrollContainer();
          if (container) {
            readTracker.startTracking(container);
          }
        }
      };
      startReadTracking();
    });
  },
  { immediate: true },
);

// Track the last message's identity to detect real appends.
// Only tracks the newest message's stable key — NOT array length.
// Including length caused false scroll-to-bottom on expandMessageWindow.
const lastMessageIdentity = computed(() => {
  const msgs = chatStore.activeMessages;
  if (!msgs.length) return null;
  const last = msgs[msgs.length - 1];
  // Use _key (clientId, stable) instead of id (flips clientId→eventId after confirmSent)
  // to avoid false triggers when message status changes.
  return (last as any)._key || last.id;
});

watch(lastMessageIdentity, (newVal, oldVal) => {
  if (!newVal || switching.value || loadingMore.value) return;

  // Messages appeared for the first time (e.g. Dexie async load after room open)
  // — always scroll to bottom so the user sees the latest messages.
  if (!oldVal) {
    if (!settled.value) return; // Don't fight the room-switch watcher
    scrollToBottom();
    return;
  }

  const msgs = chatStore.activeMessages;
  const lastMsg = msgs[msgs.length - 1];
  if (!lastMsg) return;

  const lastAddedIsOwn = lastMsg.senderId === authStore.address;

  if (lastAddedIsOwn || isNearBottom.value) {
    scrollToBottom();
    // Inbound message while at bottom: viewport already shows latest — flush read tracker
    // without waiting for IntersectionObserver batch (2s) so read markers stay in sync.
    if (!lastAddedIsOwn && isNearBottom.value) {
      nextTick(() => {
        requestAnimationFrame(() => {
          readTracker.performManualScan();
          readTracker.flushNow();
        });
      });
    }
  } else {
    newMessageCount.value++;
  }

  // Track newly arrived messages for entrance animation
  if (!loading.value) {
    recentMessageIds.value.add(lastMsg.id);
    const capturedId = lastMsg.id;
    setTimeout(() => {
      recentMessageIds.value.delete(capturedId);
    }, 350);
  }
});

/** Remove animation class immediately after the CSS animation finishes.
 *  This prevents the virtual scroller from accidentally replaying the entrance
 *  animation when it recycles / repositions DOM elements on subsequent updates. */
const onMsgAnimationEnd = (message: import("@/entities/chat").Message) => {
  const key = (message as any)._key || message.id;
  recentMessageIds.value.delete(key);
  recentMessageIds.value.delete(message.id);
};

const getMsgEnterClass = (message: import("@/entities/chat").Message): string => {
  // Check both _key (original tempId) and current id — updateMessageId may
  // have changed the id while recentMessageIds still tracks the tempId.
  const key = (message as any)._key || message.id;
  if (!recentMessageIds.value.has(key) && !recentMessageIds.value.has(message.id)) return "";
  return message.senderId === authStore.address ? "msg-enter-own" : "msg-enter-other";
};

const updateFloatingDate = () => {
  // Use first visible virtual item to determine date
  const scroller = scrollerRef.value;
  if (!scroller) return;

  const scrollEl = scroller.getContainerEl?.();
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

/** Wait for activeMessages.length to change (liveQuery responded) or timeout. */
const waitForDataChange = (prevLen: number, timeout = 300): Promise<void> =>
  new Promise((resolve) => {
    if (chatStore.activeMessages.length !== prevLen) { resolve(); return; }
    const timer = setTimeout(() => { stop(); resolve(); }, timeout);
    const stop = watch(() => chatStore.activeMessages.length, (len) => {
      if (len !== prevLen) { clearTimeout(timer); stop(); resolve(); }
    });
  });

/** Prefetch one batch of 25 messages into Dexie (fire-and-forget).
 *  Called after room load and after each expand to stay one step ahead. */
const startPrefetch = (roomId: string) => {
  chatStore.prefetchNextBatch(roomId)
    .then(more => { hasMore.value = more; })
    .catch(() => {});
};

/** Expand Dexie window to show more messages on scroll-up.
 *  With the inverted scroller (column-reverse), older messages are APPENDED
 *  to the end of the reversed array = visual top = far from viewport.
 *  NO scroll correction needed — the browser maintains scroll position. */
const doLoadMore = async (roomId: string): Promise<void> => {
  if (loadingMore.value) return;
  loadingMore.value = true;

  try {
    const prevLen = chatStore.activeMessages.length;

    // Expand Dexie query window — should find prefetched data
    chatStore.expandMessageWindow();
    await waitForDataChange(prevLen);

    if (chatStore.activeRoomId !== roomId) return;
    const newLen = chatStore.activeMessages.length;

    // If Dexie had nothing new, fetch from network (safety net)
    if (newLen <= prevLen && hasMore.value) {
      networkWaiting.value = true;
      const more = await chatStore.loadMoreMessages(roomId);
      hasMore.value = more;
      if (more && chatStore.activeRoomId === roomId) {
        chatStore.expandMessageWindow();
        await waitForDataChange(chatStore.activeMessages.length);
      }
      networkWaiting.value = false;
    }

    // Prefetch next batch so it's ready for the next scroll-up
    if (hasMore.value && chatStore.activeRoomId === roomId) {
      startPrefetch(roomId);
    }
  } catch {
    networkWaiting.value = false;
  } finally {
    loadingMore.value = false;
  }
};

/** Load newer messages (forward pagination in detached mode). */
const loadingNewer = ref(false);
const doLoadNewer = async (roomId: string) => {
  if (!isChatDbReady() || loadingNewer.value || loadingMore.value) return;
  loadingNewer.value = true;
  try {
    const msgs = chatStore.activeMessages;
    if (msgs.length === 0) return;

    const lastTimestamp = msgs[msgs.length - 1].timestamp;
    const dbKit = getChatDb();
    const clearedAtTs = dbKit.eventWriter.getClearedAtTs(roomId);
    const newer = await dbKit.messages.getMessagesAfter(roomId, lastTimestamp, 50, clearedAtTs);

    if (newer.length === 0) {
      await chatStore.exitDetachedMode(roomId);
      await nextTick();
      scrollToBottom();
      return;
    }

    const mapped = newer.map(toMessage);
    chatStore.enterDetachedMode(roomId, [...chatStore.activeMessages, ...mapped]);
  } finally {
    loadingNewer.value = false;
  }
};

const onScroll = () => {
  if (switching.value) return;
  // Throttle via rAF — at most once per frame (~16ms)
  if (scrollThrottleRaf !== null) return;
  scrollThrottleRaf = requestAnimationFrame(() => {
    scrollThrottleRaf = null;
    onScrollThrottled();
  });
};

/** ChatVirtualScroller @scroll handler */
const onScrollerScroll = (_scrollTop: number) => {
  onScroll();
};

const onScrollThrottled = () => {
  if (switching.value) return;
  checkScroll();
  updateFloatingDate();

  const container = getScrollContainer();
  if (!container) return;
  // Chrome returns negative scrollTop for column-reverse — normalize to positive
  const scrollTop = Math.abs(container.scrollTop);

  // Calculate scroll velocity (positive = scrolling toward older messages)
  const now = performance.now();
  if (lastScrollTime > 0) {
    const dt = (now - lastScrollTime) / 1000;
    if (dt > 0) {
      scrollVelocity = (scrollTop - lastScrollTop) / dt;
    }
  }
  lastScrollTop = scrollTop;
  lastScrollTime = now;

  const roomId = chatStore.activeRoomId;
  if (!roomId) return;

  // Forward pagination in detached mode — near bottom = scrollTop ≈ 0
  if (chatStore.isDetachedFromLatest) {
    if (scrollTop < LOAD_THRESHOLD && !loadingNewer.value) {
      doLoadNewer(roomId);
    }
  }

  if (!hasMore.value) return;

  // Distance from the top (oldest messages)
  const maxScroll = container.scrollHeight - container.clientHeight;
  const distFromTop = maxScroll - scrollTop;

  if (import.meta.env.DEV) {
    console.log("[scroll] scrollTop=%d maxScroll=%d distFromTop=%d hasMore=%s loadingMore=%s",
      scrollTop, maxScroll, distFromTop, hasMore.value, loadingMore.value);
  }

  // Velocity-adaptive threshold — fast scroll triggers expand earlier
  const speed = Math.abs(scrollVelocity);
  const effectiveLoadThreshold = speed > 3000 ? 3000
    : speed > VELOCITY_BOOST_THRESHOLD ? 2000
    : LOAD_THRESHOLD;

  // Load more when near the top (oldest end)
  if (distFromTop < effectiveLoadThreshold && !loadingMore.value) {
    if (import.meta.env.DEV) {
      console.log("[scroll] TRIGGERING doLoadMore distFromTop=%d threshold=%d", distFromTop, effectiveLoadThreshold);
    }
    doLoadMore(roomId);
  }
};

// Content resize observer: when near bottom, auto-scroll to keep newest visible
// (images loading, reactions expanding, etc.)
let contentResizeObserver: ResizeObserver | null = null;
let contentResizeRaf: number | null = null;

const attachContentObserver = () => {
  contentResizeObserver?.disconnect();
  if (contentResizeRaf !== null) { cancelAnimationFrame(contentResizeRaf); contentResizeRaf = null; }
  const el = getScrollContainer();
  if (!el) return;

  contentResizeObserver = new ResizeObserver(() => {
    if (contentResizeRaf !== null) return; // throttle: max one callback per frame
    contentResizeRaf = requestAnimationFrame(() => {
      contentResizeRaf = null;
      if (switching.value || loadingMore.value) return;
      // In column-reverse, near bottom = scrollTop ≈ 0.
      // When content resizes and we're near bottom, keep at bottom.
      // Skip during loadingMore to prevent scroll reset on history prepend.
      if (pendingScrollToBottom || isNearBottom.value) {
        const scrollEl = getScrollContainer();
        if (scrollEl) scrollEl.scrollTop = 0;
        if (pendingScrollToBottom) resetStableTimer();
      }
    });
  });
  // Observe the scroll container's first child (content wrapper)
  const contentEl = el.firstElementChild as HTMLElement | null;
  contentResizeObserver.observe(contentEl ?? el);
};

onMounted(() => {
  attachContentObserver();
});

// Re-attach when scroller mounts (e.g. room switch from empty → messages)
watch(
  () => scrollerRef.value,
  (scroller) => {
    attachContentObserver();
    if (scroller && !settled.value && !loading.value) {
      nextTick(() => {
        if (settled.value) return;
        const el = getScrollContainer();
        if (el) el.scrollTop = 0; // column-reverse: bottom = 0
        settled.value = true;
        switching.value = false;
        checkScroll();
      });
    }
  },
);

onUnmounted(() => {
  readTracker.stopTracking();
  contentResizeObserver?.disconnect();
  if (scrollThrottleRaf !== null) cancelAnimationFrame(scrollThrottleRaf);
  clearTimeout(dateHideTimer);
  clearTimeout(scrollStableTimer);
  pendingScrollToBottom = false;
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

const isAdmin = computed(() => {
  if (!chatStore.activeRoom) return false;
  return chatStore.getRoomPowerLevels(chatStore.activeRoom.id).myLevel >= 50;
});

const isMessagePinned = (messageId: string): boolean => {
  return chatStore.pinnedMessages.some(p => p.id === messageId);
};

/** Typing indicator */
const typingText = computed(() => {
  const roomId = chatStore.activeRoomId;
  if (!roomId) return "";
  const typingUsers = chatStore.getTypingUsers(roomId);
  const myAddr = authStore.address ?? "";
  const others = typingUsers.filter(id => id !== myAddr);
  if (others.length === 0) return "";

  const names = others.map(id => chatStore.getDisplayName(id));
  if (names.length === 1) {
    return t("messageList.isTyping", { name: names[0] });
  }
  if (names.length === 2) {
    return t("messageList.typingTwo", { name1: names[0], name2: names[1] });
  }
  return t("messageList.typingMany", { name: names[0], count: names.length - 1 });
});

const typingNames = computed(() => {
  const roomId = chatStore.activeRoomId;
  if (!roomId) return [];
  const typingUsers = chatStore.getTypingUsers(roomId);
  const myAddr = authStore.address ?? "";
  return typingUsers
    .filter((id: string) => id !== myAddr)
    .map((id: string) => chatStore.getDisplayName(id));
});

// Typing indicator toggle — no nudge needed with ChatVirtualScroller
// (ResizeObserver handles height changes automatically)

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

    <!-- Network wait shimmer — subtle 2px bar when Dexie cache exhausted and fetching from server -->
    <transition name="fade-refresh">
      <div
        v-if="networkWaiting"
        class="pointer-events-none absolute inset-x-0 top-0 z-30 h-0.5 animate-shimmer bg-gradient-to-r from-transparent via-color-bg-ac/40 to-transparent"
      />
    </transition>

    <!-- Stale cache refresh indicator -->
    <transition name="fade-refresh">
      <div
        v-if="refreshingStaleCache"
        class="absolute inset-x-0 top-0 z-30 flex justify-center pt-2"
      >
        <span class="flex items-center gap-1.5 rounded-full bg-neutral-grad-0/90 px-3 py-1 text-xs text-text-on-main-bg-color backdrop-blur-sm">
          <span class="contain-strict inline-block h-3 w-3 animate-spin rounded-full border-[1.5px] border-text-on-main-bg-color border-t-transparent" />
          {{ t("chat.updatingMessages") }}
        </span>
      </div>
    </transition>

    <!-- Loading state: skeleton on initial room load when no messages exist yet.
         Also show skeleton when load hasn't been attempted yet (prevents empty state flash).
         Show skeleton when settled=false to cover the gap where scroller has opacity:0.
         Never during pagination (expandMessageWindow / loadMoreMessages) to avoid skeleton flash. -->
    <MessageSkeleton v-if="((loading || switching || !loadEverAttempted || !settled || chatStore.isSyncing) && chatStore.activeMessages.length === 0)" />

    <!-- Empty state (only after fully loaded + settled + load was attempted, not during switching) -->
    <div
      v-if="!loading && !switching && loadEverAttempted && !chatStore.isSyncing && chatStore.activeMessages.length === 0 && settled"
      class="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 text-text-on-main-bg-color"
    >
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" class="opacity-20">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
      <span class="text-sm">No messages yet. Start a conversation!</span>
    </div>

    <!-- Virtualized Messages (custom inverted scroller — column-reverse eliminates prepend scroll jumps) -->
    <ChatVirtualScroller
      v-if="!loading"
      ref="scrollerRef"
      :items="reversedItems"
      class="h-full overscroll-contain px-4 py-3"
      :style="{ opacity: settled ? 1 : 0, transition: settled ? 'opacity 0.1s ease-out' : 'none' }"
      @scroll="onScrollerScroll"
    >
      <template #default="{ item }">
        <!-- Date separator -->
        <div
          v-if="item.type === 'date-separator'"
          class="mx-auto flex max-w-6xl justify-center py-3"
          :data-date-label="item.label"
        >
          <span class="rounded-full bg-neutral-grad-0/80 px-3 py-1 text-xs text-text-on-main-bg-color backdrop-blur-sm">
            {{ item.label }}
          </span>
        </div>

        <!-- Unread messages banner -->
        <div
          v-else-if="item.type === 'unread-banner'"
          data-new-messages-divider
        >
          <UnreadBanner :count="item.unreadCount ?? 0" />
        </div>

        <!-- Call event card (bubble-style, aligned like a message) -->
        <div
          v-else-if="item.type === 'message' && item.message?.callInfo"
          v-track-read
          class="mx-auto max-w-6xl"
          :data-message-id="item.message.id"
          :data-message-ts="item.message.senderId !== authStore.address ? item.message.timestamp : undefined"
          :style="(item.index ?? 0) > 0 ? { paddingTop: 'var(--message-spacing)' } : {}"
        >
          <div
            class="flex gap-2"
            :class="item.message.senderId === authStore.address ? 'flex-row-reverse' : 'flex-row'"
          >
            <div v-if="item.message.senderId !== authStore.address && themeStore.showAvatarsInChat" class="shrink-0 self-end">
              <UserAvatar :address="item.message.senderId" size="sm" />
            </div>
            <div class="min-w-0 max-w-[80%]">
              <CallEventCard
                :message="item.message"
                :is-own="item.message.senderId === authStore.address"
                :tail-class="item.message.senderId === authStore.address ? 'rounded-br-bubble-sm' : 'rounded-bl-bubble-sm'"
              />
            </div>
          </div>
        </div>

        <!-- System message (join/leave/kick/name change) — not tracked for read watermark -->
        <div
          v-else-if="item.type === 'message' && item.message && item.message.type === MessageType.system"
          class="mx-auto flex max-w-6xl justify-center py-2"
          :data-message-id="item.message.id"
        >
          <span class="rounded-full bg-neutral-grad-0/60 px-3 py-1 text-center text-[11px] text-text-on-main-bg-color">
            {{ resolveSystemMsg(item.message) }}
          </span>
        </div>

        <!-- Message (v-memo skips re-render when message identity + context unchanged) -->
        <div
          v-else-if="item.type === 'message' && item.message"
          v-track-read
          v-memo="[item.id, item.message.timestamp, item.message.deleted, item.message.reactions, item.message.pollInfo, item.message.edited, item.message.status, contextMenu.show && contextMenu.message?.id === item.message.id]"
          :class="[getMsgEnterClass(item.message), { 'context-highlight': contextMenu.show && contextMenu.message?.id === item.message.id }]"
          :style="(item.index ?? 0) > 0 ? { paddingTop: 'var(--message-spacing)' } : {}"
          :data-message-id="item.message.id"
          :data-message-ts="item.message.senderId !== authStore.address ? item.message.timestamp : undefined"
          @animationend="onMsgAnimationEnd(item.message)"
        >
          <div class="mx-auto max-w-6xl">
          <MessageBubble
            :key="((item.message as any)._key || item.message.id) + (item.message.deleted ? '-del' : '')"
            :message="item.message"
            :is-own="item.message.senderId === authStore.address"
            :my-address="authStore.address ?? undefined"
            :is-group="isGroup"
            :show-avatar="themeStore.messageGrouping ? !isConsecutiveMessage(item.message, chatStore.activeMessages[(item.index ?? 0) + 1]) : true"
            :is-first-in-group="themeStore.messageGrouping ? !isConsecutiveMessage(chatStore.activeMessages[(item.index ?? 0) - 1], item.message) : true"
            @contextmenu="openContextMenu"
            @reply="(msg) => { chatStore.replyingTo = { id: msg.id, senderId: msg.senderId, content: msg.content.slice(0, 150), type: msg.type }; }"
            @scroll-to-reply="scrollToMessage"
            @open-media="handleOpenMedia"
            @toggle-reaction="(emoji, messageId) => handleToggleReactionWithEffect(messageId, emoji)"
            @add-reaction="handleOpenEmojiPicker"
            @poll-vote="handlePollVote"
            @poll-end="handlePollEnd"
            @retry-media="retryMediaUpload"
            @retry-message="retryMessage"
            @cancel-upload="cancelMediaUpload"
          >
            <template #avatar>
              <UserAvatar :address="item.message.senderId" size="sm" />
            </template>
          </MessageBubble>
          </div>
        </div>

        <!-- Typing bubble -->
        <div v-else-if="item.type === 'typing'" class="mx-auto max-w-6xl py-1">
          <div class="flex gap-2">
            <div v-if="themeStore.showAvatarsInChat" class="w-8 shrink-0" />
            <TypingBubble :names="typingNames" />
          </div>
        </div>
      </template>
    </ChatVirtualScroller>

    <!-- Context menu -->
    <MessageContextMenu
      :show="contextMenu.show"
      :x="contextMenu.x"
      :y="contextMenu.y"
      :message="contextMenu.message"
      :is-own="contextMenu.isOwn"
      :is-admin="isAdmin"
      :is-pinned="contextMenu.message ? isMessagePinned(contextMenu.message.id) : false"
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

    <ReactionEffect :emoji="lastReactionEmoji" />

    <!-- Scroll-to-bottom FAB with new message badge -->
    <transition name="fab">
      <button
        v-if="showScrollFab"
        class="absolute bottom-4 right-4 flex h-11 w-11 items-center justify-center rounded-full bg-background-total-theme shadow-lg transition-all hover:bg-neutral-grad-0"
        @click="handleFabClick"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-text-on-main-bg-color">
          <polyline points="6 9 12 15 18 9" />
        </svg>
        <!-- New message count badge -->
        <span
          v-if="newMessageCount > 0 || hasBanner()"
          class="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-color-bg-ac px-1 text-[10px] font-medium text-text-on-bg-ac-color"
        >
          {{ fabBadgeCount }}
        </span>
      </button>
    </transition>

    <!-- Return to latest (detached mode) -->
    <transition name="fab">
      <button
        v-if="chatStore.isDetachedFromLatest"
        class="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full bg-color-bg-ac px-4 py-2 text-sm font-medium text-white shadow-lg transition-all hover:bg-color-bg-ac/90"
        @click="handleReturnToLatest"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="6 9 12 15 18 9" />
        </svg>
        {{ t("chat.returnToLatest") }}
      </button>
    </transition>

    <!-- Delete confirmation modal -->
    <Teleport to="body">
      <transition name="modal-fade">
        <div
          v-if="chatStore.deletingMessage || isBulkDelete"
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          @click.self="closeDeleteModal"
        >
          <div class="w-full max-w-xs rounded-xl bg-background-total-theme p-5 shadow-xl">
            <h3 class="mb-4 text-base font-semibold text-text-color">
              {{ isBulkDelete ? t("messageList.deleteMessagesTitle", { count: deleteCount }) : t("messageList.deleteMessage") }}
            </h3>
            <div class="flex flex-col gap-2">
              <button
                class="rounded-lg bg-color-bad px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-color-bad/90"
                @click="handleDeleteForEveryone"
              >
                {{ t("messageList.deleteForEveryone") }}
              </button>
              <button
                class="rounded-lg bg-neutral-grad-0 px-4 py-2.5 text-sm font-medium text-text-color transition-colors hover:bg-neutral-grad-2"
                @click="handleDeleteForMe"
              >
                {{ t("messageList.deleteForMe") }}
              </button>
              <button
                class="rounded-lg px-4 py-2 text-sm text-text-on-main-bg-color transition-colors hover:bg-neutral-grad-0"
                @click="closeDeleteModal"
              >
                {{ t("messageList.cancel") }}
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

.fade-refresh-enter-active,
.fade-refresh-leave-active {
  transition: opacity 0.2s ease;
}
.fade-refresh-enter-from,
.fade-refresh-leave-to {
  opacity: 0;
}

/* Network wait shimmer — moves gradient left→right */
@keyframes shimmer-move {
  0%   { transform: translateX(-100%); }
  100% { transform: translateX(100%); }
}
.animate-shimmer {
  animation: shimmer-move 1.5s ease-in-out infinite;
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
  0%   { background-color: rgba(var(--color-bg-ac-bright), 0.25); }
  40%  { background-color: rgba(var(--color-bg-ac-bright), 0.08); }
  60%  { background-color: rgba(var(--color-bg-ac-bright), 0.2); }
  100% { background-color: transparent; }
}
.search-highlight {
  animation: search-flash 2s ease-out;
  border-radius: 8px;
}

/* Context menu highlight — full-width background */
.context-highlight {
  background-color: rgba(var(--color-bg-ac-rgb, 59, 130, 246), 0.08);
}
</style>
