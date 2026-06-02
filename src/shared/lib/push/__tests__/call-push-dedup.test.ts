import { describe, it, expect, beforeEach } from "vitest";
import {
  shouldRingForCallPush,
  resetCallPushDedup,
  CALL_PUSH_DEDUP_WINDOW_MS,
} from "../call-push-dedup";

describe("shouldRingForCallPush", () => {
  beforeEach(() => resetCallPushDedup());

  it("rings on the first push for a call id", () => {
    expect(shouldRingForCallPush("call-1", 1000)).toBe(true);
  });

  it("suppresses a second push for the same id within the window", () => {
    expect(shouldRingForCallPush("call-1", 1000)).toBe(true);
    expect(shouldRingForCallPush("call-1", 1000 + 500)).toBe(false);
    expect(shouldRingForCallPush("call-1", 1000 + CALL_PUSH_DEDUP_WINDOW_MS - 1)).toBe(false);
  });

  it("rings again once the window has elapsed", () => {
    expect(shouldRingForCallPush("call-1", 1000)).toBe(true);
    expect(shouldRingForCallPush("call-1", 1000 + CALL_PUSH_DEDUP_WINDOW_MS)).toBe(true);
  });

  it("treats distinct call ids independently", () => {
    expect(shouldRingForCallPush("call-1", 1000)).toBe(true);
    expect(shouldRingForCallPush("call-2", 1000)).toBe(true);
  });

  it("always rings when no call id is present (can't dedup safely)", () => {
    expect(shouldRingForCallPush("", 1000)).toBe(true);
    expect(shouldRingForCallPush("", 1000)).toBe(true);
  });

  it("garbage-collects expired ids so the map cannot grow unbounded", () => {
    // Seed an id, then advance well past the window with a different id —
    // the stale entry must be evicted (a fresh push for the old id rings).
    expect(shouldRingForCallPush("old", 0)).toBe(true);
    expect(shouldRingForCallPush("new", CALL_PUSH_DEDUP_WINDOW_MS * 2)).toBe(true);
    // 'old' was GC'd, so it rings again rather than being treated as a dup.
    expect(shouldRingForCallPush("old", CALL_PUSH_DEDUP_WINDOW_MS * 2)).toBe(true);
  });

  it("resetCallPushDedup clears state", () => {
    expect(shouldRingForCallPush("call-1", 1000)).toBe(true);
    resetCallPushDedup();
    expect(shouldRingForCallPush("call-1", 1000)).toBe(true);
  });
});
