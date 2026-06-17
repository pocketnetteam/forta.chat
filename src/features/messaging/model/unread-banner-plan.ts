import type { LocalRoom, LocalMessage } from "@/shared/lib/local-db";

/** Decision for the unread banner on room open (WEE-95). */
export interface UnreadBannerPlan {
  /** Stable id of the last read message — banner anchor (may be null when
   *  the anchor message fell out of the local window) */
  lastReadId: string | null;
  unreadCount: number;
  /** True when the banner should be frozen and scrolled to */
  scrollToBanner: boolean;
  /** Room has no read watermark yet — needs a first-visit bootstrap
   *  (caller runs it fire-and-forget, off the render path) */
  needsBootstrap: boolean;
}

export interface UnreadBannerSources {
  /** Sync in-memory LocalRoom from chat-store's dexieRoomMap — preferred,
   *  zero I/O. Only the watermark is read from here: setActiveRoom does NOT
   *  touch lastReadInboundTs (it advances later via the read tracker). */
  cachedRoom: Pick<LocalRoom, "lastReadInboundTs"> | undefined;
  /** Unread count snapshotted by setActiveRoom BEFORE it zeroes the badge.
   *  The cached/Dexie unreadCount cannot be trusted here — by the time the
   *  banner computes, setActiveRoom has already cleared it synchronously
   *  (sidebar UX). The snapshot is server-reconciled (same value as the badge
   *  the user just tapped), so multi-device reads are reflected. */
  preOpenUnreadCount: number | undefined;
  /** Async Dexie fallback when the in-memory cache has no entry yet (cold boot) */
  getRoom: () => Promise<Pick<LocalRoom, "lastReadInboundTs"> | undefined>;
  /** Honest unread recount from messages (index scan) — only used when no
   *  pre-open snapshot exists (cold-boot deep link), where the zeroed Dexie
   *  field would otherwise hide the banner. Rare path, scan cost acceptable. */
  countUnreadAfter: (watermarkTs: number) => Promise<number>;
  /** Anchor lookup — cheap [roomId+timestamp] limit(1) point query */
  getLastMessageAtOrBefore: (
    watermarkTs: number,
  ) => Promise<Pick<LocalMessage, "eventId" | "clientId"> | undefined>;
}

const noBanner = (needsBootstrap: boolean): UnreadBannerPlan => ({
  lastReadId: null,
  unreadCount: 0,
  scrollToBanner: false,
  needsBootstrap,
});

/**
 * Resolve the unread-banner plan for a room being opened.
 *
 * WEE-95: previously this path always scanned the room's messages with
 * `countInboundAfter()` (a JS-filter pass — 100-500ms on 10k+ message rooms)
 * before the first render. The common path is now fully synchronous (cached
 * watermark + pre-open count snapshot); the scan survives only as the
 * cold-boot fallback, and the only other await is the cheap anchor
 * point-query when there actually are unread messages.
 */
export async function resolveUnreadBannerPlan(
  sources: UnreadBannerSources,
): Promise<UnreadBannerPlan> {
  const room = sources.cachedRoom ?? (await sources.getRoom());
  const watermarkTs = room?.lastReadInboundTs ?? 0;

  if (watermarkTs <= 0) return noBanner(true);

  const unreadCount =
    sources.preOpenUnreadCount ?? (await sources.countUnreadAfter(watermarkTs));
  if (unreadCount <= 0) return noBanner(false);

  const lastReadMsg = await sources.getLastMessageAtOrBefore(watermarkTs);
  return {
    lastReadId: lastReadMsg?.eventId ?? lastReadMsg?.clientId ?? null,
    unreadCount,
    scrollToBanner: true,
    needsBootstrap: false,
  };
}
