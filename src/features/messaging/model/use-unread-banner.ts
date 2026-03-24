import { ref, readonly, type Ref } from "vue";

export interface UnreadBannerState {
  /** ID of the last read message at room open time. Banner renders AFTER this message.
   *  null = no unread messages, banner not shown. */
  frozenLastReadId: string | null;
  /** Frozen unread count at room open time. Does not update as user reads. */
  frozenUnreadCount: number;
}

/**
 * Frozen watermark composable for the "New messages" banner.
 *
 * The banner position is fixed at room open time and does NOT react to
 * read status changes. This prevents the banner from jumping/disappearing
 * while the user scrolls through unread messages.
 *
 * Dismiss is protected by a grace period: for 2 seconds after freeze,
 * dismissBanner() is a no-op. This prevents checkScroll() from killing
 * the banner before the user sees it (race condition on room switch).
 */
export function useUnreadBanner() {
  const bannerState = ref<UnreadBannerState>({
    frozenLastReadId: null,
    frozenUnreadCount: 0,
  });

  /** Monotonic session counter — prevents stale dismiss callbacks from acting */
  let session = 0;
  /** Whether dismiss is locked (grace period after freeze) */
  let dismissLocked = true;
  let unlockTimer: ReturnType<typeof setTimeout> | null = null;

  /** Called ONCE when a room is opened. Freezes the banner position. */
  function freezeBanner(lastReadId: string | null, unreadCount: number) {
    session++;
    dismissLocked = true;
    if (unlockTimer) {
      clearTimeout(unlockTimer);
      unlockTimer = null;
    }

    bannerState.value = { frozenLastReadId: lastReadId, frozenUnreadCount: unreadCount };

    if (unreadCount > 0 && lastReadId) {
      const capturedSession = session;
      unlockTimer = setTimeout(() => {
        unlockTimer = null;
        // Only unlock if still the same session (room hasn't switched again)
        if (session === capturedSession) dismissLocked = false;
      }, 2000);
    }
  }

  /** Called when user scrolls to bottom. Respects grace period — no-op if locked. */
  function dismissBanner() {
    if (dismissLocked) return;
    session++;
    if (unlockTimer) {
      clearTimeout(unlockTimer);
      unlockTimer = null;
    }
    bannerState.value = { frozenLastReadId: null, frozenUnreadCount: 0 };
  }

  /** Force dismiss — for room leave or explicit user action. Ignores grace period. */
  function forceDismiss() {
    session++;
    dismissLocked = true;
    if (unlockTimer) {
      clearTimeout(unlockTimer);
      unlockTimer = null;
    }
    bannerState.value = { frozenLastReadId: null, frozenUnreadCount: 0 };
  }

  /** Whether the banner should be visible */
  function hasBanner(): boolean {
    return bannerState.value.frozenLastReadId !== null && bannerState.value.frozenUnreadCount > 0;
  }

  return {
    bannerState: readonly(bannerState) as Readonly<Ref<UnreadBannerState>>,
    freezeBanner,
    dismissBanner,
    forceDismiss,
    hasBanner,
  };
}
