// @vitest-environment happy-dom
/**
 * Regression: the chat list kept a last-message preview that Dexie had already changed.
 * A hangup record can be rewritten in place — same event, same timestamp, same
 * "[message]" placeholder — once the invite comes into view and the call reads
 * as missed (`entities/chat/lib/call-outcome.ts`). The sidebar only re-mapped a
 * room when a field outside the call info changed, and its per-room cache was
 * keyed on those same fields, so the list showed the old reading until restart.
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

const ROOM = "!call:s";

function callRoom(missed: boolean): LocalRoom {
  return {
    id: ROOM,
    name: "Peer",
    isGroup: false,
    members: ["me", "peer"],
    membership: "join",
    unreadCount: 0,
    lastReadInboundTs: 0,
    lastReadOutboundTs: 0,
    updatedAt: 1000,
    syncedAt: 1000,
    hasMoreHistory: true,
    isDeleted: false,
    deletedAt: null,
    deleteReason: null,
    lastMessageTimestamp: 1000,
    lastMessagePreview: "[message]",
    lastMessageEventId: "$hangup",
    lastMessageSenderId: "peer",
    lastMessageCallInfo: { callType: "voice", missed },
    lastMessageSystemMeta: { template: missed ? "system.missedVoiceCall" : "system.voiceCall", senderAddr: "peer" },
  } as LocalRoom;
}

function makeKit(capture: { cb?: (changes: RoomChange[]) => void }) {
  return {
    rooms: {
      getAllRooms: vi.fn(async () => [callRoom(false)]),
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
      hasBufferedWritesFor: vi.fn(() => false),
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

describe("chat-store — the chat list follows a last-message preview rewritten in place", () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
  });

  it("shows the call as missed once Dexie marks the same hangup missed", async () => {
    const capture: { cb?: (changes: RoomChange[]) => void } = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setChatDbKit(makeKit(capture) as any);
    await waitFor(() => store.sortedRooms.length === 1 && !!capture.cb);
    expect(store.sortedRooms[0].lastMessage?.callInfo?.missed).toBe(false);

    capture.cb!([{ type: "upsert", room: callRoom(true) }]);

    await waitFor(() => store.sortedRooms[0].lastMessage?.callInfo?.missed === true);
    expect(store.sortedRooms[0].lastMessage?.systemMeta?.template).toBe("system.missedVoiceCall");
  });

  it("follows a system template change on the same event", async () => {
    const capture: { cb?: (changes: RoomChange[]) => void } = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setChatDbKit(makeKit(capture) as any);
    await waitFor(() => store.sortedRooms.length === 1 && !!capture.cb);

    const renamed = callRoom(false);
    renamed.lastMessageSystemMeta = { template: "system.videoCall", senderAddr: "peer" };
    capture.cb!([{ type: "upsert", room: renamed }]);

    await waitFor(() => store.sortedRooms[0].lastMessage?.systemMeta?.template === "system.videoCall");
  });

  // A reaction on the last message changes only lastMessageReaction: same event,
  // timestamp and preview text. Seen on the Samsung: Dexie had the 👍, the list did not.
  it("shows a reaction added to the last message", async () => {
    const capture: { cb?: (changes: RoomChange[]) => void } = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setChatDbKit(makeKit(capture) as any);
    await waitFor(() => store.sortedRooms.length === 1 && !!capture.cb);
    expect(store.sortedRooms[0].lastMessageReaction).toBeUndefined();

    const reacted = callRoom(false);
    reacted.lastMessageReaction = { emoji: "👍", senderAddress: "peer", timestamp: 2000 };
    capture.cb!([{ type: "upsert", room: reacted }]);
    await waitFor(() => store.sortedRooms[0].lastMessageReaction?.emoji === "👍");

    const changed = callRoom(false);
    changed.lastMessageReaction = { emoji: "❤️", senderAddress: "peer", timestamp: 3000 };
    capture.cb!([{ type: "upsert", room: changed }]);
    await waitFor(() => store.sortedRooms[0].lastMessageReaction?.emoji === "❤️");
  });
});
