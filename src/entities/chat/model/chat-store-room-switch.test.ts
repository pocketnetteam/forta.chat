/**
 * WEE-95 regression tests — chat opens slowly:
 *  A1: loadRoomMessages must NOT await the Dexie write in the render-critical path
 *  A2: switching rooms must synchronously drop the previous room's liveQuery
 *      snapshot — room A's messages never flash inside room B
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
import { useChatStore } from "./chat-store";
import { MessageType } from "./types";
import { makeRoom } from "@/test-utils";
import type { LocalMessage, LocalRoom } from "@/shared/lib/local-db";

// ── Mock Dexie's liveQuery ────────────────────────────────────────
// The real liveQuery doesn't emit in the happy-dom test env (no IndexedDB
// observability hooks) — execute the querier once per subscription instead.
// Same approach as use-live-query.test.ts.
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

// ── Mock matrix client service ────────────────────────────────────
const makeTimelineEvent = (i: number) => ({
  event: {
    type: "m.room.message",
    content: { msgtype: "m.text", body: `msg ${i}` },
    event_id: `$e${i}`,
    sender: "@peer:s",
    origin_server_ts: 1000 + i,
  },
});

const mockMatrixRoom = {
  roomId: "!a:s",
  getLiveTimeline: () => ({
    getEvents: () => Array.from({ length: 25 }, (_, i) => makeTimelineEvent(i)),
  }),
  currentState: { getStateEvents: () => [] },
};

vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: vi.fn(() => ({
    getRoom: vi.fn(() => mockMatrixRoom),
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

function makeLocalMsg(roomId: string, eventId: string, overrides: Partial<LocalMessage> = {}): LocalMessage {
  return {
    eventId,
    clientId: `c_${eventId}`,
    roomId,
    senderId: "peer",
    content: `content ${eventId}`,
    timestamp: 1000,
    type: MessageType.text,
    status: "synced",
    version: 1,
    softDeleted: false,
    ...overrides,
  };
}

function makeLocalRoom(id: string, overrides: Partial<LocalRoom> = {}): LocalRoom {
  return {
    id,
    name: "Room",
    isGroup: false,
    members: ["me", "peer"],
    membership: "join",
    unreadCount: 0,
    lastReadInboundTs: 0,
    lastReadOutboundTs: 0,
    updatedAt: Date.now(),
    syncedAt: Date.now(),
    hasMoreHistory: true,
    isDeleted: false,
    deletedAt: null,
    deleteReason: null,
    ...overrides,
  } as LocalRoom;
}

/** Minimal ChatDbKit mock — enough for setChatDbKit + liveQuery + loadRoomMessages */
function makeKit(opts: {
  getMessages?: (roomId: string) => Promise<LocalMessage[]>;
  writeMessages?: () => Promise<void>;
} = {}) {
  return {
    rooms: {
      getAllRooms: vi.fn(async () => [makeLocalRoom("!a:s"), makeLocalRoom("!b:s")]),
      observeRoomChanges: vi.fn(() => () => {}),
      bulkSyncRooms: vi.fn(async () => {}),
      getRoom: vi.fn(async () => undefined),
      updateOutboundWatermark: vi.fn(async () => {}),
    },
    messages: {
      getMessages: vi.fn((roomId: string) =>
        opts.getMessages ? opts.getMessages(roomId) : Promise.resolve([] as LocalMessage[])),
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
      writeMessages: vi.fn((_msgs: unknown[]) => (opts.writeMessages ? opts.writeMessages() : Promise.resolve())),
      writeEdit: vi.fn(async () => {}),
    },
    retryRoomDecryption: vi.fn(),
  };
}

/** Wait for a condition (polls every 10ms, max 2s) */
async function waitFor(fn: () => boolean, timeout = 2000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("waitFor timed out");
    await new Promise(r => setTimeout(r, 10));
  }
}

describe("WEE-95 A2 — room switch drops stale liveQuery snapshot synchronously", () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
    store.rooms = [makeRoom({ id: "!a:s" }), makeRoom({ id: "!b:s" })];
  });

  it("messages of room A never appear in activeMessages after switching to room B", async () => {
    let resolveB: ((msgs: LocalMessage[]) => void) | undefined;
    const kit = makeKit({
      getMessages: (roomId) => {
        if (roomId === "!a:s") return Promise.resolve([makeLocalMsg("!a:s", "$a1")]);
        // Room B's Dexie query is slow — the race window from the ticket
        return new Promise<LocalMessage[]>((res) => { resolveB = res; });
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setChatDbKit(kit as any);

    await store.setActiveRoom("!a:s");
    await waitFor(() => store.activeMessages.length > 0);
    expect(store.activeMessages[0]?.roomId).toBe("!a:s");

    await store.setActiveRoom("!b:s");

    // Synchronous reset: stale A-messages must be gone IMMEDIATELY,
    // before room B's query resolves (the old code showed A's messages here).
    expect(store.activeMessages.length).toBe(0);

    // Let the new subscription start, then resolve room B's query
    await waitFor(() => resolveB !== undefined);
    resolveB!([makeLocalMsg("!b:s", "$b1")]);
    await waitFor(() => store.activeMessages.length > 0);
    expect(store.activeMessages[0]?.roomId).toBe("!b:s");
  });

  it("re-setting the SAME room does not clear messages (no skeleton flash)", async () => {
    const kit = makeKit({
      getMessages: (roomId) =>
        roomId === "!a:s" ? Promise.resolve([makeLocalMsg("!a:s", "$a1")]) : Promise.resolve([]),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setChatDbKit(kit as any);

    await store.setActiveRoom("!a:s");
    await waitFor(() => store.activeMessages.length > 0);

    await store.setActiveRoom("!a:s");
    // No reset — stale-data-better-than-skeleton holds for the same room
    expect(store.activeMessages.length).toBe(1);
  });
});

describe("WEE-95 A1 — loadRoomMessages does not await the Dexie write", () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
    store.rooms = [makeRoom({ id: "!a:s" })];
  });

  it("resolves for the ACTIVE room even when the Dexie write never settles", async () => {
    // Dexie transaction hangs (slow device / competing background writes)
    const kit = makeKit({ writeMessages: () => new Promise<void>(() => {}) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setChatDbKit(kit as any);
    store.activeRoomId = "!a:s";

    const outcome = await Promise.race([
      store.loadRoomMessages("!a:s").then(() => "resolved" as const),
      new Promise<"timeout">(r => setTimeout(() => r("timeout"), 1500)),
    ]);

    // Render-critical path must not be blocked by the write (A1)
    expect(outcome).toBe("resolved");
    // ...but the write itself was still dispatched (data persists in background)
    expect(kit.eventWriter.writeMessages).toHaveBeenCalled();
    const written = kit.eventWriter.writeMessages.mock.calls[0][0] as unknown[];
    expect(written.length).toBeGreaterThan(0);
  });

  it("in-memory messages are available after loadRoomMessages despite a hung write", async () => {
    const kit = makeKit({ writeMessages: () => new Promise<void>(() => {}) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setChatDbKit(kit as any);
    store.activeRoomId = "!a:s";

    await store.loadRoomMessages("!a:s");

    // setMessages() seeded the in-memory store from the Matrix timeline
    expect((store.messages["!a:s"] ?? []).length).toBeGreaterThan(0);
  });
});
