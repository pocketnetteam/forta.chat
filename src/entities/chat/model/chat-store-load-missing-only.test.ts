// @vitest-environment happy-dom
/**
 * History loads parse only what Dexie lacks (plan
 * docs/plans/2026-09-28-chat-open-local-first.md, stage 2). Re-parsing the
 * whole SDK timeline on every room open decrypted the same events again and
 * again, rewrote them, and grew with every scrollback.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
import { useChatStore } from "./chat-store";
import { makeRoom } from "@/test-utils";

vi.mock("dexie", async (importOriginal) => {
  const actual = await importOriginal<typeof import("dexie")>();
  return {
    ...actual,
    liveQuery: (querier: () => unknown) => ({
      subscribe(sub: { next: (v: unknown) => void; error: (e: unknown) => void }) {
        let active = true;
        Promise.resolve()
          .then(() => querier())
          .then(
            (v) => { if (active) sub.next(v); },
            (e) => { if (active) sub.error(e); },
          );
        return { unsubscribe() { active = false; } };
      },
    }),
  };
});

type Raw = Record<string, unknown>;
const ev = (raw: Raw) => ({ event: raw });
const text = (id: string, ts: number, sender = "@peer:s") =>
  ev({ type: "m.room.message", content: { msgtype: "m.text", body: `body ${id}` }, event_id: id, sender, origin_server_ts: ts });
const reaction = (id: string, target: string, key: string, ts: number) =>
  ev({ type: "m.reaction", content: { "m.relates_to": { rel_type: "m.annotation", event_id: target, key } }, event_id: id, sender: "@peer:s", origin_server_ts: ts });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let room: any;
const scrollback = vi.fn(() => Promise.resolve());
const fetchRoomEvent = vi.fn(async (_room: string, _id: string): Promise<Raw | null> => null);

vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: vi.fn(() => ({
    getRoom: vi.fn(() => room),
    isReady: vi.fn(() => true),
    getUserId: vi.fn(() => "@me:s"),
    getRooms: vi.fn(() => []),
    getRoomAccountData: vi.fn(() => null),
    getIgnoredMatrixUserIds: vi.fn(() => [] as string[]),
    matrixId: vi.fn((id: string) => id),
    isMe: vi.fn((id: string) => id === "@me:s"),
    scrollback,
    client: { fetchRoomEvent },
  })),
  MatrixClientService: vi.fn(),
  resetMatrixClientService: vi.fn(),
}));

vi.mock("@/shared/lib/cache/chat-cache", () => ({
  cacheRooms: vi.fn(() => Promise.resolve()),
  getCachedRooms: vi.fn(() => Promise.resolve([])),
  cacheMessages: vi.fn(() => Promise.resolve()),
  getCachedMessages: vi.fn(() => Promise.resolve([])),
  getCacheTimestamp: vi.fn(() => Promise.resolve(null)),
}));

const makeRoomWith = (events: unknown[], extra: Raw = {}) => ({
  roomId: "!a:s",
  getLiveTimeline: () => ({ getEvents: () => events }),
  currentState: { getStateEvents: () => null },
  oldState: { paginationToken: null },
  ...extra,
});

/** Stored rows, keyed by eventId — what getByEventIds finds. */
let stored: Map<string, Raw>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let kit: any;

