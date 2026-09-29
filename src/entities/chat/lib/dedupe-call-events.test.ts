import { describe, it, expect } from "vitest";
import { collapsedCallEventIds, dedupeCallEvents, planCallRecordDeletion } from "./dedupe-call-events";

type Row = {
  id: string;
  _key?: string;
  callInfo?: { callType: "voice" | "video"; missed: boolean; callId?: string };
};

const call = (id: string, callId?: string, missed = false): Row => ({
  id,
  callInfo: { callType: "voice", missed, callId },
});
const text = (id: string): Row => ({ id });

describe("dedupeCallEvents", () => {
  it("keeps one record when both sides hang up the same call", () => {
    // The real shape of #1027: two hangup events, different event ids, one call.
    const rows = [call("ev1", "call-a"), call("ev2", "call-a")];

    expect(dedupeCallEvents(rows).map((r) => r.id)).toEqual(["ev1"]);
  });

  it("keeps the earliest record so the timeline does not shift", () => {
    const rows = [call("first", "call-a"), call("second", "call-a")];

    expect(dedupeCallEvents(rows)[0].id).toBe("first");
  });

  it("keeps separate calls apart", () => {
    const rows = [call("ev1", "call-a"), call("ev2", "call-b"), call("ev3", "call-a")];

    expect(dedupeCallEvents(rows).map((r) => r.id)).toEqual(["ev1", "ev2"]);
  });

  it("leaves non-call messages untouched and in place", () => {
    const rows = [text("m1"), call("ev1", "call-a"), text("m2"), call("ev2", "call-a")];

    expect(dedupeCallEvents(rows).map((r) => r.id)).toEqual(["m1", "ev1", "m2"]);
  });

  it("keeps every record written before call ids were stored", () => {
    // Old history has no id to group on; dropping such rows on a guess would
    // silently rewrite what the user already saw.
    const rows = [call("old1"), call("old2")];

    expect(dedupeCallEvents(rows).map((r) => r.id)).toEqual(["old1", "old2"]);
  });

  it("returns an empty list unchanged", () => {
    expect(dedupeCallEvents([])).toEqual([]);
  });
});

describe("collapsedCallEventIds", () => {
  it("points a watermark on the dropped hangup at the record that survived", () => {
    // The bug this exists for: "last read" lands on the second hangup because
    // it is the newest event in the room, then dedupeCallEvents removes it and
    // the unread banner searches the timeline for an id that is no longer there.
    const rows = [call("ev1", "call-a"), call("ev2", "call-a")];

    expect(collapsedCallEventIds(rows).get("ev2")).toBe("ev1");
  });

  it("maps the dropped record's stable key as well as its id", () => {
    const rows: Row[] = [
      { ...call("ev1", "call-a"), _key: "key1" },
      { ...call("ev2", "call-a"), _key: "key2" },
    ];

    const collapsed = collapsedCallEventIds(rows);
    expect(collapsed.get("ev2")).toBe("key1");
    expect(collapsed.get("key2")).toBe("key1");
  });

  it("maps every dropped record when a call leaves more than two", () => {
    const rows = [call("ev1", "call-a"), call("ev2", "call-a"), call("ev3", "call-a")];

    const collapsed = collapsedCallEventIds(rows);
    expect(collapsed.get("ev2")).toBe("ev1");
    expect(collapsed.get("ev3")).toBe("ev1");
  });

  it("maps nothing when no record is dropped", () => {
    const rows = [text("m1"), call("ev1", "call-a"), call("ev2", "call-b"), call("old")];

    expect(collapsedCallEventIds(rows).size).toBe(0);
  });

  it("never maps a surviving id, so a live watermark is left alone", () => {
    const rows = [call("ev1", "call-a"), call("ev2", "call-a"), text("m1")];

    const collapsed = collapsedCallEventIds(rows);
    expect(collapsed.has("ev1")).toBe(false);
    expect(collapsed.has("m1")).toBe(false);
  });
});

describe("planCallRecordDeletion (#1091)", () => {
  const me = "me";
  const mine = { id: "$mine", senderId: me, callInfo: { callType: "voice" as const, missed: false, callId: "c1" } };
  const theirs = { id: "$theirs", senderId: "peer", callInfo: { callType: "voice" as const, missed: false, callId: "c1" } };
  const other = { id: "$other", senderId: "peer", callInfo: { callType: "voice" as const, missed: false, callId: "c2" } };

  it("deletes every event of the call, so the other side's hangup does not take the card's place", () => {
    const plan = planCallRecordDeletion([mine, other, theirs], theirs, me, false);
    expect(plan).toEqual([
      { id: "$mine", forEveryone: false },
      { id: "$theirs", forEveryone: false },
    ]);
  });

  it("redacts for everyone only the user's own events", () => {
    const plan = planCallRecordDeletion([mine, theirs], mine, me, true);
    expect(plan).toEqual([
      { id: "$mine", forEveryone: true },
      { id: "$theirs", forEveryone: false },
    ]);
  });

  it("deletes just the record when it has no call id", () => {
    const legacy = { id: "$old", senderId: me, callInfo: { callType: "voice" as const, missed: true } };
    expect(planCallRecordDeletion([legacy, mine], legacy, me, true)).toEqual([{ id: "$old", forEveryone: true }]);
  });
});

describe("dedupeCallEvents — deleted call records (#1091)", () => {
  it("drops a deleted call record instead of showing its card", () => {
    const kept = { id: "$a", callInfo: { callType: "voice" as const, missed: false, callId: "c1" } };
    const deleted = { id: "$b", deleted: true, callInfo: { callType: "voice" as const, missed: false, callId: "c2" } };
    const text = { id: "$t", deleted: true };
    expect(dedupeCallEvents([kept, deleted, text]).map((m) => m.id)).toEqual(["$a", "$t"]);
  });
});
