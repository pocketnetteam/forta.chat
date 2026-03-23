import { describe, it, expect } from "vitest";

/**
 * Tests for the scroll-up expand logic from MessageList.vue.
 *
 * Architecture: full chat history is preloaded into Dexie on room enter.
 * Scroll-up simply calls expandMessageWindow() — reads purely from local cache.
 * No network latency on the scroll path.
 *
 * 1. Display: activeMessages from Dexie liveQuery (limited by messageWindowSize)
 * 2. Cache: ALL messages in Dexie (preloaded by preloadFullHistory on room enter)
 * 3. Network: only used as safety net if preload hasn't finished yet
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

/** Simulates the scroll handler decision logic */
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
    // Uses abs(velocity), so still gets boosted threshold
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

  it("does not trigger expand when loadingMore is true", () => {
    expect(shouldExpand({
      scrollTop: 800,
      scrollVelocity: 500,
      loadingMore: true,
      hasMore: true,
    })).toBe(false);
  });

  it("triggers nothing when hasMore is false", () => {
    expect(shouldExpand({
      scrollTop: 100,
      scrollVelocity: 2000,
      loadingMore: false,
      hasMore: false,
    })).toBe(false);
  });

  it("triggers nothing when far from top", () => {
    expect(shouldExpand({
      scrollTop: 5000,
      scrollVelocity: 500,
      loadingMore: false,
      hasMore: true,
    })).toBe(false);
  });

  it("fast scroll expands threshold to catch more", () => {
    // At normal speed, 2500px does not trigger expand (threshold=1200)
    expect(shouldExpand({
      scrollTop: 2500,
      scrollVelocity: 500,
      loadingMore: false,
      hasMore: true,
    })).toBe(false);

    // At fast speed, 2500px triggers expand (threshold boosted to 3000)
    expect(shouldExpand({
      scrollTop: 2500,
      scrollVelocity: 4000,
      loadingMore: false,
      hasMore: true,
    })).toBe(true);
  });
});

describe("doLoadMore with preloaded history", () => {
  /** Simulates the doLoadMore decision flow */
  function simulateDoLoadMore(opts: {
    prevMessageCount: number;
    afterExpandCount: number;
    historyPreloadActive: boolean;
    hasMore: boolean;
  }) {
    const steps: string[] = [];

    steps.push("expand_window"); // Always start with Dexie expand

    const newLen = opts.afterExpandCount;
    if (newLen <= opts.prevMessageCount) {
      if (opts.hasMore && !opts.historyPreloadActive) {
        // Preload not running, cache exhausted — safety net network fetch
        steps.push("network_fetch");
        steps.push("expand_window_retry");
      } else if (opts.historyPreloadActive) {
        // Preload still running — just wait, data will arrive
        steps.push("wait_for_preload");
      }
    }

    return steps;
  }

  it("only expands when Dexie has preloaded data", () => {
    const steps = simulateDoLoadMore({
      prevMessageCount: 50,
      afterExpandCount: 100, // Got 50 more from cache
      historyPreloadActive: false,
      hasMore: true,
    });
    expect(steps).toEqual(["expand_window"]);
  });

  it("waits for preload when cache temporarily empty but preload running", () => {
    const steps = simulateDoLoadMore({
      prevMessageCount: 50,
      afterExpandCount: 50, // No new messages yet
      historyPreloadActive: true,
      hasMore: true,
    });
    expect(steps).toContain("wait_for_preload");
    expect(steps).not.toContain("network_fetch");
  });

  it("falls back to network when preload done and cache exhausted", () => {
    const steps = simulateDoLoadMore({
      prevMessageCount: 50,
      afterExpandCount: 50,
      historyPreloadActive: false,
      hasMore: true,
    });
    expect(steps).toContain("network_fetch");
  });

  it("does not fetch when at beginning of history", () => {
    const steps = simulateDoLoadMore({
      prevMessageCount: 50,
      afterExpandCount: 50,
      historyPreloadActive: false,
      hasMore: false,
    });
    expect(steps).not.toContain("network_fetch");
    expect(steps).not.toContain("wait_for_preload");
  });
});