function makeKit() {
  return {
    rooms: {
      getAllRooms: vi.fn(async () => []),
      observeRoomChanges: vi.fn(() => () => {}),
      bulkSyncRooms: vi.fn(async () => {}),
      getRoom: vi.fn(async () => undefined),
      updateOutboundWatermark: vi.fn(async () => {}),
    },
    messages: {
      getMessages: vi.fn(async () => []),
      patchUnresolvedReplies: vi.fn(async () => {}),
      updateReactions: vi.fn(async () => {}),
      bulkUpdateReactions: vi.fn(async () => 0),
      getByEventIds: vi.fn(async (ids: string[]) => ids.map((id) => stored.get(id)).filter(Boolean)),
    },
    eventWriter: {
      enableBatching: vi.fn(),
      getClearedAtTs: vi.fn(() => undefined),
      setClearedAtTs: vi.fn(),
      flushWriteBuffer: vi.fn(() => Promise.resolve()),
      hasBufferedWritesFor: vi.fn(() => false),
      clearUnread: vi.fn(async () => {}),
      writeMessages: vi.fn(async (_msgs: Array<{ eventId: string }>) => {}),
      writeEdit: vi.fn(async () => {}),
    },
    db: { rooms: { update: vi.fn(async () => 1) } },
    retryRoomDecryption: vi.fn(),
  };
}

const row = (id: string, extra: Raw = {}): Raw => ({ eventId: id, roomId: "!a:s", content: `body ${id}`, decryptionStatus: "ok", ...extra });
const flush = () => new Promise((r) => setTimeout(r, 0));
const writtenIds = () => kit.eventWriter.writeMessages.mock.calls.flatMap((c: [Array<{ eventId: string }>]) => c[0].map((m) => m.eventId));

describe("chat-store — history loads parse only events missing from Dexie", () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
    store.rooms = [makeRoom({ id: "!a:s" })];
    store.activeRoomId = "!a:s";
    stored = new Map();
    scrollback.mockClear();
    kit = makeKit();
    store.setChatDbKit(kit);
  });

  it("parses and writes only the 10 of 100 events Dexie lacks", async () => {
    const events = Array.from({ length: 100 }, (_, i) => text(`$e${i}`, 1_000 + i));
    for (let i = 0; i < 90; i++) stored.set(`$e${i}`, row(`$e${i}`));
    room = makeRoomWith(events);

    const count = await store.loadRoomMessages("!a:s");
    await flush();

    expect(writtenIds()).toEqual(Array.from({ length: 10 }, (_, i) => `$e${90 + i}`));
    expect(count).toBe(100); // the room is not empty — 90 of its messages were already stored
  });

  it("writes nothing when every event is stored", async () => {
    stored.set("$a", row("$a"));
    room = makeRoomWith([text("$a", 1_000)]);

    await store.loadRoomMessages("!a:s");
    await flush();

    expect(kit.eventWriter.writeMessages).not.toHaveBeenCalled();
  });

  it("re-parses a stored row still waiting for decryption", async () => {
    stored.set("$a", row("$a", { content: "[encrypted]", decryptionStatus: "pending" }));
    room = makeRoomWith([text("$a", 1_000)]);

    await store.loadRoomMessages("!a:s");
    await flush();

    expect(writtenIds()).toEqual(["$a"]);
  });

  it("marks a new hangup missed from an invite that is already stored", async () => {
    const invite = ev({ type: "m.call.invite", content: { call_id: "c1" }, event_id: "$inv", sender: "@peer:s", origin_server_ts: 1_000 });
    const hangup = ev({ type: "m.call.hangup", content: { call_id: "c1", reason: "user_hangup" }, event_id: "$hang", sender: "@peer:s", origin_server_ts: 2_000 });
    stored.set("$inv", row("$inv"));
    room = makeRoomWith([invite, hangup]);

    await store.loadRoomMessages("!a:s");
    await flush();

    const written = kit.eventWriter.writeMessages.mock.calls[0][0] as Array<{ eventId: string; callInfo?: { missed?: boolean } }>;
    const hangupRow = written.find((m) => m.eventId === "$hang");
    expect(hangupRow?.callInfo?.missed).toBe(true);
  });

  it("writes a reaction on an already-stored message without re-parsing it", async () => {
    stored.set("$old", row("$old"));
    room = makeRoomWith([text("$old", 1_000), reaction("$r1", "$old", "👍", 2_000)]);

    await store.loadRoomMessages("!a:s");
    await flush();

    expect(kit.eventWriter.writeMessages).not.toHaveBeenCalled();
    expect(kit.messages.bulkUpdateReactions).toHaveBeenCalledWith([
      { eventId: "$old", reactions: { "👍": { count: 1, users: [expect.any(String)] } } },
    ]);
  });

  it("seeds the read watermark from receipts without parsing anything", async () => {
    const mine = text("$mine", 1_000, "@me:s");
    stored.set("$mine", row("$mine"));
    room = makeRoomWith([mine], {
      getReceiptsForEvent: (e: unknown) => (e === mine ? [{ userId: "@peer:s", type: "m.read" }] : []),
    });

    await store.loadRoomMessages("!a:s");

    expect(kit.eventWriter.writeMessages).not.toHaveBeenCalled();
    expect(kit.rooms.updateOutboundWatermark).toHaveBeenCalledWith("!a:s", 1_000);
  });

  it("drops the parse and the write when the user leaves the room meanwhile", async () => {
    room = makeRoomWith([text("$new", 1_000)]);
    let release!: () => void;
    kit.messages.getByEventIds.mockImplementationOnce(
      () => new Promise((r) => { release = () => r([]); }),
    );

    const pending = store.loadRoomMessages("!a:s");
    await flush();
    store.setActiveRoom(null);
    release();
    await pending;
    await flush();

    expect(kit.eventWriter.writeMessages).not.toHaveBeenCalled();
  });

  it("drops the work of a visit even when the user comes back to the same room", async () => {
    room = makeRoomWith([text("$new", 1_000)]);
    let release!: () => void;
    kit.messages.getByEventIds.mockImplementationOnce(
      () => new Promise((r) => { release = () => r([]); }),
    );

    const pending = store.loadRoomMessages("!a:s");
    await flush();
    store.setActiveRoom(null);
    store.setActiveRoom("!a:s");
    release();
    await pending;
    await flush();

    expect(kit.eventWriter.writeMessages).not.toHaveBeenCalled();
  });
});

