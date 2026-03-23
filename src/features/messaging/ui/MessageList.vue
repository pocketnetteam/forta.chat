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
import { VList } from "virtua/vue";
import { useUnreadBanner } from "../model/use-unread-banner";
import { useReadTracker } from "../model/use-read-tracker";
import UnreadBanner from "./UnreadBanner.vue";

const chatStore = useChatStore();
const authStore = useAuthStore();
const themeStore = useThemeStore();
const { loadMessages, toggleReaction, deleteMessage, votePoll, endPoll, retryMediaUpload } = useMessages();
const { toast } = useToast();
const { t } = useI18n();

const { bannerState, freezeBanner, dismissBanner, hasBanner } = useUnreadBanner();

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
      chatStore.enterSelectionMode(message.id);
      chatStore.forwardingMessages = true;
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
const scrollerRef = ref<InstanceType<typeof VList>>();
const isNearBottom = ref(true);
const showScrollFab = ref(false);
const loading = ref(false);
const loadingMore = ref(false);
const switching = ref(false); // true during room switch — suppresses watchers
const settled = ref(false); // false until messages loaded + scrolled — hides scroller to prevent flicker
const refreshingStaleCache = ref(false); // true when showing stale cached messages while fresh data loads
const hasMore = ref(true);
const newMessageCount = ref(0);

const fabBadgeCount = computed(() => {
  const c = hasBanner() ? bannerState.value.frozenUnreadCount : newMessageCount.value;
  return c > 99 ? '99+' : c;
});

// --- Predictive prefetch state ---
const LOAD_THRESHOLD = 1200; // px from top — expand Dexie window
const PREFETCH_THRESHOLD = 2500; // px from top — background cache fill
const VELOCITY_BOOST_THRESHOLD = 1500; // px/s — fast scroll triggers early thresholds
const networkWaiting = ref(false); // true when Dexie cache exhausted, waiting for network
let prefetchInFlight = false; // background prefetch lock (non-reactive — no UI effect)

/** Explicit shift mode lock — enabled ONLY while prepending older messages.
 *  Virtua shift tells the virtualizer that items were added at the START,
 *  so it auto-corrects scrollTop. We enable this around expand/load operations
 *  and disable immediately after DOM settles.
 *  MUST be false when appending (new messages, typing indicator). */
const shiftModeLock = ref(false);
const shiftMode = computed(() => shiftModeLock.value);
let lastScrollTop = 0;
let lastScrollTime = 0;
let scrollVelocity = 0; // px per second (positive = scrolling up)

/** Flatten messages + date separators into a single virtual list */
interface VirtualItem {
  id: string;
  type: "message" | "date-separator" | "typing" | "unread-banner";
  message?: import("@/entities/chat").Message;
  label?: string;
  index?: number;
  unreadCount?: number;
}

const virtualItems = computed<VirtualItem[]>(() => {
  const msgs = chatStore.activeMessages;
  const items: VirtualItem[] = [];
  const { frozenLastReadId, frozenUnreadCount } = bannerState.value;

  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i];

    // Skip ghost messages: no content, no media, not deleted, not system
    if (
      !msg.deleted &&
      !msg.content &&
      !msg.fileInfo &&
      !msg.pollInfo &&
      !msg.callInfo &&
      !msg.transferInfo &&
      msg.type !== "system"
    ) {
      if (import.meta.env.DEV) {
        console.warn("[MessageList] ghost message filtered:", msg.id, msg.senderId, msg.status);
      }
      continue;
    }

    const prevMsg = msgs[i - 1];
    const dateLabel = getDateLabel(msg.timestamp, prevMsg?.timestamp);

    if (dateLabel) {
      const stableId = (msg as any)._key || msg.id;
      items.push({ id: `date-${stableId}`, type: "date-separator", label: dateLabel });
    }

    // Use _key (stable across tempId→serverId rename) for consistent item identity.
    items.push({ id: (msg as any)._key || msg.id, type: "message", message: msg, index: i });

    // Insert unread banner AFTER the last read message
    if (frozenLastReadId && msg.id === frozenLastReadId && frozenUnreadCount > 0) {
      items.push({ id: "unread-banner", type: "unread-banner", unreadCount: frozenUnreadCount });
    }
  }

  // Typing indicator
  if (typingText.value) {
    items.push({ id: "typing-indicator", type: "typing" });
  }

  return items;
});

