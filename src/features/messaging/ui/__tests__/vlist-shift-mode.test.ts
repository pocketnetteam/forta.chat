import { describe, it, expect } from "vitest";
import { ref, computed, nextTick } from "vue";

/**
 * Tests for the shiftMode logic extracted from MessageList.vue.
 *
 * Virtua's VList `shift` prop controls how the internal height cache is updated
 * when the data array length changes:
 *   - shift=true  → assumes items were prepended (added at START)
 *   - shift=false → assumes items were appended (added at END)
 *
 * Using shift=true when items are appended corrupts the height cache:
 * every visible item gets the cached height of its neighbour, producing
 * 1-2 frames of incorrect positioning (the overlap glitch).
 *
 * The fix: shift must be true ONLY during pagination (loadMore / prefetch),
 * when older messages are prepended at the top of the list.
 */

/** Replicates the shiftMode computed from MessageList.vue.
 *  NOTE: these tests verify a copy of the logic, not the actual component code.
 *  If the condition in MessageList.vue changes, these tests must be updated too. */
function createShiftMode() {
  const loadingMore = ref(false);
  const prefetching = ref(false);
  const loadingNewer = ref(false);
  const shiftMode = computed(() => loadingMore.value || prefetching.value);
  return { loadingMore, prefetching, loadingNewer, shiftMode };
}

describe("VList shiftMode", () => {
  it("defaults to false (safe for appending messages)", () => {
    const { shiftMode } = createShiftMode();
    expect(shiftMode.value).toBe(false);
  });

  it("is true during loadMore pagination", () => {
    const { loadingMore, shiftMode } = createShiftMode();
    loadingMore.value = true;
    expect(shiftMode.value).toBe(true);
  });

  it("is true during background prefetch", () => {
    const { prefetching, shiftMode } = createShiftMode();
    prefetching.value = true;
    expect(shiftMode.value).toBe(true);
  });

  it("reverts to false after pagination completes", async () => {
    const { loadingMore, shiftMode } = createShiftMode();
    loadingMore.value = true;
    expect(shiftMode.value).toBe(true);

    loadingMore.value = false;
    await nextTick();
    expect(shiftMode.value).toBe(false);
  });

  it("stays false when new messages are appended (no pagination)", () => {
    const { shiftMode } = createShiftMode();
    // Simulates: new message arrives, typing indicator toggles — no pagination
    expect(shiftMode.value).toBe(false);
  });

  it("stays false during forward pagination (loadNewer appends to END)", () => {
    const { loadingNewer, shiftMode } = createShiftMode();
    // doLoadNewer uses its own flag, must NOT feed into shiftMode
    // because newer messages are appended at the end of the list
    loadingNewer.value = true;
    expect(shiftMode.value).toBe(false);
  });

  it("loadingNewer does not interfere with loadingMore", () => {
    const { loadingMore, loadingNewer, shiftMode } = createShiftMode();
    loadingNewer.value = true;
    loadingMore.value = true;
    // shift should be true only because of loadingMore (prepend)
    expect(shiftMode.value).toBe(true);

    loadingMore.value = false;
    // loadingNewer still true but shift should be false
    expect(shiftMode.value).toBe(false);
  });
});

/**
 * Tests for the typing-indicator swap scenario.
 *
 * When the typing indicator disappears and a new message arrives in the same
 * reactive flush, the virtualItems array stays the same length but the last
 * item swaps from TypingBubble (~48px) to MessageBubble (~100-200px).
 * Virtua keeps the old cached height for that index until ResizeObserver fires.
 *
 * The fix: watch typingText and call nudgeVirtua() on toggle to force remeasure.
 */
describe("typing indicator toggle detection", () => {
  it("detects transition from typing to no typing", async () => {
    const typingText = ref("Alice is typing...");
    let nudgeCalled = false;

    // Replicates the watcher logic from MessageList.vue
    const pendingScrollToBottom = false;
    const watchEffect = (cur: string, prev: string) => {
      const appeared = !prev && !!cur;
      const disappeared = !!prev && !cur;
      if ((appeared || disappeared) && !pendingScrollToBottom) {
        nudgeCalled = true;
      }
    };

    // Simulate typing indicator disappearing
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

    // Text changes but typing indicator stays visible — no nudge needed
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
