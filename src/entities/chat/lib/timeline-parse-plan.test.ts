import { describe, it, expect } from "vitest";
import {
  classifyTimelineEvent,
  describeTimeline,
  isTimelineStoredInDexie,
  needsReparse,
  pageEventIds,
  selectEventIdsToParse,
} from "./timeline-parse-plan";

const hangupRow = (missed: boolean) => ({ content: "call", callInfo: { callType: "voice", missed, duration: 0 } }) as never;

describe("needsReparse", () => {
  it("leaves a decrypted row alone", () => {
    expect(needsReparse({ content: "hi", decryptionStatus: "ok" }, false)).toBe(false);
  });

  it("re-parses rows still waiting for their plaintext", () => {
    expect(needsReparse({ content: "[encrypted]", decryptionStatus: "ok" }, false)).toBe(true);
    expect(needsReparse({ content: "x", decryptionStatus: "pending" }, false)).toBe(true);
    expect(needsReparse({ content: "x", decryptionStatus: "failed" }, false)).toBe(true);
  });

  it("re-parses a hangup only when it now reads as missed", () => {
    expect(needsReparse(hangupRow(false), true)).toBe(true);
    expect(needsReparse(hangupRow(false), false)).toBe(false); // answered call: never missed
    expect(needsReparse(hangupRow(true), true)).toBe(false); // already repaired
  });
});

describe("selectEventIdsToParse", () => {
  const ok = { content: "hi", decryptionStatus: "ok" as const };
  const never = () => false;

  it("keeps only events Dexie lacks", () => {
    const ids = selectEventIdsToParse({
      messageEventIds: ["$a", "$b", "$c"],
      stored: new Map([["$a", ok], ["$c", ok]]),
      edits: [],
      hangupReadsMissed: never,
    });
    expect([...ids]).toEqual(["$b"]);
  });

  it("adds the target of an edit Dexie has not applied yet", () => {
    const ids = selectEventIdsToParse({
      messageEventIds: ["$a", "$b"],
      stored: new Map([["$a", { ...ok, lastEditTs: 100 }], ["$b", { ...ok, lastEditTs: 500 }]]),
      edits: [{ targetId: "$a", ts: 200 }, { targetId: "$b", ts: 300 }],
      hangupReadsMissed: never,
    });
    expect([...ids]).toEqual(["$a"]);
  });

  it("re-parses a stored hangup whose invite came into view", () => {
    const ids = selectEventIdsToParse({
      messageEventIds: ["$hang", "$answered"],
      stored: new Map([["$hang", hangupRow(false)], ["$answered", hangupRow(false)]]),
      edits: [],
      hangupReadsMissed: (id) => id === "$hang",
    });
    expect([...ids]).toEqual(["$hang"]);
  });
});

describe("classifyTimelineEvent / describeTimeline", () => {
  const raw = (id: string, type: string, content: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) =>
    ({ event_id: id, type, content, origin_server_ts: 10, ...extra });

  it("splits relations from message events the way the parser does", () => {
    const events = [
      raw("$m", "m.room.message", { body: "hi" }),
      raw("$e", "m.room.message", { body: "* x", "m.relates_to": { rel_type: "m.replace", event_id: "$m" } }),
      raw("$red", "m.room.message", {}, { unsigned: { redacted_because: {} } }),
      raw("$r", "m.reaction", { "m.relates_to": { event_id: "$m", key: "👍" } }),
      raw("$v", "org.matrix.msc3381.poll.response", { answers: [] }),
      raw("$h", "m.call.hangup", { call_id: "c" }),
      raw("$s", "m.room.member", { membership: "join" }),
    ];
    expect(classifyTimelineEvent(events[1])).toBe("edit");
    expect(classifyTimelineEvent(events[2])).toBe("message"); // redacted → placeholder row

    const d = describeTimeline(events);
    expect(d.messageEventIds).toEqual(["$m", "$red", "$h", "$s"]);
    expect(d.rowEventIds).toEqual(["$m", "$red", "$h"]);
    expect(d.edits).toEqual([{ targetId: "$m", ts: 10 }]);
  });

  it("pageEventIds takes the prepended page", () => {
    expect([...pageEventIds([raw("$1", "x", {}), raw("$2", "x", {}), raw("$3", "x", {})], 2)]).toEqual(["$1", "$2"]);
  });
});

describe("isTimelineStoredInDexie", () => {
  const base = { timelineLength: 30, hasMoreHistory: true, minTimelineEvents: 20 };

  it("is true when a history load would parse nothing", () => {
    expect(isTimelineStoredInDexie({ ...base, pendingIds: new Set() })).toBe(true);
  });

  it("is false when anything is missing or needs repair", () => {
    expect(isTimelineStoredInDexie({ ...base, pendingIds: new Set(["$b"]) })).toBe(false);
  });

  it("is false for a short timeline that loadRoomMessages would scroll back", () => {
    expect(isTimelineStoredInDexie({ ...base, timelineLength: 4, pendingIds: new Set() })).toBe(false);
  });

  it("is true for a short timeline that already reaches the start of the room", () => {
    expect(isTimelineStoredInDexie({ ...base, timelineLength: 4, hasMoreHistory: false, pendingIds: new Set() })).toBe(true);
  });
});
