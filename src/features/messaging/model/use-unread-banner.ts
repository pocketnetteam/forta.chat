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
 */
export function useUnreadBanner() {
  const bannerState = ref<UnreadBannerState>({
    frozenLastReadId: null,
    frozenUnreadCount: 0,
  });

  /** Called ONCE when a room is opened. Freezes the banner position. */
  function freezeBanner(lastReadId: string | null, unreadCount: number) {
    bannerState.value = { frozenLastReadId: lastReadId, frozenUnreadCount: unreadCount };
  }

  /** Called when user scrolls to bottom or leaves the room. */
  function dismissBanner() {
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
    hasBanner,
  };
}
