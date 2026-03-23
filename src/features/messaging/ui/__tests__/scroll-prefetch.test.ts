import { describe, it, expect } from "vitest";

/**
 * Tests for the Telegram-like scroll architecture in MessageList.vue.
 *
 * Pipeline:
 * 1. Display: activeMessages from Dexie liveQuery (limited by messageWindowSize)
 * 2. Cache: messages in Dexie (filled by prefetchNextBatch — one batch ahead)
 * 3. Network: Matrix scrollback (safety net if prefetch hasn't arrived yet)
 *
 * On room enter: prefetch first batch of 25 into Dexie.
 * On scroll-up: expandMessageWindow() reads from Dexie, then prefetch next batch.
 */

// Constants matching MessageList.vue
const LOAD_THRESHOLD = 1200;
const VELOCITY_BOOST_THRESHOLD = 1500;

/** Replicates the velocity-adaptive load threshold calculation */
function getEffectiveLoadThreshold(scrollVelocity: number) {
  const speed = Math.abs(scrollVelocity);
  return speed > 3000 ? 3000
    : speed > VELOCITY_BOOST_THRESHOLD ? 2000
    : LOAD_THRESHOLD;
}

/** Simulates the scroll handler expand decision */
function shouldExpand(opts: {
  scrollTop: number;
  scrollVelocity: number;
  loadingMore: boolean;
  hasMore: boolean;
}): boolean {
  const threshold = getEffectiveLoadThreshold(opts.scrollVelocity);
  return opts.scrollTop < threshold && !opts.loadingMore && opts.hasMore;
}

describe("velocity-adaptive load threshold", () => {
  it("uses base threshold at low speed", () => {
    expect(getEffectiveLoadThreshold(500)).toBe(LOAD_THRESHOLD);
  });

  it("uses medium threshold at medium speed", () => {
    expect(getEffectiveLoadThreshold(2000)).toBe(2000);
  });

  it("uses aggressive threshold at high speed", () => {
    expect(getEffectiveLoadThreshold(4000)).toBe(3000);
  });

  it("handles negative velocity (scrolling down)", () => {
    expect(getEffectiveLoadThreshold(-3000)).toBe(2000);
  });

  it("handles zero velocity", () => {
    expect(getEffectiveLoadThreshold(0)).toBe(LOAD_THRESHOLD);
  });
});

describe("scroll expand decisions", () => {
  it("triggers expand when near top", () => {
    expect(shouldExpand({
      scrollTop: 800,
      scrollVelocity: 500,
      loadingMore: false,
      hasMore: true,
    })).toBe(true);
  });

  it("does not expand when loadingMore", () => {
    expect(shouldExpand({
      scrollTop: 800,
      scrollVelocity: 500,
      loadingMore: true,
      hasMore: true,
    })).toBe(false);
  });

  it("does not expand when no more messages", () => {
    expect(shouldExpand({
      scrollTop: 100,
      scrollVelocity: 2000,
      loadingMore: false,
      hasMore: false,
    })).toBe(false);
  });

  it("does not expand when far from top", () => {
    expect(shouldExpand({
      scrollTop: 5000,
      scrollVelocity: 500,
      loadingMore: false,
      hasMore: true,
    })).toBe(false);
  });

  it("fast scroll widens threshold", () => {
    // Normal speed: 2500px does NOT trigger (threshold=1200)
    expect(shouldExpand({
      scrollTop: 2500, scrollVelocity: 500,
      loadingMore: false, hasMore: true,
    })).toBe(false);

    // Fast speed: 2500px DOES trigger (threshold boosted to 3000)
    expect(shouldExpand({
      scrollTop: 2500, scrollVelocity: 4000,
      loadingMore: false, hasMore: true,
    })).toBe(true);
  });
});

describe("doLoadMore with incremental prefetch", () => {
  /** Simulates the doLoadMore + prefetch pipeline */
  function simulateDoLoadMore(opts: {
    prevMessageCount: number;
    afterExpandCount: number;
    hasMore: boolean;
  }) {
    const steps: string[] = [];

    steps.push("expand_window");

    if (opts.afterExpandCount <= opts.prevMessageCount && opts.hasMore) {
      // Prefetch hadn't arrived yet — fall back to network
      steps.push("network_fetch");
    }

    // After expand, prefetch next batch for future scroll-up
    if (opts.hasMore) {
      steps.push("prefetch_next");
    }

    return steps;
  }

  it("expand + prefetch when cache has data", () => {
    const steps = simulateDoLoadMore({
      prevMessageCount: 50,
      afterExpandCount: 75, // 25 from prefetch
      hasMore: true,
    });
    expect(steps).toEqual(["expand_window", "prefetch_next"]);
    expect(steps).not.toContain("network_fetch");
  });

  it("falls back to network when cache is empty, then prefetches next", () => {
    const steps = simulateDoLoadMore({
      prevMessageCount: 50,
      afterExpandCount: 50, // nothing new
      hasMore: true,
    });
    expect(steps).toContain("network_fetch");
    expect(steps).toContain("prefetch_next");
  });

  it("no prefetch when at beginning of history", () => {
    const steps = simulateDoLoadMore({
      prevMessageCount: 50,
      afterExpandCount: 55,
      hasMore: false,
    });
    expect(steps).not.toContain("prefetch_next");
    expect(steps).not.toContain("network_fetch");
  });
});
