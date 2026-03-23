import { ref, type Ref } from "vue";
import { useChatStore } from "@/entities/chat";
import { getChatDb, isChatDbReady } from "@/shared/lib/local-db";
import { getMatrixClientService } from "@/entities/matrix";
import { useToast } from "@/shared/lib/use-toast";
import type { Message } from "@/entities/chat/model/types";
import { MessageStatus } from "@/entities/chat/model/types";
import type { LocalMessage } from "@/shared/lib/local-db/schema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScrollTarget {
  messageId: string;
  phase: "check" | "fetch" | "replace" | "layout" | "scroll" | "done" | "fail";
  attempt: number;
}

type VirtualItem = { id: string; message?: Message };

// ---------------------------------------------------------------------------
// LocalMessage → Message mapper
// ---------------------------------------------------------------------------

export function toMessage(lm: LocalMessage): Message {
  const statusMap: Record<string, MessageStatus> = {
    read: MessageStatus.read,
    synced: MessageStatus.sent,
  };

  return {
    id: lm.eventId ?? lm.clientId,
    roomId: lm.roomId,
    senderId: lm.senderId,
    content: lm.content,
    timestamp: lm.timestamp,
    status: statusMap[lm.status] ?? MessageStatus.sending,
    type: lm.type,
    deleted: lm.softDeleted,
    fileInfo: lm.fileInfo,
    replyTo: lm.replyTo,
    reactions: lm.reactions,
    edited: lm.edited,
    forwardedFrom: lm.forwardedFrom,
    callInfo: lm.callInfo,
    pollInfo: lm.pollInfo,
    transferInfo: lm.transferInfo,
    linkPreview: lm.linkPreview,
    systemMeta: lm.systemMeta,
  };
}

// ---------------------------------------------------------------------------
// Composable
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 3;

