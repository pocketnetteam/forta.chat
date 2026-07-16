/**
 * Regression: opening a chat after being away streams a backlog of messages,
 * each surfacing as a Dexie room delta. The sidebar (sortedRooms) must NOT
 * re-sort per delta — it should coalesce the burst and apply a single re-sort
 * once the stream settles. Guards the applyDexieDeltas → burst-coalescer wiring.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
import { useChatStore } from "../chat-store";
import type { LocalRoom, RoomChange } from "@/shared/lib/local-db";

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

vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: vi.fn(() => ({
    getRoom: vi.fn(() => undefined),
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

function makeLocalRoom(id: string, ts: number, overrides: Partial<LocalRoom> = {}): LocalRoom {
  return {
    id,
    name: `Room ${id}`,
    isGroup: false,
    members: ["me", "peer"],
    membership: "join",
    unreadCount: 0,
    lastReadInboundTs: 0,
    lastReadOutboundTs: 0,
    updatedAt: ts,
    syncedAt: ts,
    hasMoreHistory: true,
    isDeleted: false,
    deletedAt: null,
    deleteReason: null,
    lastMessageTimestamp: ts,
    lastMessagePreview: `preview ${ts}`,
    ...overrides,
  } as LocalRoom;
}

function makeKit(capture: { cb?: (changes: RoomChange[]) => void }) {
  return {
    rooms: {
      getAllRooms: vi.fn(async () => [
        makeLocalRoom("!a:s", 100),
        makeLocalRoom("!b:s", 200),
      ]),
      observeRoomChanges: vi.fn((cb: (changes: RoomChange[]) => void) => {
        capture.cb = cb;
        return () => {};
      }),
      bulkSyncRooms: vi.fn(async () => {}),
      getRoom: vi.fn(async () => undefined),
      updateOutboundWatermark: vi.fn(async () => {}),
    },
    messages: {
      getMessages: vi.fn(async () => []),
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
      writeEdit: vi.fn(async () => {}),
    },
    db: { rooms: { update: vi.fn(async () => 1) } },
    retryRoomDecryption: vi.fn(),
  };
}

async function waitFor(fn: () => boolean, timeout = 2000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("chat-store — sidebar coalesces backlog deltas into one re-sort", () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
  });

  it("defers the re-sort until the delta stream settles, then applies it once", async () => {
    const capture: { cb?: (changes: RoomChange[]) => void } = {};
    const kit = makeKit(capture);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setChatDbKit(kit as any);

    await waitFor(() => store.sortedRooms.length === 2 && !!capture.cb);
    // Initial order: newest lastMessageTimestamp first → B(200), A(100)
    expect(store.sortedRooms.map((r) => r.id)).toEqual(["!b:s", "!a:s"]);

    // Simulate a backlog trickle that would reorder the list: A jumps to newest.
    capture.cb!([{ type: "upsert", room: makeLocalRoom("!a:s", 500) }]);
    capture.cb!([{ type: "upsert", room: makeLocalRoom("!b:s", 400) }]);

    // Synchronously (well within the settle window) the visible order is
    // unchanged — the re-sort is deferred, not applied per delta.
    expect(store.sortedRooms.map((r) => r.id)).toEqual(["!b:s", "!a:s"]);

    // After the stream settles, the coalesced burst applies as a single re-sort.
    await waitFor(() => store.sortedRooms[0]?.id === "!a:s");
    expect(store.sortedRooms.map((r) => r.id)).toEqual(["!a:s", "!b:s"]);
  });

  it("applies a fresh re-sort for a later, separate burst", async () => {
    const capture: { cb?: (changes: RoomChange[]) => void } = {};
    const kit = makeKit(capture);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setChatDbKit(kit as any);

    await waitFor(() => store.sortedRooms.length === 2 && !!capture.cb);

    capture.cb!([{ type: "upsert", room: makeLocalRoom("!a:s", 500) }]);
    await waitFor(() => store.sortedRooms[0]?.id === "!a:s");

    // A later delta (new burst) still gets applied after it settles.
    capture.cb!([{ type: "upsert", room: makeLocalRoom("!b:s", 900) }]);
    await waitFor(() => store.sortedRooms[0]?.id === "!b:s");
    expect(store.sortedRooms.map((r) => r.id)).toEqual(["!b:s", "!a:s"]);

    await sleep(0);
  });
});
