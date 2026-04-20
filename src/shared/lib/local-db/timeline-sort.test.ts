import { describe, it, expect } from "vitest";
import {
  compareLocalMessagesTimelineAsc,
  sortLocalMessagesTimelineAsc,
} from "./timeline-sort";
import type { LocalMessage } from "./schema";
import { MessageType } from "@/entities/chat/model/types";

function makeLocal(overrides: Partial<LocalMessage> = {}): LocalMessage {
  return {
    eventId: overrides.eventId ?? `$evt_${Math.random().toString(36).slice(2)}`,
    clientId: overrides.clientId ?? `cli_${Math.random().toString(36).slice(2)}`,
    roomId: "!room:server",
    senderId: "a",
    content: "x",
    timestamp: Date.now(),
    type: MessageType.text,
    status: "synced",
    version: 1,
    softDeleted: false,
    ...overrides,
  } as LocalMessage;
}

describe("timeline-sort (LocalMessage)", () => {
  it("sorts by timestamp ascending", () => {
    const a = makeLocal({ timestamp: 100, eventId: "$a" });
    const b = makeLocal({ timestamp: 200, eventId: "$b" });
    expect(compareLocalMessagesTimelineAsc(a, b)).toBeLessThan(0);
    expect(compareLocalMessagesTimelineAsc(b, a)).toBeGreaterThan(0);
  });

  it("uses stable id tie-breaker when timestamps equal", () => {
    const ts = 42;
    const m1 = makeLocal({ timestamp: ts, eventId: "$bbb" });
    const m2 = makeLocal({ timestamp: ts, eventId: "$aaa" });
    const sorted = sortLocalMessagesTimelineAsc([m1, m2]);
    expect(sorted.map(m => m.eventId)).toEqual(["$aaa", "$bbb"]);
  });

  it("sortLocalMessagesTimelineAsc does not mutate input", () => {
    const m1 = makeLocal({ timestamp: 2, eventId: "$2" });
    const m2 = makeLocal({ timestamp: 1, eventId: "$1" });
    const orig = [m1, m2];
    const sorted = sortLocalMessagesTimelineAsc(orig);
    expect(orig[0].timestamp).toBe(2);
    expect(sorted[0].timestamp).toBe(1);
  });
});
