/**
 * Instant re-entry (plan docs/plans/2026-09-28-chat-open-local-first.md,
 * stage 4): re-entering a recent room shows its last liveQuery emission in
 * the first frame; the first real emission replaces it.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
import { useChatStore } from "./chat-store";
import { MessageType } from "./types";
import { makeRoom } from "@/test-utils";
import type { LocalMessage } from "@/shared/lib/local-db";

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
    getRoom: vi.fn(() => null),
    isReady: vi.fn(() => true),
    getUserId: vi.fn(() => "@mock:s"),
    getRooms: vi.fn(() => []),
    getRoomAccountData: vi.fn(() => null),
    getIgnoredMatrixUserIds: vi.fn(() => [] as string[]),
    matrixId: vi.fn((id: string) => id),
    isMe: vi.fn(() => false),
    setRoomAccountData: vi.fn(async () => {}),
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

const msg = (roomId: string, eventId: string, timestamp = 1_000): LocalMessage => ({
  eventId, clientId: `c_${eventId}`, roomId, senderId: "peer", content: `content ${eventId}`,
  timestamp, type: MessageType.text, status: "synced", version: 1, softDeleted: false,
});

let rowsByRoom: Record<string, LocalMessage[]>;
let clearedAt: Record<string, number | undefined>;
let slow: Record<string, boolean>;

function makeKit() {
  return {
    rooms: {
      getAllRooms: vi.fn(async () => []),
      observeRoomChanges: vi.fn(() => () => {}),
      bulkSyncRooms: vi.fn(async () => {}),
      getRoom: vi.fn(async () => undefined),
      updateOutboundWatermark: vi.fn(async () => {}),
      clearHistory: vi.fn(async () => {}),
    },
    messages: {
      // A "slow" room never answers: whatever activeMessages shows came from the snapshot.
      getMessages: vi.fn((roomId: string) =>
        slow[roomId] ? new Promise<LocalMessage[]>(() => {}) : Promise.resolve(rowsByRoom[roomId] ?? [])),
      getByEventIds: vi.fn(async () => []),
      purgeBeforeTimestamp: vi.fn(async () => {}),
    },
    eventWriter: {
      enableBatching: vi.fn(),
      getClearedAtTs: vi.fn((roomId: string) => clearedAt[roomId]),
      setClearedAtTs: vi.fn((roomId: string, ts: number) => { clearedAt[roomId] = ts; }),
      flushWriteBuffer: vi.fn(() => Promise.resolve()),
      hasBufferedWritesFor: vi.fn(() => false),
      clearUnread: vi.fn(async () => {}),
    },
    db: { rooms: { update: vi.fn(async () => 1) } },
    retryRoomDecryption: vi.fn(),
  };
}

async function waitFor(fn: () => boolean, timeout = 2_000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("chat-store — room snapshots (stage 4)", () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
    store.rooms = [makeRoom({ id: "!a:s" }), makeRoom({ id: "!b:s" })];
    rowsByRoom = { "!a:s": [msg("!a:s", "$a1"), msg("!a:s", "$a2", 2_000)] };
    clearedAt = {};
    slow = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setChatDbKit(makeKit() as any);
  });

  const visitA = async () => {
    store.setActiveRoom("!a:s");
    await waitFor(() => store.activeMessages.length === 2);
    store.setActiveRoom(null);
  };

  it("enter → leave → enter shows the room's messages synchronously", async () => {
    await visitA();
    slow["!a:s"] = true;

    store.setActiveRoom("!a:s");

    expect(store.activeMessages.map((m) => m.id)).toEqual(["$a1", "$a2"]);
    expect(store.activeMessagesRoomId).toBe("!a:s");
  });

  it("never shows another room's snapshot (WEE-95)", async () => {
    await visitA();
    slow["!b:s"] = true;

    store.setActiveRoom("!b:s");

    expect(store.activeMessages).toEqual([]);
  });

  it("drops the snapshot when the room's history is cleared", async () => {
    await visitA();
    await store.clearHistory("!a:s");
    slow["!a:s"] = true;

    store.setActiveRoom("!a:s");

    expect(store.activeMessages).toEqual([]);
  });

  it("hides snapshot rows older than a clear that arrived from another device", async () => {
    await visitA();
    clearedAt["!a:s"] = 1_500; // account-data bootstrap, no clearHistory() call here
    slow["!a:s"] = true;

    store.setActiveRoom("!a:s");

    expect(store.activeMessages.map((m) => m.id)).toEqual(["$a2"]);
  });

  it("clears every snapshot on logout", async () => {
    await visitA();
    store.cleanup();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setChatDbKit(makeKit() as any);
    slow["!a:s"] = true;

    store.setActiveRoom("!a:s");

    expect(store.activeMessages).toEqual([]);
  });

  it("the first real emission replaces the snapshot", async () => {
    await visitA();
    rowsByRoom["!a:s"] = [...rowsByRoom["!a:s"], msg("!a:s", "$a3", 3_000)];

    store.setActiveRoom("!a:s");
    expect(store.activeMessages).toHaveLength(2);
    expect(store.isShowingSnapshot).toBe(true); // waiters can tell it from a read

    await waitFor(() => store.activeMessages.length === 3);
    expect(store.isShowingSnapshot).toBe(false);
  });
});
