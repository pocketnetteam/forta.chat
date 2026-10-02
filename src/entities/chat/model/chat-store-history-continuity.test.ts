// @vitest-environment happy-dom
/**
 * History continuity in Dexie (plan docs/plans/2026-09-28-chat-open-local-first.md,
 * stage 3): holes left by limited syncs are marked on the room and closed by
 * the background backfill; scroll-up pages `/messages` from the token stored
 * in Dexie instead of growing the SDK's in-memory timeline.
 * Real Dexie on fake-indexeddb; the Matrix SDK is a fake.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
import { useChatStore } from "./chat-store";
import { makeRoom } from "@/test-utils";
import { ChatDatabase, type LocalMessage, type LocalRoom } from "@/shared/lib/local-db/schema";
import { MessageRepository } from "@/shared/lib/local-db/message-repository";
import { RoomRepository } from "@/shared/lib/local-db/room-repository";
import { UserRepository } from "@/shared/lib/local-db/user-repository";
import { EventWriter } from "@/shared/lib/local-db/event-writer";
import { MessageType } from "./types";

const ROOM = "!a:s";
type Raw = Record<string, unknown>;

const text = (id: string, ts: number): Raw => ({
  type: "m.room.message", content: { msgtype: "m.text", body: `body ${id}` }, event_id: id, sender: "@peer:s", origin_server_ts: ts, room_id: ROOM,
});
const reaction = (id: string, target: string, ts: number): Raw => ({
  type: "m.reaction", content: { "m.relates_to": { rel_type: "m.annotation", event_id: target, key: "👍" } }, event_id: id, sender: "@peer:s", origin_server_ts: ts,
});

let liveEvents: Raw[] = [];
let liveBackToken: string | null = null;
let pages: Record<string, { chunk: Raw[]; end: string | null }> = {};
const fetchMessagesPage = vi.fn(async (_room: string, from: string, _limit: number) => {
  const page = pages[from];
  if (!page) throw new Error(`no page ${from}`);
  return { chunk: page.chunk.map((e) => ({ ...e })), end: page.end };
});
const fetchTokenBefore = vi.fn(async (_room: string, _eventId: string): Promise<string | null> => "ctx0");

const matrixRoom = () => ({
  roomId: ROOM,
  getLiveTimeline: () => ({
    getEvents: () => liveEvents.map((e) => ({ event: e })),
    getPaginationToken: () => liveBackToken,
  }),
  currentState: { getStateEvents: () => null },
  oldState: { paginationToken: liveBackToken },
  getMyMembership: () => "join",
});

vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: vi.fn(() => ({
    getRoom: vi.fn(() => matrixRoom()),
    getRooms: vi.fn(() => [matrixRoom()]),
    isReady: vi.fn(() => true),
    getUserId: vi.fn(() => "@me:s"),
    getRoomAccountData: vi.fn(() => null),
    getIgnoredMatrixUserIds: vi.fn(() => [] as string[]),
    matrixId: vi.fn((id: string) => id),
    isMe: vi.fn((id: string) => id === "@me:s"),
    scrollback: vi.fn(async () => {}),
    fetchMessagesPage,
    fetchTokenBefore,
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

let db: ChatDatabase;
let rooms: RoomRepository;
let messages: MessageRepository;
let writer: EventWriter;
let store: ReturnType<typeof useChatStore>;

const storedRow = (eventId: string, ts: number): LocalMessage => ({
  eventId, clientId: `srv_${eventId}`, roomId: ROOM, senderId: "peer", content: `body ${eventId}`,
  timestamp: ts, type: MessageType.text, status: "synced", version: 1, softDeleted: false,
});

const roomRow = (extra: Partial<LocalRoom> = {}): LocalRoom => ({
  id: ROOM, name: "a", avatar: "", isGroup: true, members: [], membership: "join", unreadCount: 0,
  updatedAt: 0, syncedAt: 0, hasMoreHistory: true, lastReadInboundTs: 0, lastReadOutboundTs: 0,
  isDeleted: false, deletedAt: null, deleteReason: null, ...extra,
} as LocalRoom);

const storedIds = async () => (await db.messages.where("roomId").equals(ROOM).toArray()).map((m) => m.eventId).sort();
const room = () => db.rooms.get(ROOM);

beforeEach(async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  db = new ChatDatabase(`test-continuity-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await db.open();
  messages = new MessageRepository(db);
  rooms = new RoomRepository(db);
  writer = new EventWriter(db, messages, rooms, new UserRepository(db));
  liveEvents = [];
  liveBackToken = null;
  pages = {};
  fetchMessagesPage.mockClear();
  fetchTokenBefore.mockClear();

  setActivePinia(createTestingPinia({ stubActions: false }));
  store = useChatStore();
  store.rooms = [makeRoom({ id: ROOM })];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  store.setChatDbKit({ db, messages, rooms, eventWriter: writer, retryRoomDecryption: vi.fn() } as any);
  store.initialSyncStatus = "ready";
  await db.rooms.put(roomRow());
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.delete();
});

describe("marking holes", () => {
  it("Room.timelineReset marks the hole with the new live timeline's back token", async () => {
    await db.messages.bulkAdd([storedRow("$old", 100)]);
    liveEvents = [text("$n1", 1_000)];
    liveBackToken = "t0";
    pages = { t0: { chunk: [text("$g1", 500), text("$old", 100)], end: "t1" } };

    store.handleTimelineReset(ROOM, "t0");

    await vi.waitFor(async () => expect((await room())?.gapToken).toBe(null)); // marked, then closed by the backfill
    expect(fetchMessagesPage).toHaveBeenCalledWith(ROOM, "t0", 50);
    expect(await storedIds()).toContain("$g1");
  });

  it("marks a hole found on an upgraded install once, and never clears it by itself", async () => {
    await db.messages.bulkAdd([storedRow("$old", 100), storedRow("$n2", 1_100)]);
    liveEvents = [text("$n1", 1_000), text("$n2", 1_100)];
    liveBackToken = "b0";

    await expect(store.checkHistoryContinuity(ROOM)).resolves.toBe(true);
    expect((await room())?.gapToken).toBe("b0");
    expect((await room())?.gapBeforeTs).toBe(1_000);

    liveBackToken = "b1";
    await store.checkHistoryContinuity(ROOM);
    expect((await room())?.gapToken).toBe("b0");
  });

  it("does not call history that was never loaded a hole", async () => {
    liveEvents = [text("$n1", 1_000)];
    liveBackToken = "b0";
    await store.checkHistoryContinuity(ROOM);
    expect((await room())?.gapToken ?? null).toBe(null);
  });
});

describe("backfill", () => {
  beforeEach(async () => {
    await db.messages.bulkAdd([storedRow("$old", 100), storedRow("$n1", 1_000)]);
    liveEvents = [text("$n1", 1_000)];
    await db.rooms.update(ROOM, { gapToken: "t0", gapBeforeTs: 1_000 });
  });

  it("pages back until it reaches stored history, writes only new events, clears the hole", async () => {
    pages = {
      t0: { chunk: [text("$g3", 900), reaction("$r", "$g1", 950), text("$g2", 800)], end: "t1" },
      t1: { chunk: [text("$g1", 700), text("$old", 100)], end: "t2" },
    };

    store.backfillRoom(ROOM);

    await vi.waitFor(async () => expect((await room())?.gapToken).toBe(null));
    expect(fetchMessagesPage).toHaveBeenCalledTimes(2);
    expect(await storedIds()).toEqual(["$g1", "$g2", "$g3", "$n1", "$old"]);
    // The reaction came a page before its message and still landed on it.
    const g1 = await messages.getByEventId("$g1");
    expect(g1?.reactions?.["👍"]?.count).toBe(1);
  });

  it("keeps the hole marked when a page fails", async () => {
    pages = {};
    store.backfillRoom(ROOM);
    await vi.waitFor(() => expect(fetchMessagesPage).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect((await room())?.gapToken).toBe("t0");
  });

  it("does not write messages from before a history clear", async () => {
    writer.setClearedAtTs(ROOM, 750);
    pages = { t0: { chunk: [text("$g2", 800), text("$g1", 700)], end: "t1" } };

    store.backfillRoom(ROOM);

    await vi.waitFor(async () => expect((await room())?.gapToken).toBe(null));
    const ids = await storedIds();
    expect(ids).toContain("$g2");
    expect(ids).not.toContain("$g1");
    expect(fetchMessagesPage).toHaveBeenCalledTimes(1);
  });
});

describe("scroll-up from the stored token", () => {
  beforeEach(() => {
    store.activeRoomId = ROOM;
  });

  it("after a restart pages from the token saved in Dexie, not from the SDK timeline", async () => {
    await db.rooms.update(ROOM, { paginationToken: "p5" });
    pages = { p5: { chunk: [text("$h2", 200), text("$h1", 100)], end: "p6" } };

    await expect(store.loadMoreMessages(ROOM)).resolves.toBe(true);

    expect(fetchMessagesPage).toHaveBeenCalledWith(ROOM, "p5", 50);
    expect(await storedIds()).toEqual(["$h1", "$h2"]);
    expect((await room())?.paginationToken).toBe("p6");
  });

  it("starts from /context of the oldest stored message the first time", async () => {
    await db.messages.bulkAdd([storedRow("$oldest", 100), storedRow("$newer", 200)]);
    pages = { ctx0: { chunk: [text("$h1", 50)], end: null } };

    await expect(store.loadMoreMessages(ROOM)).resolves.toBe(false); // start of the room

    expect(fetchTokenBefore).toHaveBeenCalledWith(ROOM, "$oldest");
    expect((await room())?.hasMoreHistory).toBe(false);
  });

  it("makes no request once the start of the room was reached", async () => {
    await db.rooms.update(ROOM, { hasMoreHistory: false, paginationToken: undefined });
    await expect(store.loadMoreMessages(ROOM)).resolves.toBe(false);
    expect(fetchMessagesPage).not.toHaveBeenCalled();
  });
});

describe("review follow-ups", () => {
  const edit = (id: string, target: string, body: string, ts: number): Raw => ({
    type: "m.room.message",
    content: { msgtype: "m.text", body: `* ${body}`, "m.new_content": { msgtype: "m.text", body }, "m.relates_to": { rel_type: "m.replace", event_id: target } },
    event_id: id, sender: "@peer:s", origin_server_ts: ts,
  });

  it("applies the newest of two edits from a newest-first page", async () => {
    await db.messages.bulkAdd([storedRow("$old", 100), storedRow("$n1", 1_000)]);
    liveEvents = [text("$n1", 1_000)];
    await db.rooms.update(ROOM, { gapToken: "t0", gapBeforeTs: 1_000, gapAnchorTs: 100 });
    pages = { t0: { chunk: [edit("$e2", "$m", "C", 700), edit("$e1", "$m", "B", 600), text("$m", 500), text("$old", 100)], end: "t1" } };

    store.backfillRoom(ROOM);

    await vi.waitFor(async () => expect((await room())?.gapToken).toBe(null));
    expect((await messages.getByEventId("$m"))?.content).toBe("C");
  });

  it("closes a hole at the anchor fixed when it was marked, not at rows written into it since", async () => {
    // $mid landed inside the hole later (e.g. an SDK scrollback of another load).
    await db.messages.bulkAdd([storedRow("$old", 100), storedRow("$mid", 600), storedRow("$n1", 1_000)]);
    liveEvents = [text("$n1", 1_000)];
    await db.rooms.update(ROOM, { gapToken: "t0", gapBeforeTs: 1_000, gapAnchorTs: 100 });
    pages = {
      t0: { chunk: [text("$g2", 800), text("$mid", 600)], end: "t1" },
      t1: { chunk: [text("$g1", 400), text("$old", 100)], end: "t2" },
    };

    store.backfillRoom(ROOM);

    await vi.waitFor(async () => expect((await room())?.gapToken).toBe(null));
    expect(fetchMessagesPage).toHaveBeenCalledTimes(2);
    expect(await storedIds()).toContain("$g1");
  });

  it("does not mark a hole when the oldest live event is stored but not decrypted", async () => {
    await db.messages.bulkAdd([
      storedRow("$old", 100),
      { ...storedRow("$n1", 1_000), content: "[encrypted]", decryptionStatus: "failed" },
    ]);
    liveEvents = [text("$n1", 1_000)];
    liveBackToken = "b0";

    await store.checkHistoryContinuity(ROOM);

    expect((await room())?.gapToken ?? null).toBe(null);
  });

  it("falls back to SDK scrollback when /context fails instead of ending the history", async () => {
    await db.messages.bulkAdd([storedRow("$oldest", 100)]);
    fetchTokenBefore.mockRejectedValueOnce(new Error("network down"));
    store.activeRoomId = ROOM;

    await store.loadMoreMessages(ROOM);

    const { getMatrixClientService } = await import("@/entities/matrix");
    // SDK scrollback was tried; the room still has history to page.
    expect((await room())?.hasMoreHistory).toBe(true);
    expect(getMatrixClientService).toHaveBeenCalled();
  });

  it("writes the SDK's unwritten events when a room is opened, without the queue", async () => {
    await db.messages.bulkAdd([storedRow("$old", 100)]);
    liveEvents = [text("$old", 100), text("$fresh", 2_000)];
    store.initialSyncStatus = "loading"; // the queue may not run yet
    store.activeRoomId = ROOM;

    await store.refreshOpenedRoom(ROOM);

    expect(await storedIds()).toContain("$fresh");
  });
});

describe("second review follow-ups", () => {
  beforeEach(async () => {
    await db.messages.bulkAdd([storedRow("$old", 100), storedRow("$n1", 1_000)]);
    liveEvents = [text("$n1", 1_000)];
  });

  it("fixes the anchor it computed, so the next pass cannot pick a row it wrote", async () => {
    await db.rooms.update(ROOM, { gapToken: "t0", gapBeforeTs: 1_000 });
    pages = {}; // the page fails: the pass stops after computing the anchor
    store.backfillRoom(ROOM);
    await vi.waitFor(() => expect(fetchMessagesPage).toHaveBeenCalled());
    await vi.waitFor(async () => expect((await room())?.gapAnchorTs).toBe(100));
  });

  it("applies edits and reactions from the hole to messages stored before it", async () => {
    await db.rooms.update(ROOM, { gapToken: "t0", gapBeforeTs: 1_000, gapAnchorTs: 100 });
    await db.messages.update((await messages.getByEventId("$old"))!.localId!, {
      reactions: { "🔥": { count: 1, users: ["someone"] } },
    });
    pages = {
      t0: {
        chunk: [
          reaction("$r", "$old", 900),
          { type: "m.room.message", content: { msgtype: "m.text", body: "* fixed", "m.new_content": { msgtype: "m.text", body: "fixed" }, "m.relates_to": { rel_type: "m.replace", event_id: "$old" } }, event_id: "$e", sender: "@peer:s", origin_server_ts: 800 },
          text("$g", 500),
          text("$old", 100),
        ],
        end: "t1",
      },
    };

    store.backfillRoom(ROOM);

    await vi.waitFor(async () => expect((await room())?.gapToken).toBe(null));
    const old = await messages.getByEventId("$old");
    expect(old?.content).toBe("fixed");
    expect(Object.keys(old?.reactions ?? {}).sort()).toEqual(["👍", "🔥"]); // merged, not overwritten
  });
});

