/**
 * Regression: enterDetachedMode() ("jump to message" for a target outside
 * the loaded tail window — search results, quoted replies, pinned messages)
 * wrote its context snapshot only into the legacy `messages` ref. In
 * production, `activeMessages` always reads from the Dexie liveQuery
 * (`dexieMessages`, "latest N messages", no anchor) once a ChatDbKit is
 * wired — so the detached snapshot was invisible: the message list kept
 * showing the same live tail, the jump landed on nothing / the wrong
 * position, and use-scroll-to-message.ts's fallback either scrolled to a
 * garbage index or exhausted its retries with a "could not jump" toast.
 *
 * Fix: activeMessages now branches on `isDetachedFromLatest` — while
 * detached it reads `messages.value[roomId]` (where enterDetachedMode
 * writes), and exitDetachedMode() (which flips the flag back and reloads
 * dexieMessages via loadRoomMessages) resumes the normal live-tail path.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
import { useChatStore } from "./chat-store";
import { MessageType } from "./types";
import { makeRoom } from "@/test-utils";
import type { LocalMessage, LocalRoom } from "@/shared/lib/local-db";

// Same liveQuery stub as chat-store-room-switch.test.ts — the real Dexie
// liveQuery doesn't emit in happy-dom without IndexedDB observability hooks.
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

function makeKit(opts: { getMessages?: (roomId: string) => Promise<LocalMessage[]> } = {}) {
  return {
    rooms: {
      getAllRooms: vi.fn(async () => [makeLocalRoom("!a:s")]),
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
      writeMessages: vi.fn(() => Promise.resolve()),
      writeEdit: vi.fn(async () => {}),
    },
    db: {
      rooms: { update: vi.fn(async () => 1) },
    },
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

describe("chat-store — enterDetachedMode is actually reflected by activeMessages", () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
    store.rooms = [makeRoom({ id: "!a:s" })];
  });

  it("shows the detached context snapshot instead of the live Dexie tail while detached", async () => {
    const kit = makeKit({
      getMessages: () => Promise.resolve([makeLocalMsg("!a:s", "$live1", { timestamp: 9000 })]),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setChatDbKit(kit as any);

    await store.setActiveRoom("!a:s");
    await waitFor(() => store.activeMessages.length > 0);
    expect(store.activeMessages[0]?.id).toBe("$live1");

    // Jump to an old message not in the live tail — enterDetachedMode's job.
    store.enterDetachedMode("!a:s", [
      { id: "$old1", roomId: "!a:s", senderId: "peer", content: "old", timestamp: 100 } as never,
      { id: "$target", roomId: "!a:s", senderId: "peer", content: "target", timestamp: 200 } as never,
    ]);

    expect(store.isDetachedFromLatest).toBe(true);
    expect(store.activeMessages.map((m) => m.id)).toEqual(["$old1", "$target"]);
  });

  it("resumes the live Dexie tail after exitDetachedMode", async () => {
    const kit = makeKit({
      getMessages: () => Promise.resolve([makeLocalMsg("!a:s", "$live1", { timestamp: 9000 })]),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setChatDbKit(kit as any);

    await store.setActiveRoom("!a:s");
    await waitFor(() => store.activeMessages.length > 0);

    store.enterDetachedMode("!a:s", [
      { id: "$old1", roomId: "!a:s", senderId: "peer", content: "old", timestamp: 100 } as never,
    ]);
    expect(store.activeMessages.map((m) => m.id)).toEqual(["$old1"]);

    await store.exitDetachedMode("!a:s");

    expect(store.isDetachedFromLatest).toBe(false);
    await waitFor(() => store.activeMessages.some((m) => m.id === "$live1"));
    expect(store.activeMessages.map((m) => m.id)).toEqual(["$live1"]);
  });
});
