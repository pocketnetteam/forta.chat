import { describe, it, expect } from "vitest";
import { decideFabAction, shouldAutoDismissBanner } from "./fab-decision";

/**
 * Telegram-like state machine for the scroll-to-bottom FAB:
 *
 *   click → hasBanner?
 *     └─yes→ user below banner (banner above viewport)?
 *           ├─yes→ scrollToBottom + dismissBanner   (Telegram: prošёl baner — vniz)
 *           └─no → scrollToBanner                   (idёm k baneru)
 *     └─no → isDetachedFromLatest?
 *            ├─yes→ returnToLatest
 *            └─no → scrollToBottom
 *
 * Coordinate model — column-reverse virtual list:
 *   - idx 0          = newest = visual BOTTOM
 *   - idx N-1        = oldest = visual TOP
 *   - visibleRange   = { start: top idx (larger), end: bottom idx (smaller) }
 *   - banner above viewport (user below banner)  ⇔  range.start < bannerIdx
 *   - banner below viewport (user above banner)  ⇔  range.end   > bannerIdx
 *   - banner inside viewport                      ⇔  range.start ≥ bannerIdx ≥ range.end
 */

describe("decideFabAction — Telegram-like FAB navigation", () => {
  it("U1.A: hasBanner + user above banner → scroll to banner", () => {
    // banner at idx 10, viewport shows old messages (top idx 25, bottom idx 15)
    // banner is BELOW viewport (range.end > bannerIdx) → user is above banner
    const action = decideFabAction({
      hasBanner: true,
      bannerIdx: 10,
      visibleRange: { start: 25, end: 15 },
      isDetachedFromLatest: false,
    });
    expect(action).toEqual({ kind: "scroll-to-banner", bannerIdx: 10 });
  });

  it("U1.A2: hasBanner + banner inside viewport → still scroll to banner (align top)", () => {
    // banner at idx 10, range = { start: 12, end: 8 } — banner visible
    const action = decideFabAction({
      hasBanner: true,
      bannerIdx: 10,
      visibleRange: { start: 12, end: 8 },
      isDetachedFromLatest: false,
    });
    expect(action).toEqual({ kind: "scroll-to-banner", bannerIdx: 10 });
  });

  it("U1.B: hasBanner + user below banner → scroll to bottom + dismiss", () => {
    // banner at idx 10, range = { start: 5, end: 0 } — banner above viewport
    const action = decideFabAction({
      hasBanner: true,
      bannerIdx: 10,
      visibleRange: { start: 5, end: 0 },
      isDetachedFromLatest: false,
    });
    expect(action).toEqual({ kind: "scroll-to-bottom-and-dismiss" });
  });

  it("U1.C: no banner + not detached → simple scroll to bottom", () => {
    const action = decideFabAction({
      hasBanner: false,
      bannerIdx: -1,
      visibleRange: { start: 30, end: 20 },
      isDetachedFromLatest: false,
    });
    expect(action).toEqual({ kind: "scroll-to-bottom" });
  });

  it("U1.D: no banner + isDetachedFromLatest → return to latest", () => {
    const action = decideFabAction({
      hasBanner: false,
      bannerIdx: -1,
      visibleRange: null,
      isDetachedFromLatest: true,
    });
    expect(action).toEqual({ kind: "return-to-latest" });
  });

  it("U1.E: hasBanner but bannerIdx not found (-1) → fall through to default", () => {
    // Edge case: banner state says hasBanner=true, but reversedItems doesn't have it
    // (e.g. banner was filtered out). Falls through to default scroll-to-bottom.
    const action = decideFabAction({
      hasBanner: true,
      bannerIdx: -1,
      visibleRange: { start: 5, end: 0 },
      isDetachedFromLatest: false,
    });
    expect(action).toEqual({ kind: "scroll-to-bottom" });
  });

  it("U1.F: hasBanner + visibleRange null (scroller not measured yet) → fall back to scroll-to-banner (safe default)", () => {
    // If we cannot determine position, default to scroll-to-banner — preserves
    // existing behavior. Better than risking dismiss when we don't know where user is.
    const action = decideFabAction({
      hasBanner: true,
      bannerIdx: 10,
      visibleRange: null,
      isDetachedFromLatest: false,
    });
    expect(action).toEqual({ kind: "scroll-to-banner", bannerIdx: 10 });
  });
});

describe("shouldAutoDismissBanner — scroll-past-banner detection", () => {
  it("U2.A: scroll past banner after grace period (>200ms) → dismiss", () => {
    // banner at idx 10, viewport shows newer messages (range.start = 5 < 10)
    // → banner is above viewport → user has scrolled past it
    const result = shouldAutoDismissBanner({
      hasBanner: true,
      bannerIdx: 10,
      visibleRange: { start: 5, end: 0 },
      msSinceRoomOpen: 250,
    });
    expect(result).toBe(true);
  });

  it("U2.B: scroll past banner WITHIN grace period (<200ms) → do NOT dismiss", () => {
    // Sanity guard: protects against spurious dismiss during room-switch race
    const result = shouldAutoDismissBanner({
      hasBanner: true,
      bannerIdx: 10,
      visibleRange: { start: 5, end: 0 },
      msSinceRoomOpen: 50,
    });
    expect(result).toBe(false);
  });

  it("U2.C: banner still visible → do NOT dismiss", () => {
    const result = shouldAutoDismissBanner({
      hasBanner: true,
      bannerIdx: 10,
      visibleRange: { start: 12, end: 8 },
      msSinceRoomOpen: 1000,
    });
    expect(result).toBe(false);
  });

  it("U2.D: no banner → do NOT dismiss (no-op)", () => {
    const result = shouldAutoDismissBanner({
      hasBanner: false,
      bannerIdx: -1,
      visibleRange: { start: 5, end: 0 },
      msSinceRoomOpen: 1000,
    });
    expect(result).toBe(false);
  });

  it("U2.E: visibleRange null → do NOT dismiss (cannot determine position)", () => {
    const result = shouldAutoDismissBanner({
      hasBanner: true,
      bannerIdx: 10,
      visibleRange: null,
      msSinceRoomOpen: 1000,
    });
    expect(result).toBe(false);
  });

  it("U2.F: user above banner (range.end > bannerIdx) → do NOT dismiss", () => {
    // banner below viewport — user hasn't passed it yet
    const result = shouldAutoDismissBanner({
      hasBanner: true,
      bannerIdx: 10,
      visibleRange: { start: 25, end: 15 },
      msSinceRoomOpen: 1000,
    });
    expect(result).toBe(false);
  });

  it("U2.G: bannerIdx -1 (banner state inconsistency) → do NOT dismiss", () => {
    const result = shouldAutoDismissBanner({
      hasBanner: true,
      bannerIdx: -1,
      visibleRange: { start: 5, end: 0 },
      msSinceRoomOpen: 1000,
    });
    expect(result).toBe(false);
  });
});