export function useScrollToMessage(
  virtualItems: Ref<Array<VirtualItem>>,
  scrollerRef: Ref<{ scrollToIndex: (idx: number, opts?: { align?: "start" | "center" | "end" }) => void; getContainerEl?: () => HTMLElement | null } | undefined>,
  getScrollContainer: () => HTMLElement | null,
) {
  const scrollTarget = ref<ScrollTarget | null>(null);
  const chatStore = useChatStore();
  const { toast } = useToast();

  // ---- helpers ----

  /** Search virtualItems for the target message id.
   *  Checks item.id, item.message?.id, and item.message?._key for temp→server id transitions. */
  function findInLoaded(targetId: string): number {
    const items = virtualItems.value;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.id === targetId) return i;
      if (item.message?.id === targetId) return i;
      if ((item.message as Record<string, unknown> | undefined)?._key === targetId) return i;
    }
    return -1;
  }

  /** RAF-based polling for a DOM element with data-message-id. No setTimeout.
   *  Resolves with the element or null after maxWaitMs (~1000ms). */
  function waitForElement(messageId: string, maxWaitMs = 1000): Promise<HTMLElement | null> {
    return new Promise((resolve) => {
      const escaped = CSS.escape(messageId);
      const start = performance.now();

      function poll() {
        const el = document.querySelector<HTMLElement>(`[data-message-id="${escaped}"]`);
        if (el) return resolve(el);
        if (performance.now() - start > maxWaitMs) return resolve(null);
        requestAnimationFrame(poll);
      }

      requestAnimationFrame(poll);
    });
  }

  /** Add highlight CSS class, remove after 2000ms. */
  function highlight(el: HTMLElement) {
    el.classList.add("search-highlight");
    setTimeout(() => el.classList.remove("search-highlight"), 2000);
  }

  /** Fail with a toast and reset state. */
  function fail(reason: string) {
    scrollTarget.value = { ...scrollTarget.value!, phase: "fail" };
    toast(reason, "error");
    scrollTarget.value = null;
  }

  /** Update phase on current target. */
  function setPhase(phase: ScrollTarget["phase"]) {
    if (scrollTarget.value) {
      scrollTarget.value = { ...scrollTarget.value, phase };
    }
  }

  // ---- main flow ----

  async function scrollToMessage(messageId: string) {
    // Cancel any in-progress scroll for a different message
    if (scrollTarget.value && scrollTarget.value.messageId !== messageId && scrollTarget.value.phase !== "fail") {
      scrollTarget.value = null;
    }
    // Dedup: ignore if already processing the same message
    if (scrollTarget.value?.messageId === messageId && scrollTarget.value.phase !== "fail") {
      return;
    }

    scrollTarget.value = { messageId, phase: "check", attempt: 1 };

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      scrollTarget.value = { ...scrollTarget.value!, attempt };

      try {
        // ---- CHECK: is message already loaded? ----
        setPhase("check");
        const loadedIdx = findInLoaded(messageId);
        if (loadedIdx >= 0) {
          await doScroll(loadedIdx, messageId);
          return;
        }

        // ---- FETCH: get message context ----
        setPhase("fetch");

        let contextMessages: LocalMessage[] | null = null;
        let targetIndex = -1;

        // Try Dexie first
        if (isChatDbReady()) {
          const db = getChatDb();
          const ctx = await db.messages.getMessageContext(
            chatStore.activeRoomId!,
            messageId,
          );
          if (ctx) {
            contextMessages = ctx.messages;
            targetIndex = ctx.targetIndex;
          }
        }

        // If not in Dexie, try Matrix server — load timeline around the event
        if (!contextMessages) {
          try {
            const matrixService = getMatrixClientService();
            const roomId = chatStore.activeRoomId!;
            const rawEvents = await matrixService.fetchEventContext(roomId, messageId, 50);

            if (!rawEvents || rawEvents.length === 0) {
              fail("Сообщение не найдено");
              return;
            }

            // fetchEventContext loaded events into the Matrix SDK's timeline.
            // Re-parse the full timeline to update the store and Dexie.
            await chatStore.loadRoomMessages(roomId);

            // Now check if the message is in the loaded list
            await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
            const retryIdx = findInLoaded(messageId);
            if (retryIdx >= 0) {
              await doScroll(retryIdx, messageId);
              return;
            }

            // If still not in virtualItems, try Dexie context (loadRoomMessages wrote to Dexie)
            if (isChatDbReady()) {
              const db = getChatDb();
              const ctx = await db.messages.getMessageContext(roomId, messageId);
              if (ctx) {
                contextMessages = ctx.messages;
                targetIndex = ctx.targetIndex;
              }
            }

            if (!contextMessages) {
              continue; // retry
            }
          } catch (e) {
            console.warn("[scroll-to-message] server fallback error:", e);
            continue;
          }
        }

        // ---- REPLACE: enter detached mode ----
        setPhase("replace");
        const mapped = contextMessages.map(toMessage);
        chatStore.enterDetachedMode(chatStore.activeRoomId!, mapped);

        // ---- LAYOUT: wait for Vue + DynamicScroller render ----
        setPhase("layout");
        await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

        // Find the target in the newly loaded virtualItems
        const newIdx = findInLoaded(messageId);
        if (newIdx < 0 && targetIndex >= 0) {
          // Fallback: use the target index from context
          await doScroll(targetIndex, messageId);
          return;
        }
        if (newIdx < 0) {
          continue; // retry
        }

        await doScroll(newIdx, messageId);
        return;
      } catch (e) {
        console.warn("[scroll-to-message] attempt", attempt, "error:", e);
        if (attempt === MAX_ATTEMPTS) {
          fail("Could not jump to message");
          return;
        }
      }
    }

    // Exhausted all attempts
    fail("Could not jump to message");
  }

  async function doScroll(idx: number, messageId: string) {
    setPhase("scroll");

    const scroller = scrollerRef.value;
    if (!scroller) {
      fail("Scroller not available");
      return;
    }

    scroller.scrollToIndex(idx);

    const el = await waitForElement(messageId);
    if (el) {
      highlight(el);
    }

    scrollTarget.value = null;
  }

  return { scrollToMessage, scrollTarget };
}
