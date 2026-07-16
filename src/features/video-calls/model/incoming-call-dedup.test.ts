import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  INCOMING_CALL_DEDUP_WINDOW_MS,
  isIncomingCallSeen,
  markIncomingCallSeen,
  clearIncomingCallSeen,
  __resetIncomingCallDedupForTests,
} from "./incoming-call-dedup";

describe("incoming-call-dedup — registry of seen incoming m.call.invite IDs", () => {
  beforeEach(() => {
    __resetIncomingCallDedupForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns false for an unseen callId", () => {
    expect(isIncomingCallSeen("foo")).toBe(false);
  });

  it("returns true after markIncomingCallSeen", () => {
    markIncomingCallSeen("foo");
    expect(isIncomingCallSeen("foo")).toBe(true);
  });

  it("isolates state between callIds", () => {
    markIncomingCallSeen("foo");
    expect(isIncomingCallSeen("bar")).toBe(false);
  });

  it("clearIncomingCallSeen removes the entry so the same callId is acceptable again", () => {
    markIncomingCallSeen("foo");
    expect(isIncomingCallSeen("foo")).toBe(true);

    clearIncomingCallSeen("foo");
    expect(isIncomingCallSeen("foo")).toBe(false);
  });

  it("clearIncomingCallSeen on an unknown callId is a safe no-op", () => {
    expect(() => clearIncomingCallSeen("unknown")).not.toThrow();
    expect(isIncomingCallSeen("unknown")).toBe(false);
  });

  it("ignores empty / whitespace-only callIds (defensive — avoids polluting the set on bad SDK payloads)", () => {
    markIncomingCallSeen("");
    markIncomingCallSeen("   ");
    expect(isIncomingCallSeen("")).toBe(false);
    expect(isIncomingCallSeen("   ")).toBe(false);
  });

  it("auto-clears the entry after the dedup window elapses", () => {
    vi.useFakeTimers();
    markIncomingCallSeen("foo");
    expect(isIncomingCallSeen("foo")).toBe(true);

    vi.advanceTimersByTime(INCOMING_CALL_DEDUP_WINDOW_MS - 1);
    expect(isIncomingCallSeen("foo")).toBe(true);

    vi.advanceTimersByTime(2);
    expect(isIncomingCallSeen("foo")).toBe(false);
  });

  it("repeated markIncomingCallSeen on the same callId resets the dedup timer", () => {
    vi.useFakeTimers();
    markIncomingCallSeen("foo");
    vi.advanceTimersByTime(INCOMING_CALL_DEDUP_WINDOW_MS - 100);

    // Second mark should reset the timeout, not stack a second one.
    markIncomingCallSeen("foo");
    vi.advanceTimersByTime(200);
    // Original window already elapsed for first timer if it had stacked,
    // but second mark moved the cutoff — entry must still be considered seen.
    expect(isIncomingCallSeen("foo")).toBe(true);

    vi.advanceTimersByTime(INCOMING_CALL_DEDUP_WINDOW_MS);
    expect(isIncomingCallSeen("foo")).toBe(false);
  });

  it("__resetIncomingCallDedupForTests wipes state and pending timers", () => {
    vi.useFakeTimers();
    markIncomingCallSeen("foo");
    markIncomingCallSeen("bar");
    expect(isIncomingCallSeen("foo")).toBe(true);
    expect(isIncomingCallSeen("bar")).toBe(true);

    __resetIncomingCallDedupForTests();
    expect(isIncomingCallSeen("foo")).toBe(false);
    expect(isIncomingCallSeen("bar")).toBe(false);

    // Pending timers must not resurrect entries after reset.
    vi.advanceTimersByTime(INCOMING_CALL_DEDUP_WINDOW_MS * 2);
    expect(isIncomingCallSeen("foo")).toBe(false);
    expect(isIncomingCallSeen("bar")).toBe(false);
  });
});