describe("chat-store — isRoomInSyncWithSdk", () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
    stored = new Map();
    kit = makeKit();
    store.setChatDbKit(kit);
  });

  it("is in sync when every message of a complete timeline is stored", async () => {
    stored.set("$a", row("$a"));
    stored.set("$b", row("$b"));
    room = makeRoomWith([text("$a", 1), reaction("$r", "$a", "👍", 2), text("$b", 3)]);
    await expect(store.isRoomInSyncWithSdk("!a:s")).resolves.toBe(true);
  });

  it("is out of sync when the latest message is missing", async () => {
    stored.set("$a", row("$a"));
    room = makeRoomWith([text("$a", 1), text("$b", 2)]);
    await expect(store.isRoomInSyncWithSdk("!a:s")).resolves.toBe(false);
  });

  it("is out of sync for a short timeline that can still scroll back (limited sync)", async () => {
    stored.set("$a", row("$a"));
    room = makeRoomWith([text("$a", 1)], { oldState: { paginationToken: "t1" } });
    await expect(store.isRoomInSyncWithSdk("!a:s")).resolves.toBe(false);
  });
});

describe("chat-store — pinned messages and prefetch without a history load", () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
    store.rooms = [makeRoom({ id: "!a:s" })];
    stored = new Map();
    scrollback.mockClear();
    kit = makeKit();
    store.setChatDbKit(kit);
  });

  it("loadPinnedMessages resolves pins from Dexie", async () => {
    stored.set("$pin", row("$pin", { senderId: "peer", timestamp: 1_000, type: "text", status: "synced" }));
    room = makeRoomWith([], {
      currentState: { getStateEvents: () => ({ getContent: () => ({ pinned: ["$pin"] }) }) },
    });
    store.activeRoomId = "!a:s";

    await store.loadPinnedMessages("!a:s");

    expect(store.pinnedMessages.map((m) => m.id)).toEqual(["$pin"]);
    expect(kit.eventWriter.writeMessages).not.toHaveBeenCalled();
  });

  const olderRowsInDexie = (olderCount: number) =>
    kit.messages.getMessages.mockImplementation(async (_room: string, limit: number, before?: number) =>
      before !== undefined
        ? Array.from({ length: Math.min(limit, olderCount) }, (_, i) => row(`$old${i}`, { timestamp: 1_000 + i }))
        : [row("$a", { timestamp: 5_000, senderId: "peer", type: "text", status: "synced" })],
    );

  it("prefetchNextBatch skips scrollback while Dexie holds a page of older rows", async () => {
    room = makeRoomWith([text("$a", 5_000)]);
    olderRowsInDexie(80);
    store.setActiveRoom("!a:s");
    await flush();
    await flush();

    await expect(store.prefetchNextBatch("!a:s")).resolves.toBe(true);
    expect(scrollback).not.toHaveBeenCalled();
  });

  it("prefetchNextBatch pages the server ahead when Dexie has less than a page left", async () => {
    room = makeRoomWith([text("$a", 5_000)]);
    olderRowsInDexie(10);
    store.setActiveRoom("!a:s");
    await flush();
    await flush();

    await store.prefetchNextBatch("!a:s");
    expect(scrollback).toHaveBeenCalledTimes(1);
  });

  it("prefetchNextBatch parses only the page scrollback prepended", async () => {
    const events: unknown[] = [text("$a", 5_000)];
    room = makeRoomWith(events);
    scrollback.mockImplementationOnce(async () => { events.unshift(text("$p1", 1_000), text("$p2", 2_000)); });
    store.setActiveRoom("!a:s");
    await flush();

    await store.prefetchNextBatch("!a:s");

    expect(scrollback).toHaveBeenCalledTimes(1);
    expect(writtenIds()).toEqual(["$p1", "$p2"]);
  });
});

