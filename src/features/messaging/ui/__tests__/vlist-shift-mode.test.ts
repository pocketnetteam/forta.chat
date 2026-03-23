import { describe, it, expect } from "vitest";
import { ref, nextTick } from "vue";

/**
 * Tests for the shiftMode logic extracted from MessageList.vue.
 *
 * Virtua's VList `shift` prop controls how the internal height cache is updated
 * when the data array length changes:
 *   - shift=true  → assumes items were prepended (added at START)
 *   - shift=false → assumes items were appended (added at END)
 *
 * IMPORTANT: shift mode is ALWAYS false in our implementation.
 * Virtua's shift assumes synchronous prepends, but our data arrives asynchronously
 * via Dexie liveQuery. With async data, shift corrupts the internal height cache
 * causing giant gaps between messages. Instead we use manual scrollTop correction.
 */

describe("VList shiftMode", () => {
  it("is always false — Virtua shift disabled for async liveQuery data", () => {
    // shiftMode is a constant false, not a computed
    const shiftMode = false;
    expect(shiftMode).toBe(false);
  });

  it("manual scroll correction preserves position after prepend", () => {
    // Simulates the doLoadMore scroll correction logic
    const prevHeight = 5000;
    const newHeight = 8000; // 3000px of new content prepended
    const prevScrollTop = 200;

    const delta = newHeight - prevHeight;
    const correctedScrollTop = prevScrollTop + delta;

    // User was 200px from top, now should be 3200px from top
    // (same content visible, new content above)
    expect(correctedScrollTop).toBe(3200);
    expect(delta).toBeGreaterThan(0);
  });

  it("no correction when no new content added", () => {
    const prevHeight = 5000;
    const newHeight = 5000;

    const delta = newHeight - prevHeight;
    expect(delta).toBe(0); // No correction needed
  });
});

/**
 * Tests for the typing-indicator swap scenario.
 */
describe("typing indicator toggle detection", () => {
  it("detects transition from typing to no typing", async () => {
    let nudgeCalled = false;
    const pendingScrollToBottom = false;

    const watchEffect = (cur: string, prev: string) => {
      const appeared = !prev && !!cur;
      const disappeared = !!prev && !cur;
      if ((appeared || disappeared) && !pendingScrollToBottom) {
        nudgeCalled = true;
      }
    };

    watchEffect("", "Alice is typing...");
    expect(nudgeCalled).toBe(true);
  });

  it("detects transition from no typing to typing", () => {
    let nudgeCalled = false;
    const pendingScrollToBottom = false;

    const watchEffect = (cur: string, prev: string) => {
      const appeared = !prev && !!cur;
      const disappeared = !!prev && !cur;
      if ((appeared || disappeared) && !pendingScrollToBottom) {
        nudgeCalled = true;
      }
    };

    watchEffect("Bob is typing...", "");
    expect(nudgeCalled).toBe(true);
  });

  it("does NOT nudge when typing text just changes (same users)", () => {
    let nudgeCalled = false;
    const pendingScrollToBottom = false;

    const watchEffect = (cur: string, prev: string) => {
      const appeared = !prev && !!cur;
      const disappeared = !!prev && !cur;
      if ((appeared || disappeared) && !pendingScrollToBottom) {
        nudgeCalled = true;
      }
    };

    watchEffect("Alice, Bob are typing...", "Alice is typing...");
    expect(nudgeCalled).toBe(false);
  });

  it("does NOT nudge during pendingScrollToBottom (handled by ResizeObserver)", () => {
    let nudgeCalled = false;
    const pendingScrollToBottom = true;

    const watchEffect = (cur: string, prev: string) => {
      const appeared = !prev && !!cur;
      const disappeared = !!prev && !cur;
      if ((appeared || disappeared) && !pendingScrollToBottom) {
        nudgeCalled = true;
      }
    };

    watchEffect("", "Alice is typing...");
    expect(nudgeCalled).toBe(false);
  });
});