/** Get the actual scroll container (VList's root element has overflow-y: auto). */
const getScrollContainer = (): HTMLElement | null => {
  const el = scrollerRef.value?.$el as HTMLElement | undefined;
  if (el) return el;
  return listRef.value ?? null;
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
  virtualItems,
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

/** Grace period: don't auto-dismiss banner right after room open.
 *  The banner may be near the bottom of a short message list, and the
 *  initial checkScroll() would immediately dismiss it before the user sees it. */
let bannerDismissAllowed = false;

/** Check if user is scrolled near the bottom */
const checkScroll = () => {
  const el = getScrollContainer();
  if (!el) return;
  const { scrollTop, scrollHeight, clientHeight } = el;
  const distFromBottom = scrollHeight - scrollTop - clientHeight;
  isNearBottom.value = distFromBottom < 100;
  showScrollFab.value = distFromBottom > 300;
  if (isNearBottom.value) {
    newMessageCount.value = 0;
    if (hasBanner() && bannerDismissAllowed) dismissBanner();
  }
};

let scrollBottomTimer: ReturnType<typeof setTimeout> | undefined;
let scrollRafId1: number | undefined;
let pendingScrollToBottom = false;
let pendingOnSettled: (() => void) | undefined;
let scrollStableTimer: ReturnType<typeof setTimeout> | undefined;
let scrollStableRaf: number | undefined;
const scrollToBottom = (_smooth = false, onSettled?: () => void) => {
  newMessageCount.value = 0;

  // Cancel any pending operations from a previous call
  clearTimeout(scrollBottomTimer);
  clearTimeout(scrollStableTimer);
  if (scrollRafId1 != null) cancelAnimationFrame(scrollRafId1);
  if (scrollStableRaf != null) cancelAnimationFrame(scrollStableRaf);

  const doScroll = () => {
    const el = getScrollContainer();
    if (el) {
      el.scrollTop = el.scrollHeight + 9999;
    }
  };

  // Activate event-driven mode: contentResizeObserver will keep
  // scrolling to bottom on every resize until content stabilises.
  pendingScrollToBottom = true;
  pendingOnSettled = onSettled;

  // Immediate scroll on next tick (handles fast/static content)
  nextTick(() => {
    // First pass: ask Virtua to position the last item at the viewport end.
    // This forces it to recalculate offsets from its (possibly stale) cache,
    // which is still better than raw scrollTop that ignores Virtua entirely.
    const items = virtualItems.value;
    if (items.length > 0 && scrollerRef.value) {
      scrollerRef.value.scrollToIndex(items.length - 1, { align: "end" });
    } else {
      doScroll();
    }
    // One rAF pass for layout that settles within a single frame
    scrollRafId1 = requestAnimationFrame(() => {
      doScroll(); // overshoot fallback — catches any measurement lag
      // Start the stability window — if no resize fires within 300ms,
      // content has stabilised and we can stop.
      resetStableTimer(onSettled);
    });
  });
};

/** Reset the stability timer. Called after every content resize while
 *  pendingScrollToBottom is true. When 300ms pass without a resize,
 *  we consider the content stable and stop auto-scrolling. */
const resetStableTimer = (onSettled?: () => void) => {
  if (onSettled) pendingOnSettled = onSettled;
  clearTimeout(scrollStableTimer);
  scrollStableTimer = setTimeout(() => {
    pendingScrollToBottom = false;
    pendingOnSettled?.();
    pendingOnSettled = undefined;
  }, 300);
};

/** Micro-nudge scrollTop to force virtua to recalculate item offsets.
 *  Used when an individual item's height changes (image load, etc.)
 *  and we're NOT in a pendingScrollToBottom flow. */
const nudgeVirtua = () => {
  if (pendingScrollToBottom) return; // already handled by stable scroll
  const el = getScrollContainer();
  if (!el) return;
  // A 0.5px scroll jitter is invisible but forces layout recalc.
  const before = el.scrollTop;
  el.scrollTop = before + 0.5;
  requestAnimationFrame(() => {
    if (el) el.scrollTop = before;
  });
};

/** Two-step FAB: first press → first unread, second press → bottom */
const handleFabClick = () => {
  if (hasBanner()) {
    const bannerIdx = virtualItems.value.findIndex(item => item.type === "unread-banner");
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
    refreshingStaleCache.value = false;
    newMessageCount.value = 0;
    prevScrollHeight = 0;
    hasMore.value = true;
    showScrollFab.value = false;
    showDateHeader.value = false;
    recentMessageIds.value.clear();
    isNearBottom.value = true;
    prefetchInFlight = false;
    networkWaiting.value = false;
    shiftModeLock.value = false;
    bannerDismissAllowed = false;
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
    dismissBanner();
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

      if (import.meta.env.DEV) {
        console.log("[unread-banner] roomId=%s watermarkTs=%d myAddr=%s", roomId, watermarkTs, myAddr);
      }

      if (watermarkTs > 0) {
        const unreadCount = await dbKit.messages.countInboundAfter(roomId, watermarkTs, myAddr);
        if (isStale()) return;

        if (import.meta.env.DEV) {
          console.log("[unread-banner] unreadCount=%d", unreadCount);
        }

        if (unreadCount > 0) {
          const lastReadMsg = await dbKit.messages.getLastMessageAtOrBefore(roomId, watermarkTs);
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
        const latestMsg = await dbKit.messages.getLastNonDeleted(roomId);
        if (isStale()) return;
        if (latestMsg && latestMsg.timestamp > 0) {
          await dbKit.rooms.markAsRead(roomId, latestMsg.timestamp);
        }
      }
    }

    // If no anchor was set, do normal load
    if (anchorItemIndex === -1 && chatStore.activeMessages.length === 0) {
      const cacheAge = await chatStore.loadCachedMessages(roomId);
      if (isStale()) return;

      if (chatStore.chatDbKitRef && !chatStore.dexieMessagesReady) {
        const readyDeadline = Date.now() + 200;
        while (!chatStore.dexieMessagesReady && Date.now() < readyDeadline) {
          await new Promise(r => setTimeout(r, 10));
          if (isStale()) return;
        }
      }

      const hasCached = chatStore.activeMessages.length > 0;
      const STALE_THRESHOLD = 60_000;

      if (!hasCached) {
        loading.value = true;
        try {
          await loadMessages(roomId);
        } catch { /* ignore */ }
        if (isStale()) return;

        if (chatStore.activeMessages.length === 0) {
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
        loading.value = false;
      } else if (cacheAge > STALE_THRESHOLD) {
        refreshingStaleCache.value = true;
        loadMessages(roomId).catch(() => {}).finally(() => { refreshingStaleCache.value = false; });
      } else {
        loadMessages(roomId).catch(() => {});
      }
    }

    if (isStale()) return;

    // ═══ PHASE 3: RENDER + SCROLL ═══
    await nextTick();
    if (isStale()) return;
    await nextTick();
    if (isStale()) return;

    requestAnimationFrame(() => {
      if (isStale()) return;

      const el = getScrollContainer();
      if (scrollToBanner && hasBanner()) {
        const bannerIdx = virtualItems.value.findIndex(item => item.type === "unread-banner");
        if (import.meta.env.DEV) {
          console.log("[unread-banner] PHASE3 bannerIdx=%d items=%d", bannerIdx, virtualItems.value.length);
        }
        if (bannerIdx >= 0) {
          scrollerRef.value?.scrollToIndex(bannerIdx, { align: "start" });
        } else if (el) {
          el.scrollTop = el.scrollHeight + 9999;
        }
      } else if (el) {
        el.scrollTop = el.scrollHeight + 9999;
      }

      // ═══ PHASE 4: REVEAL ═══
      settled.value = true;
      switching.value = false;
      prevScrollHeight = el?.scrollHeight ?? 0;
      checkScroll();

      // Allow banner dismissal after user has had time to see it
      setTimeout(() => { bannerDismissAllowed = true; }, 2000);

      // Start read tracking with container polling instead of fixed timeout.
      // getScrollContainer() may return null if VList hasn't created its
      // internal scroll element yet — poll until available (max ~1s).
      const startReadTracking = async () => {
        const MAX_ATTEMPTS = 20;
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

// Track the last message's identity to detect real appends
// (replaces unreliable length-based watcher that missed setMessages replacements)
const lastMessageIdentity = computed(() => {
  const msgs = chatStore.activeMessages;
  if (!msgs.length) return null;
  const last = msgs[msgs.length - 1];
  // Use _key (clientId, stable) instead of id (flips clientId→eventId after confirmSent)
  // to avoid false triggers when message status changes.
  const stableId = (last as any)._key || last.id;
  return `${stableId}:${msgs.length}`;
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

/**
 * Wait for DOM to fully settle after adding messages — nextTick alone is not enough
 * because ResizeObserver may fire AFTER Vue's DOM patch.
 * Double rAF guarantees the browser has painted and observers have run.
 */
const waitForDomSettle = (): Promise<void> =>
  new Promise((resolve) => {
    nextTick(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve());
      });
    });
  });

/** Expand-first load: try Dexie cache first, fall back to network.
 *  Relies on Virtua's shift mode for scroll position preservation
 *  instead of manual scrollTop correction. */
const doLoadMore = async (roomId: string): Promise<void> => {
  if (loadingMore.value) return;
  loadingMore.value = true;
  shiftModeLock.value = true;

  try {
    const prevLen = chatStore.activeMessages.length;

    // Step 1: Expand Dexie query window — instant if cache has data
    chatStore.expandMessageWindow();
    await waitForDomSettle();

    if (chatStore.activeRoomId !== roomId) return;
    const newLen = chatStore.activeMessages.length;

    // Step 2: If Dexie had no more messages, fetch from network
    if (newLen <= prevLen && hasMore.value) {
      networkWaiting.value = true;
      const more = await chatStore.loadMoreMessages(roomId);
      hasMore.value = more;

      if (more && chatStore.activeRoomId === roomId) {
        // loadMoreMessages wrote to Dexie — expand window to show them
        chatStore.expandMessageWindow();
        await waitForDomSettle();
      }
      networkWaiting.value = false;
    }
  } catch {
    networkWaiting.value = false;
  } finally {
    // Let Virtua finish its shift correction before disabling
    await waitForDomSettle();
    shiftModeLock.value = false;
    loadingMore.value = false;
  }
};

/** True background prefetch: fills Dexie cache silently with NO UI side effects.
 *  Does not touch loadingMore, shiftMode, scrollTop, or any reactive state
 *  that would cause visible changes. When the user scrolls further up,
 *  expandMessageWindow() will find the data already in Dexie. */
const triggerPrefetch = (roomId: string) => {
  if (prefetchInFlight || loadingMore.value || !hasMore.value) return;
  prefetchInFlight = true;
  chatStore.prefetchOlderToCache(roomId)
    .then(more => { hasMore.value = more; })
    .catch(() => {})
    .finally(() => { prefetchInFlight = false; });
};

/** Load newer messages (forward pagination in detached mode).
 *  Uses its own flag (loadingNewer) instead of loadingMore because newer
 *  messages are APPENDED — shiftMode must stay false during this operation. */
const loadingNewer = ref(false);
const doLoadNewer = async (roomId: string) => {
  if (!isChatDbReady() || loadingNewer.value || loadingMore.value) return;
  loadingNewer.value = true;
  try {
    const msgs = chatStore.activeMessages;
    if (msgs.length === 0) return;

    const lastTimestamp = msgs[msgs.length - 1].timestamp;
    const { messages: msgRepo } = getChatDb();
    const newer = await msgRepo.getMessagesAfter(roomId, lastTimestamp, 50);

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

let scrollThrottleRaf: number | null = null;

const onScroll = () => {
  if (switching.value) return;

  // Throttle via rAF — at most once per frame (~16ms)
  if (scrollThrottleRaf !== null) return;
  scrollThrottleRaf = requestAnimationFrame(() => {
    scrollThrottleRaf = null;
    onScrollThrottled();
  });
};

/** VList @scroll handler — adapts virtua's offset-based callback to our scroll logic */
const onVListScroll = (_offset: number) => {
  onScroll();
};

const onScrollThrottled = () => {
  if (switching.value) return;
  checkScroll();
  updateFloatingDate();

  const container = getScrollContainer();
  if (!container) return;
  const { scrollTop } = container;

  // Calculate scroll velocity (positive means scrolling up)
  const now = performance.now();
  if (lastScrollTime > 0) {
    const dt = (now - lastScrollTime) / 1000; // seconds
    if (dt > 0) {
      scrollVelocity = (lastScrollTop - scrollTop) / dt; // px/s, positive = up
    }
  }
  lastScrollTop = scrollTop;
  lastScrollTime = now;

  const roomId = chatStore.activeRoomId;
  if (!roomId) return;

  // Forward pagination in detached mode
  if (chatStore.isDetachedFromLatest) {
    const distFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distFromBottom < LOAD_THRESHOLD && !loadingNewer.value) {
      doLoadNewer(roomId);
    }
  }

  if (!hasMore.value) return;

  // Velocity-adaptive thresholds — fast scroll triggers earlier
  const speed = Math.abs(scrollVelocity);
  const effectiveLoadThreshold = speed > 3000 ? 3000
    : speed > VELOCITY_BOOST_THRESHOLD ? 2000
    : LOAD_THRESHOLD;
  const effectivePrefetchThreshold = speed > 3000 ? 6000
    : speed > VELOCITY_BOOST_THRESHOLD ? 4000
    : PREFETCH_THRESHOLD;

  // Background prefetch zone — silently fill Dexie cache, no UI effect
  if (scrollTop < effectivePrefetchThreshold && scrollVelocity > 0) {
    triggerPrefetch(roomId);
  }

  // Primary expand zone — expand Dexie window (instant from cache)
  if (scrollTop < effectiveLoadThreshold && !loadingMore.value) {
    doLoadMore(roomId);
  }
};

let scrollListenEl: HTMLElement | null = null;
let contentResizeObserver: ResizeObserver | null = null;
let containerResizeObserver: ResizeObserver | null = null;
let prevContainerHeight = 0;
let prevScrollHeight = 0;
let isMounted = true;

const attachScrollListener = () => {
  // Detach from old element if any
  if (scrollListenEl) {
    scrollListenEl.removeEventListener("scroll", onScroll);
    scrollListenEl = null;
  }
  if (contentResizeObserver) {
    contentResizeObserver.disconnect();
    contentResizeObserver = null;
  }
  if (containerResizeObserver) {
    containerResizeObserver.disconnect();
    containerResizeObserver = null;
  }
  nextTick(() => {
    scrollListenEl = getScrollContainer();
    scrollListenEl?.addEventListener("scroll", onScroll, { passive: true });

    // Watch for content height changes (images loading, posts expanding, etc.)
    // When near bottom, auto-scroll to compensate for layout shifts.
    if (scrollListenEl) {
      prevScrollHeight = scrollListenEl.scrollHeight;
      contentResizeObserver = new ResizeObserver(() => {
        if (!isMounted) return;
        const el = scrollListenEl;
        if (!el || switching.value) return;

        // Skip auto-scroll while loading older messages or user is scrolled up
        if (loadingMore.value || shiftModeLock.value || !isNearBottom.value) {
          prevScrollHeight = el.scrollHeight;
          return;
        }

        const newHeight = el.scrollHeight;
        if (newHeight === prevScrollHeight) return;
        prevScrollHeight = newHeight;

        // Event-driven scroll: content just resized (image loaded, reply
        // preview rendered, reaction added). If we're in a pending scroll
        // or simply near the bottom, scroll down and reset the stability timer.
        if (pendingScrollToBottom || isNearBottom.value) {
          if (scrollStableRaf != null) cancelAnimationFrame(scrollStableRaf);
          scrollStableRaf = requestAnimationFrame(() => {
            el.scrollTop = el.scrollHeight + 9999;
            scrollStableRaf = undefined;
          });

          // If in pending mode, extend the stability window
          if (pendingScrollToBottom) {
            resetStableTimer();
          }
        }
      });
      // Observe the INNER content wrapper of VList (not the scroll container itself).
      // ResizeObserver on the scroll container only fires when the container's own
      // dimensions change. The inner div changes height when items resize (reactions,
      // images loading), which is what we actually need to track.
      const contentEl = scrollListenEl.firstElementChild as HTMLElement | null;
      contentResizeObserver.observe(contentEl ?? scrollListenEl);
    }

    // Watch for container height changes (reply bar, edit bar, link preview, etc.)
    // When the input area grows, the message list shrinks — adjust scrollTop so
    // the same messages stay visible (Telegram-style stable viewport).
    if (listRef.value) {
      prevContainerHeight = listRef.value.clientHeight;
      containerResizeObserver = new ResizeObserver(() => {
        if (!isMounted) return;
        const container = listRef.value;
        const scrollEl = getScrollContainer();
        if (!container || !scrollEl || switching.value) return;
        const newHeight = container.clientHeight;
        if (newHeight === prevContainerHeight) return;
        const delta = prevContainerHeight - newHeight; // positive when container shrinks
        prevContainerHeight = newHeight;
        if (delta > 0) {
          // Container shrank (e.g. reply bar appeared) — scroll down to keep content stable
          scrollEl.scrollTop += delta;
        } else if (isNearBottom.value) {
          // Container grew (e.g. reply bar removed) and we were near bottom — stay at bottom
          scrollEl.scrollTop = scrollEl.scrollHeight + 9999;
        }
      });
      containerResizeObserver.observe(listRef.value);
    }
  });
};

onMounted(() => {
  // Don't call scrollToBottom() here — watch(activeRoomId, { immediate: true })
  // already handles it. A competing call from onMounted would cancel the watch's
  // onSettled callback (which sets switching=false), causing switching to stay
  // true indefinitely and breaking subsequent scroll behavior.
  attachScrollListener();
});

// Re-attach scroll listener when scroller appears/changes (e.g. room switch from empty → messages)
// Also acts as a safety net: if the main watch couldn't set settled=true (e.g. because
// the scroller wasn't mounted yet during the first immediate invocation), finalize here.
watch(
  () => scrollerRef.value,
  (scroller) => {
    attachScrollListener();
    if (scroller && !settled.value && !loading.value) {
      nextTick(() => {
        // Double-check: settled may have been set by the main watch in the meantime
        if (settled.value) return;
        const el = getScrollContainer();
        if (el) el.scrollTop = el.scrollHeight + 9999;
        settled.value = true;
        switching.value = false;
        prevScrollHeight = el?.scrollHeight ?? 0;
        checkScroll();
      });
    }
  },
);

onUnmounted(() => {
  isMounted = false;
  readTracker.stopTracking();
  if (scrollListenEl) {
    scrollListenEl.removeEventListener("scroll", onScroll);
  }
  if (contentResizeObserver) {
    contentResizeObserver.disconnect();
  }
  if (containerResizeObserver) {
    containerResizeObserver.disconnect();
  }
  if (scrollThrottleRaf !== null) {
    cancelAnimationFrame(scrollThrottleRaf);
  }
  clearTimeout(dateHideTimer);
  clearTimeout(scrollBottomTimer);
  clearTimeout(scrollStableTimer);
  if (scrollRafId1 != null) cancelAnimationFrame(scrollRafId1);
  if (scrollStableRaf != null) cancelAnimationFrame(scrollStableRaf);
  pendingScrollToBottom = false;
  pendingOnSettled = undefined;
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

/** When typing indicator toggles and the total virtualItems length stays the
 *  same (typing removed + message added in the same reactive flush), the item
 *  at the last index swaps from TypingBubble (~48px) to MessageBubble (~100-200px)
 *  but Virtua keeps the old cached height for that index.  Nudge forces a
 *  remeasure so the layout doesn't show a brief overlap. */
watch(typingText, (cur, prev) => {
  const appeared = !prev && !!cur;
  const disappeared = !!prev && !cur;
  if ((appeared || disappeared) && !pendingScrollToBottom) {
    nextTick(() => nudgeVirtua());
  }
});

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
          <span class="inline-block h-3 w-3 animate-spin rounded-full border-[1.5px] border-text-on-main-bg-color border-t-transparent" />
          {{ t("chat.updatingMessages") }}
        </span>
      </div>
    </transition>

    <!-- Loading state: skeleton ONLY on initial room load when no messages exist yet.
         Never during pagination (expandMessageWindow / loadMoreMessages) to avoid skeleton flash. -->
    <MessageSkeleton v-if="(loading || switching) && chatStore.activeMessages.length === 0" />

    <!-- Empty state (only after fully loaded + settled, not during switching) -->
    <div
      v-if="!loading && !switching && chatStore.activeMessages.length === 0 && settled"
      class="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 text-text-on-main-bg-color"
    >
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" class="opacity-20">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
      <span class="text-sm">No messages yet. Start a conversation!</span>
    </div>

    <!-- Virtualized Messages (virtua VList — zero-config dynamic heights, no recycling bugs) -->
    <VList
      v-if="!loading"
      ref="scrollerRef"
      :data="virtualItems"
      :shift="shiftMode"
      class="h-full overscroll-contain px-4 py-3"
      :style="{ opacity: settled ? 1 : 0, transition: settled ? 'opacity 0.1s ease-out' : 'none' }"
      @scroll="onVListScroll"
    >
      <template #default="{ item, index }">
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

        <!-- Message -->
        <div
          v-else-if="item.type === 'message' && item.message"
          v-track-read
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
            @resize="nudgeVirtua"
            @retry-media="retryMediaUpload"
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
    </VList>

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
  transition: background-color 0.15s ease;
}
</style>
