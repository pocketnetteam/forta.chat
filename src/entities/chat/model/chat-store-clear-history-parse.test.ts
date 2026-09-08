/**
 * Regression test: loadRoomMessages() must exclude pre-clear timeline events
 * BEFORE parsing/decrypting them, not just from the final displayed list.
 *
 * "Clear history" (clearHistory() in room-repository.ts) never touches the
 * underlying Matrix room or its own Dexie message rows — it only stamps a
 * clearedAtTs cutoff on the room. The full pre-clear history stays in the
 * SDK's timeline forever. Filtering by clearedAtTs *after* parseTimelineEvents
 * meant every room open re-decrypted the entire pre-clear history just to
 * throw almost all of it away a few lines later — the actual cost behind an
 * emptied "cleared" chat sitting on a skeleton for a long time with zero
 * network activity (nothing needed fetching — the SDK already had it all).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
import { useChatStore } from "./chat-store";
import { MessageStatus } from "./types";
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

const CLEARED_AT_TS = 1000;

// A plain (unencrypted) text message — avoids needing a Pcrypto mock, since
// this test only cares about which events reach the parser, not decryption.
const makeTextEvent = (eventId: string, ts: number, body: string) => ({
  event: {
    type: "m.room.message",
    content: { msgtype: "m.text", body },
    event_id: eventId,
    sender: "@peer:s",
    origin_server_ts: ts,
  },
});

const PRE_CLEAR_EVENT = makeTextEvent("$before", CLEARED_AT_TS - 500, "before the clear");
const POST_CLEAR_EVENT = makeTextEvent("$after", CLEARED_AT_TS + 500, "after the clear");

const mockMatrixRoom = {
  roomId: "!a:s",
  getLiveTimeline: () => ({ getEvents: () => [PRE_CLEAR_EVENT, POST_CLEAR_EVENT] }),
  currentState: { getStateEvents: () => [] },
  // null: the SDK already confirms this is the start of the room, so the
  // pagination gate never tries to scroll back further — irrelevant to what
  // this test checks (the clear-history cutoff applied before parsing).
  oldState: { paginationToken: null },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let currentMockRoom: any = mockMatrixRoom;

vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: vi.fn(() => ({
    getRoom: vi.fn(() => currentMockRoom),
    isReady: vi.fn(() => true),
    getUserId: vi.fn(() => "@mock:s"),
    getRooms: vi.fn(() => []),
    getRoomAccountData: vi.fn(() => null),
    getIgnoredMatrixUserIds: vi.fn(() => [] as string[]),
    matrixId: vi.fn((id: string) => id),
    isMe: vi.fn(() => false),
    scrollback: vi.fn(() => Promise.resolve()),
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

const writeMessages = vi.fn((_msgs: Array<{ eventId: string }>) => Promise.resolve());

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
      getMessages: vi.fn(() => Promise.resolve([])),
      patchUnresolvedReplies: vi.fn(async () => {}),
      updateReactions: vi.fn(async () => {}),
      getByEventIds: vi.fn(async () => []),
    },
    eventWriter: {
      enableBatching: vi.fn(),
      getClearedAtTs: vi.fn(() => CLEARED_AT_TS),
      setClearedAtTs: vi.fn(),
      flushWriteBuffer: vi.fn(() => Promise.resolve()),
      clearUnread: vi.fn(async () => {}),
      writeMessages,
      writeEdit: vi.fn(async () => {}),
    },
    db: { rooms: { update: vi.fn(async () => 1) } },
    retryRoomDecryption: vi.fn(),
  };
}

describe("loadRoomMessages — clear-history cutoff applied before parsing", () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
    store.rooms = [makeRoom({ id: "!a:s" })];
    store.activeRoomId = "!a:s";
    writeMessages.mockClear();
    currentMockRoom = mockMatrixRoom;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setChatDbKit(makeKit() as any);
  });

  it("never parses the pre-clear event into activeMessages", async () => {
    await store.loadRoomMessages("!a:s");

    const ids = (store.messages["!a:s"] ?? []).map(m => m.id);
    expect(ids).toContain("$after");
    expect(ids).not.toContain("$before");
  });

  it("never re-persists the pre-clear event to Dexie", async () => {
    await store.loadRoomMessages("!a:s");

    expect(writeMessages).toHaveBeenCalledTimes(1);
    const written = writeMessages.mock.calls[0][0];
    const writtenIds = written.map(m => m.eventId);
    expect(writtenIds).toContain("$after");
    expect(writtenIds).not.toContain("$before");
  });
});

describe("loadRoomMessages — read receipts vs. the clear-history cutoff", () => {
  let store: ReturnType<typeof useChatStore>;

  const MY_OWN_POST_CLEAR_EVENT = makeTextEvent("$myMsg", CLEARED_AT_TS + 500, "hi after the clear");
  MY_OWN_POST_CLEAR_EVENT.event.sender = "@mock:s"; // matches getUserId() below

  // A non-message event (never becomes a parsed Message) timestamped after
  // everything else — used to model "the peer's receipt points at something
  // newer than our whole loaded window" without needing real pagination.
  const REACTION_AFTER_ALL = {
    event: {
      type: "m.reaction",
      content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$myMsg", key: "👍" } },
      event_id: "$reaction1",
      sender: "@peer:s",
      origin_server_ts: CLEARED_AT_TS + 1000,
    },
  };

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
    store.rooms = [makeRoom({ id: "!a:s" })];
    store.activeRoomId = "!a:s";
    writeMessages.mockClear();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setChatDbKit(makeKit() as any);
  });

  it("does NOT mark a post-clear message read just because the peer's last receipt sits on a pre-clear (now-hidden) event", async () => {
    // The peer's last read receipt is on the pre-clear event — they haven't
    // necessarily read anything sent after the clear. Finding that receipt
    // by scanning the full timeline must not be misread as "the peer has
    // read everything we're showing" — that would falsely tick "read" on a
    // message the peer may never have opened.
    currentMockRoom = {
      roomId: "!a:s",
      getLiveTimeline: () => ({ getEvents: () => [PRE_CLEAR_EVENT, MY_OWN_POST_CLEAR_EVENT] }),
      currentState: { getStateEvents: () => [] },
      oldState: { paginationToken: null },
      getReceiptsForEvent: (ev: unknown) =>
        ev === PRE_CLEAR_EVENT ? [{ userId: "@peer:s", type: "m.read" }] : [],
    };

    await store.loadRoomMessages("!a:s");

    const myMsg = (store.messages["!a:s"] ?? []).find(m => m.id === "$myMsg");
    expect(myMsg?.status).toBe(MessageStatus.sent);
  });

  it("still marks a post-clear message read when the peer's receipt is genuinely newer than everything loaded", async () => {
    // The receipt sits on a reaction event (never parsed into msgs) that is
    // chronologically AFTER our own message — the peer has read past
    // everything we have, so it must still be marked read.
    currentMockRoom = {
      roomId: "!a:s",
      getLiveTimeline: () => ({ getEvents: () => [PRE_CLEAR_EVENT, MY_OWN_POST_CLEAR_EVENT, REACTION_AFTER_ALL] }),
      currentState: { getStateEvents: () => [] },
      oldState: { paginationToken: null },
      getReceiptsForEvent: (ev: unknown) =>
        ev === REACTION_AFTER_ALL ? [{ userId: "@peer:s", type: "m.read" }] : [],
    };

    await store.loadRoomMessages("!a:s");

    const myMsg = (store.messages["!a:s"] ?? []).find(m => m.id === "$myMsg");
    expect(myMsg?.status).toBe(MessageStatus.read);
  });
});
