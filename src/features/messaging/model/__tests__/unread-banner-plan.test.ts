/**
 * WEE-95 A3 — unread banner must come from the cached watermark + the
 * pre-open count snapshot (setActiveRoom zeroes the badge synchronously
 * BEFORE the banner computes), without a full message scan or avoidable
 * I/O on the render path.
 */
import { describe, it, expect, vi } from "vitest";
import { resolveUnreadBannerPlan } from "../unread-banner-plan";

const makeSources = (overrides: Partial<Parameters<typeof resolveUnreadBannerPlan>[0]> = {}) => ({
  cachedRoom: undefined as { lastReadInboundTs: number } | undefined,
  preOpenUnreadCount: undefined as number | undefined,
  getRoom: vi.fn(async () => undefined),
  countUnreadAfter: vi.fn(async () => 0),
  getLastMessageAtOrBefore: vi.fn(async () => undefined),
  ...overrides,
});

describe("resolveUnreadBannerPlan (WEE-95)", () => {
  it("hot path is I/O-free: cached watermark + pre-open snapshot, no Dexie reads", async () => {
    const sources = makeSources({
      cachedRoom: { lastReadInboundTs: 5000 },
      preOpenUnreadCount: 0,
    });

    const plan = await resolveUnreadBannerPlan(sources);

    expect(sources.getRoom).not.toHaveBeenCalled();
    expect(sources.countUnreadAfter).not.toHaveBeenCalled();
    expect(plan.scrollToBanner).toBe(false);
    expect(plan.needsBootstrap).toBe(false);
  });

  it("uses the pre-open snapshot, NOT a recount — badge was already zeroed by setActiveRoom", async () => {
    const sources = makeSources({
      cachedRoom: { lastReadInboundTs: 7777 },
      preOpenUnreadCount: 4,
      getLastMessageAtOrBefore: vi.fn(async () => ({ eventId: "$anchor", clientId: "c9" })),
    });

    const plan = await resolveUnreadBannerPlan(sources);

    expect(sources.countUnreadAfter).not.toHaveBeenCalled();
    expect(sources.getLastMessageAtOrBefore).toHaveBeenCalledWith(7777);
    expect(plan).toEqual({
      lastReadId: "$anchor",
      unreadCount: 4,
      scrollToBanner: true,
      needsBootstrap: false,
    });
  });

  it("cold boot (no snapshot): falls back to an honest recount from messages", async () => {
    // Deep-link open before setActiveRoom snapshotted anything — the Dexie
    // unreadCount field may already be zeroed by clearUnread, so the count
    // must come from the messages themselves.
    const sources = makeSources({
      cachedRoom: undefined,
      preOpenUnreadCount: undefined,
      getRoom: vi.fn(async () => ({ lastReadInboundTs: 5000 })),
      countUnreadAfter: vi.fn(async () => 3),
      getLastMessageAtOrBefore: vi.fn(async () => ({ eventId: "$last", clientId: "c1" })),
    });

    const plan = await resolveUnreadBannerPlan(sources);

    expect(sources.getRoom).toHaveBeenCalledTimes(1);
    expect(sources.countUnreadAfter).toHaveBeenCalledWith(5000);
    expect(plan).toEqual({
      lastReadId: "$last",
      unreadCount: 3,
      scrollToBanner: true,
      needsBootstrap: false,
    });
  });

  it("no watermark → bootstrap needed, no count/anchor queries (off the render path)", async () => {
    const sources = makeSources({
      cachedRoom: { lastReadInboundTs: 0 },
      preOpenUnreadCount: 7,
    });

    const plan = await resolveUnreadBannerPlan(sources);

    expect(plan.needsBootstrap).toBe(true);
    expect(plan.scrollToBanner).toBe(false);
    expect(sources.countUnreadAfter).not.toHaveBeenCalled();
    expect(sources.getLastMessageAtOrBefore).not.toHaveBeenCalled();
  });

  it("zero unread → no banner and NO anchor query", async () => {
    const sources = makeSources({
      cachedRoom: { lastReadInboundTs: 5000 },
      preOpenUnreadCount: 0,
    });

    const plan = await resolveUnreadBannerPlan(sources);

    expect(plan.scrollToBanner).toBe(false);
    expect(plan.unreadCount).toBe(0);
    expect(sources.getLastMessageAtOrBefore).not.toHaveBeenCalled();
  });

  it("snapshot of 0 wins over a non-zero recount (read on another device)", async () => {
    // Multi-device: everything was read on device A; server reconciliation
    // already set the badge to 0 before the user tapped the room here.
    const sources = makeSources({
      cachedRoom: { lastReadInboundTs: 5000 },
      preOpenUnreadCount: 0,
      countUnreadAfter: vi.fn(async () => 12), // stale local watermark would say 12
    });

    const plan = await resolveUnreadBannerPlan(sources);

    expect(plan.scrollToBanner).toBe(false);
    expect(sources.countUnreadAfter).not.toHaveBeenCalled();
  });

  it("anchor falls back to clientId, then to null when message is gone", async () => {
    const pendingOnly = makeSources({
      cachedRoom: { lastReadInboundTs: 100 },
      preOpenUnreadCount: 1,
      getLastMessageAtOrBefore: vi.fn(async () => ({ eventId: null, clientId: "c42" })),
    });
    expect((await resolveUnreadBannerPlan(pendingOnly)).lastReadId).toBe("c42");

    const missing = makeSources({
      cachedRoom: { lastReadInboundTs: 100 },
      preOpenUnreadCount: 1,
      getLastMessageAtOrBefore: vi.fn(async () => undefined),
    });
    const plan = await resolveUnreadBannerPlan(missing);
    // Banner still shows (count is known), anchor just can't be matched
    expect(plan.lastReadId).toBeNull();
    expect(plan.scrollToBanner).toBe(true);
  });
});
