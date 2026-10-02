/**
 * Regression: opening a chat decrypts its timeline through one crypto worker
 * that serves requests in arrival order. Submitting events chronologically
 * made the newest messages — the bottom of the chat, what the user looks at —
 * decrypt last. parseTimelineEvents must submit newest first while keeping
 * the resulting message list in timeline order.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
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

const ROOM_ID = "!a:s";

const makeEncryptedEvent = (eventId: string, ts: number) => ({
  event: {
    type: "m.room.message",
    content: { msgtype: "m.encrypted", body: "b64" },
    event_id: eventId,
    sender: "@peer:s",
    origin_server_ts: ts,
  },
});

const EVENTS = [
  makeEncryptedEvent("$e1", 1000),
  makeEncryptedEvent("$e2", 2000),
  makeEncryptedEvent("$e3", 3000),
];

const mockMatrixRoom = {
  roomId: ROOM_ID,
  getLiveTimeline: () => ({ getEvents: () => EVENTS }),
  currentState: { getStateEvents: () => [] },
  oldState: { paginationToken: null },
};

const mockMatrixService = {
  getRoom: vi.fn(() => mockMatrixRoom),
  isReady: vi.fn(() => true),
  getUserId: vi.fn(() => "@mock:s"),
  getRooms: vi.fn(() => []),
  getRoomAccountData: vi.fn(() => null),
  getIgnoredMatrixUserIds: vi.fn(() => [] as string[]),
  matrixId: vi.fn((id: string) => id),
  isMe: vi.fn(() => false),
  scrollback: vi.fn(() => Promise.resolve()),
  kit: {
    client: { getUserId: () => "@mock:s" },
    isTetatetChat: vi.fn(() => true),
    getRoomMembers: vi.fn(() => []),
  },
};

vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: vi.fn(() => mockMatrixService),
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

import { useChatStore } from "../chat-store";

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
      hasBufferedWritesFor: vi.fn(() => false),
      clearUnread: vi.fn(async () => {}),
      writeMessages: vi.fn(async () => {}),
      writeEdit: vi.fn(async () => {}),
    },
    db: { rooms: { update: vi.fn(async () => 1) } },
    retryRoomDecryption: vi.fn(),
  };
}

describe("loadRoomMessages — decrypts newest messages first", () => {
  let store: ReturnType<typeof useChatStore>;
  const decryptOrder: string[] = [];

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
    decryptOrder.length = 0;

    const decryptEvent = vi.fn(async (raw: Record<string, unknown>) => {
      decryptOrder.push(raw.event_id as string);
      return { body: `plain ${raw.event_id as string}`, msgtype: "m.text" };
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setHelpers(mockMatrixService.kit as any, { rooms: { [ROOM_ID]: { decryptEvent } } } as any);
    store.rooms = [makeRoom({ id: ROOM_ID })];
    store.activeRoomId = ROOM_ID;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setChatDbKit(makeKit() as any);
  });

  it("submits the newest event to the decryptor first", async () => {
    await store.loadRoomMessages(ROOM_ID);

    expect(decryptOrder).toEqual(["$e3", "$e2", "$e1"]);
  });

  it("keeps the parsed messages in timeline order", async () => {
    await store.loadRoomMessages(ROOM_ID);

    const msgs = store.messages[ROOM_ID] ?? [];
    expect(msgs.map((m) => m.id)).toEqual(["$e1", "$e2", "$e3"]);
    expect(msgs.map((m) => m.content)).toEqual(["plain $e1", "plain $e2", "plain $e3"]);
  });
});