describe("chat-store — setActiveRoom and the write buffer", () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
    store.rooms = [makeRoom({ id: "!a:s" })];
    room = makeRoomWith([]);
    kit = makeKit();
    store.setChatDbKit(kit);
  });

  it("does not drain every room's buffer when leaving a chat", () => {
    store.setActiveRoom("!a:s");
    kit.eventWriter.flushWriteBuffer.mockClear();
    store.setActiveRoom(null);
    expect(kit.eventWriter.flushWriteBuffer).not.toHaveBeenCalled();
  });

  it("flushes on entry only when the entered room has buffered events", () => {
    kit.eventWriter.hasBufferedWritesFor.mockImplementation((id: string) => id === "!a:s");
    store.setActiveRoom("!b:s");
    expect(kit.eventWriter.flushWriteBuffer).not.toHaveBeenCalled();
    store.setActiveRoom("!a:s");
    expect(kit.eventWriter.flushWriteBuffer).toHaveBeenCalledTimes(1);
  });
});

describe("chat-store — history-load repairs (review follow-ups)", () => {
  let store: ReturnType<typeof useChatStore>;
  const call = (type: string, id: string, sender: string, ts: number, content: Raw = {}) =>
    ev({ type, content: { call_id: "c1", ...content }, event_id: id, sender, origin_server_ts: ts });

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
    store.rooms = [makeRoom({ id: "!a:s" })];
    store.activeRoomId = "!a:s";
    stored = new Map();
    kit = makeKit();
    store.setChatDbKit(kit);
  });

  it("does not re-parse an answered call on every load", async () => {
    room = makeRoomWith([
      call("m.call.invite", "$inv", "@peer:s", 1),
      call("m.call.answer", "$ans", "@me:s", 2),
      call("m.call.hangup", "$hang", "@peer:s", 3, { reason: "user_hangup" }),
    ]);
    stored.set("$inv", row("$inv"));
    stored.set("$ans", row("$ans"));
    stored.set("$hang", row("$hang", { callInfo: { callType: "voice", missed: false, duration: 5 } }));

    await store.loadRoomMessages("!a:s");
    await flush();

    expect(kit.eventWriter.writeMessages).not.toHaveBeenCalled();
    await expect(store.isRoomInSyncWithSdk("!a:s")).resolves.toBe(true);
  });

  it("re-parses a stored hangup that now reads as missed", async () => {
    room = makeRoomWith([
      call("m.call.invite", "$inv", "@peer:s", 1),
      call("m.call.hangup", "$hang", "@peer:s", 3, { reason: "user_hangup" }),
    ]);
    stored.set("$inv", row("$inv"));
    stored.set("$hang", row("$hang", { callInfo: { callType: "voice", missed: false, duration: 0 } }));

    await expect(store.isRoomInSyncWithSdk("!a:s")).resolves.toBe(false);
    await store.loadRoomMessages("!a:s");
    await flush();

    expect(writtenIds()).toEqual(["$hang"]);
  });

  it("is out of sync while an edit in the timeline is not applied in Dexie", async () => {
    stored.set("$m", row("$m", { lastEditTs: 0 }));
    room = makeRoomWith([
      text("$m", 1),
      ev({ type: "m.room.message", content: { msgtype: "m.text", body: "* new", "m.new_content": { body: "new" }, "m.relates_to": { rel_type: "m.replace", event_id: "$m" } }, event_id: "$edit", sender: "@peer:s", origin_server_ts: 2 }),
    ]);
    await expect(store.isRoomInSyncWithSdk("!a:s")).resolves.toBe(false);
  });

  it("writes what it already decrypted even if the user left meanwhile", async () => {
    room = makeRoomWith([text("$new", 1_000)]);
    const pending = store.loadRoomMessages("!a:s");
    await flush(); // past the Dexie lookup, parse under way
    store.setActiveRoom(null);
    await pending;
    await flush();
    expect(writtenIds()).toEqual(["$new"]);
  });

  it("still resolves empty reply previews when nothing needs parsing", async () => {
    stored.set("$a", row("$a"));
    room = makeRoomWith([text("$a", 1)]);

    await store.loadRoomMessages("!a:s");
    await flush();

    expect(kit.messages.getMessages).toHaveBeenCalledWith("!a:s", 200, undefined, undefined);
  });
});

