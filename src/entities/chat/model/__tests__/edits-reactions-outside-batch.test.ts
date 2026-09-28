/**
 * Audit S3-03: an edit or a reaction whose target message was not in the same
 * parsed batch (an older message) was skipped, so it showed only after a later
 * scroll re-parsed both events together. They now go to the event writer,
 * which updates the stored message or keeps them until it lands.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
import { useChatStore } from "../chat-store";
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

const event = (e: Record<string, unknown>) => ({ event: e });
const TIMELINE = [
  event({
    type: "m.room.message",
    content: { msgtype: "m.text", body: "new message" },
    event_id: "$new",
    sender: "@peer:s",
    origin_server_ts: 2000,
  }),
  event({
    type: "m.room.message",
    content: {
      msgtype: "m.text",
      body: "* fixed text",
      "m.new_content": { msgtype: "m.text", body: "fixed text" },
      "m.relates_to": { rel_type: "m.replace", event_id: "$old" },
    },
    event_id: "$edit",
    sender: "@peer:s",
    origin_server_ts: 2100,
  }),
  event({
    type: "m.reaction",
    content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$old", key: "👍" } },
    event_id: "$reaction",
    sender: "@peer:s",
    origin_server_ts: 2200,
  }),
];

vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: vi.fn(() => ({
    getRoom: vi.fn(() => ({
      roomId: "!a:s",
      getLiveTimeline: () => ({ getEvents: () => TIMELINE }),
      currentState: { getStateEvents: () => [] },
      oldState: { paginationToken: null },
    })),
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

const writeEdit = vi.fn(async () => {});
const writeReaction = vi.fn(async () => {});

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
      getClearedAtTs: vi.fn(() => undefined),
      setClearedAtTs: vi.fn(),
      flushWriteBuffer: vi.fn(() => Promise.resolve()),
      clearUnread: vi.fn(async () => {}),
      writeMessages: vi.fn(async () => {}),
      writeEdit,
      writeReaction,
    },
    db: { rooms: { update: vi.fn(async () => 1) } },
    retryRoomDecryption: vi.fn(),
  };
}

describe("loadRoomMessages — edits and reactions to a message outside the batch", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setActivePinia(createTestingPinia({ stubActions: false }));
    writeEdit.mockClear();
    writeReaction.mockClear();
  });

  it("hands both to the event writer instead of skipping them", async () => {
    const store = useChatStore();
    store.rooms = [makeRoom({ id: "!a:s" })];
    store.activeRoomId = "!a:s";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setChatDbKit(makeKit() as any);

    await store.loadRoomMessages("!a:s");

    expect(writeEdit).toHaveBeenCalledWith(
      "!a:s",
      expect.objectContaining({ targetEventId: "$old", newContent: "fixed text", editTs: 2100 }),
    );
    expect(writeReaction).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "$reaction", targetEventId: "$old", emoji: "👍", isMine: false }),
    );
  });
});
