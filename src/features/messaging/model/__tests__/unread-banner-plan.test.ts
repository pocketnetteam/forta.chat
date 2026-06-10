/**
 * WEE-95 A3 — unread banner must come from the cached room record
 * (dexieRoomMap), not from a full message scan, and must not block
 * the first render with avoidable I/O.
 */
import { describe, it, expect, vi } from "vitest";
import { resolveUnreadBannerPlan } from "../unread-banner-plan";

const makeSources = (overrides: Partial<Parameters<typeof resolveUnreadBannerPlan>[0]> = {}) => ({
  cachedRoom: undefined as { unreadCount: number; lastReadInboundTs: number } | undefined,
  getRoom: vi.fn(async () => undefined),
  getLastMessageAtOrBefore: vi.fn(async () => undefined),
  ...overrides,
});

describe("resolveUnreadBannerPlan (WEE-95)", () => {
  it("uses the sync dexieRoomMap cache — Dexie getRoom is never called", async () => {
    const sources = makeSources({
      cachedRoom: { unreadCount: 0, lastReadInboundTs: 5000 },
    });

    const plan = await resolveUnreadBannerPlan(sources);

    expect(sources.getRoom).not.toHaveBeenCalled();
    expect(plan.scrollToBanner).toBe(false);
    expect(plan.needsBootstrap).toBe(false);
  });

  it("falls back to Dexie getRoom only when the cache is cold", async () => {
    const sources = makeSources({
      cachedRoom: undefined,
      getRoom: vi.fn(async () => ({ unreadCount: 3, lastReadInboundTs: 5000 })),
      getLastMessageAtOrBefore: vi.fn(async () => ({ eventId: "$last", clientId: "c1" })),
    });

    const plan = await resolveUnreadBannerPlan(sources);

    expect(sources.getRoom).toHaveBeenCalledTimes(1);
    expect(plan).toEqual({
      lastReadId: "$last",
      unreadCount: 3,
      scrollToBanner: true,
      needsBootstrap: false,
    });
  });

  it("no watermark → bootstrap needed, no anchor query (off the render path)", async () => {
    const sources = makeSources({
      cachedRoom: { unreadCount: 7, lastReadInboundTs: 0 },
    });

    const plan = await resolveUnreadBannerPlan(sources);

    expect(plan.needsBootstrap).toBe(true);
    expect(plan.scrollToBanner).toBe(false);
    expect(sources.getLastMessageAtOrBefore).not.toHaveBeenCalled();
  });

  it("zero unread → no banner and NO anchor query", async () => {
    const sources = makeSources({
      cachedRoom: { unreadCount: 0, lastReadInboundTs: 5000 },
    });

    const plan = await resolveUnreadBannerPlan(sources);

    expect(plan.scrollToBanner).toBe(false);
    expect(plan.unreadCount).toBe(0);
    expect(sources.getLastMessageAtOrBefore).not.toHaveBeenCalled();
  });

  it("unread > 0 → banner with anchor resolved at the watermark", async () => {
    const getLastMessageAtOrBefore = vi.fn(async () => ({ eventId: "$anchor", clientId: "c9" }));
    const sources = makeSources({
      cachedRoom: { unreadCount: 4, lastReadInboundTs: 7777 },
      getLastMessageAtOrBefore,
    });

    const plan = await resolveUnreadBannerPlan(sources);

    expect(getLastMessageAtOrBefore).toHaveBeenCalledWith(7777);
    expect(plan).toEqual({
      lastReadId: "$anchor",
      unreadCount: 4,
      scrollToBanner: true,
      needsBootstrap: false,
    });
  });

  it("anchor falls back to clientId, then to null when message is gone", async () => {
    const pendingOnly = makeSources({
      cachedRoom: { unreadCount: 1, lastReadInboundTs: 100 },
      getLastMessageAtOrBefore: vi.fn(async () => ({ eventId: null, clientId: "c42" })),
    });
    expect((await resolveUnreadBannerPlan(pendingOnly)).lastReadId).toBe("c42");

    const missing = makeSources({
      cachedRoom: { unreadCount: 1, lastReadInboundTs: 100 },
      getLastMessageAtOrBefore: vi.fn(async () => undefined),
    });
    const plan = await resolveUnreadBannerPlan(missing);
    // Banner still shows (count is known), anchor just can't be matched
    expect(plan.lastReadId).toBeNull();
    expect(plan.scrollToBanner).toBe(true);
  });
});