describe("chat-store — pins and reply previews on a first open", () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
    store.rooms = [makeRoom({ id: "!a:s" })];
    store.activeRoomId = "!a:s";
    stored = new Map();
    fetchRoomEvent.mockReset();
    kit = makeKit();
    store.setChatDbKit(kit);
  });

  it("shows a pin of a message the first load just parsed", async () => {
    room = makeRoomWith([text("$p", 1_000)], {
      currentState: { getStateEvents: () => ({ getContent: () => ({ pinned: ["$p"] }) }) },
    });

    await store.loadRoomMessages("!a:s");
    await flush();
    await flush();

    expect(store.pinnedMessages.map((m) => m.id)).toEqual(["$p"]);
  });

  it("retries a quoted event whose fetch failed on the network, not one the server answered", async () => {
    const unresolved = row("$reply", { replyTo: { id: "$quoted", senderId: "", content: "" } });
    kit.messages.getMessages.mockImplementation(async () => [unresolved]);
    stored.set("$a", row("$a"));
    room = makeRoomWith([text("$a", 1)]);
    fetchRoomEvent.mockRejectedValueOnce(new Error("network down"));

    await store.loadRoomMessages("!a:s");
    await flush();
    await store.loadRoomMessages("!a:s"); // retried: the first attempt never reached the server
    await flush();
    await store.loadRoomMessages("!a:s"); // server answered (null) — not asked again
    await flush();

    expect(fetchRoomEvent).toHaveBeenCalledTimes(2);
  });
});

