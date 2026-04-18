/**
 * Tests for message utility functions.
 *
 * isConsecutiveMessage — controls Telegram-style message grouping.
 *   A bug here caused: TypeError crash (undefined.senderId) when computing
 *   showAvatar for the last message in the list.
 */
import { describe, it, expect } from "vitest";
import { isConsecutiveMessage, sortMessagesByTime, sortMessagesTimelineAsc, groupMessagesByDate } from "./message-utils";
import { MessageStatus, MessageType } from "../model/types";
import type { Message } from "../model/types";

function makeMsg(overrides: Partial<Message> = {}): Message {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    roomId: "!room:server",
    senderId: "user1",
    content: "hello",
    timestamp: Date.now(),
    status: MessageStatus.sent,
    type: MessageType.text,
    ...overrides,
  };
}

// ─── isConsecutiveMessage ────────────────────────────────────────

describe("isConsecutiveMessage", () => {
  it("returns false when prev is undefined (first message)", () => {
    const msg = makeMsg();
    expect(isConsecutiveMessage(undefined, msg)).toBe(false);
  });

  it("returns false when current is undefined (last message check)", () => {
    const msg = makeMsg();
    expect(isConsecutiveMessage(msg, undefined)).toBe(false);
  });

  it("returns false when both are undefined", () => {
    expect(isConsecutiveMessage(undefined, undefined)).toBe(false);
  });

  it("returns true for same sender within 60 seconds", () => {
    const now = Date.now();
    const prev = makeMsg({ senderId: "alice", timestamp: now });
    const current = makeMsg({ senderId: "alice", timestamp: now + 30_000 });
    expect(isConsecutiveMessage(prev, current)).toBe(true);
  });

  it("returns false for same sender after 60 seconds", () => {
    const now = Date.now();
    const prev = makeMsg({ senderId: "alice", timestamp: now });
    const current = makeMsg({ senderId: "alice", timestamp: now + 60_001 });
    expect(isConsecutiveMessage(prev, current)).toBe(false);
  });

  it("returns false for different senders within 60 seconds", () => {
    const now = Date.now();
    const prev = makeMsg({ senderId: "alice", timestamp: now });
    const current = makeMsg({ senderId: "bob", timestamp: now + 10_000 });
    expect(isConsecutiveMessage(prev, current)).toBe(false);
  });

  it("returns true at exactly 59999ms (boundary)", () => {
    const now = Date.now();
    const prev = makeMsg({ senderId: "alice", timestamp: now });
    const current = makeMsg({ senderId: "alice", timestamp: now + 59_999 });
    expect(isConsecutiveMessage(prev, current)).toBe(true);
  });

  it("returns false at exactly 60000ms (boundary)", () => {
    const now = Date.now();
    const prev = makeMsg({ senderId: "alice", timestamp: now });
    const current = makeMsg({ senderId: "alice", timestamp: now + 60_000 });
    expect(isConsecutiveMessage(prev, current)).toBe(false);
  });
});

// ─── sortMessagesByTime ──────────────────────────────────────────

describe("sortMessagesByTime", () => {
  it("sorts messages chronologically", () => {
    const msgs = [
      makeMsg({ timestamp: 3000 }),
      makeMsg({ timestamp: 1000 }),
      makeMsg({ timestamp: 2000 }),
    ];
    const sorted = sortMessagesByTime(msgs);
    expect(sorted[0].timestamp).toBe(1000);
    expect(sorted[1].timestamp).toBe(2000);
    expect(sorted[2].timestamp).toBe(3000);
  });

  it("does not mutate original array", () => {
    const msgs = [makeMsg({ timestamp: 2 }), makeMsg({ timestamp: 1 })];
    const sorted = sortMessagesByTime(msgs);
    expect(msgs[0].timestamp).toBe(2); // unchanged
    expect(sorted[0].timestamp).toBe(1);
  });
});

// ─── sortMessagesTimelineAsc ─────────────────────────────────────

describe("sortMessagesTimelineAsc", () => {
  it("tie-breaks equal timestamps by id", () => {
    const ts = 99;
    const a = makeMsg({ id: "z", timestamp: ts });
    const b = makeMsg({ id: "a", timestamp: ts });
    const sorted = sortMessagesTimelineAsc([a, b]);
    expect(sorted.map(m => m.id)).toEqual(["a", "z"]);
  });
});

// ─── groupMessagesByDate ─────────────────────────────────────────

describe("groupMessagesByDate", () => {
  it("groups messages by calendar date", () => {
    const day1 = new Date("2024-01-15T10:00:00").getTime();
    const day2 = new Date("2024-01-16T14:00:00").getTime();

    const msgs = [
      makeMsg({ timestamp: day1 }),
      makeMsg({ timestamp: day1 + 3600_000 }),
      makeMsg({ timestamp: day2 }),
    ];

    const groups = groupMessagesByDate(msgs);
    expect(groups.size).toBe(2);
  });

  it("returns empty map for empty array", () => {
    const groups = groupMessagesByDate([]);
    expect(groups.size).toBe(0);
  });
});
