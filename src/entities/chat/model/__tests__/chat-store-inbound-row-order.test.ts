// @vitest-environment happy-dom
/**
 * Regression: for a moment the chat list row showed a new message's unread count next to the
 * previous message's preview and reaction (Samsung, `order2`: ~400 ms). addMessage bumped the
 * count straight into the sidebar, while the preview reaches it through a Dexie write and the
 * 220 ms sidebar coalescer. The push that trails the same message counted it a second time
 * (`order1`: 0 → 2 → 1).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { watch } from "vue";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
import { useChatStore } from "../chat-store";
import { makeRoom, makeMsg } from "@/test-utils";
import { MessageStatus } from "../types";
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

const ROOM = "!peer:s";

function localRoom(overrides: Partial<LocalRoom> = {}): LocalRoom {
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
    lastMessagePreview: "old text",
    lastMessageEventId: "$old",
    lastMessageSenderId: "peer",
    lastMessageReaction: { emoji: "👍", senderAddress: "peer", timestamp: 1100 },
    ...overrides,
  } as LocalRoom;
}

function makeKit(capture: { cb?: (changes: RoomChange[]) => void }) {
  return {
    rooms: {
      getAllRooms: vi.fn(async () => [localRoom()]),
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

async function waitFor(fn: () => boolean, timeout = 3000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const incoming = () =>
  makeMsg({ id: "$new", roomId: ROOM, senderId: "peer", content: "new text", timestamp: 2000, status: MessageStatus.sent });

describe("chat-store — a new message's unread count and preview reach the chat list together", () => {
  let store: ReturnType<typeof useChatStore>;
  let capture: { cb?: (changes: RoomChange[]) => void };
  let states: string[];

  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
    capture = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setChatDbKit(makeKit(capture) as any);
    store.rooms = [makeRoom({ id: ROOM, unreadCount: 0 })];
    await waitFor(() => store.sortedRooms.some((r) => r.id === ROOM) && !!capture.cb);
    states = [];
    watch(
      () => store.sortedRooms.find((r) => r.id === ROOM),
      (r) => states.push(`${r?.unreadCount}|${r?.lastMessage?.id}|${r?.lastMessageReaction?.emoji ?? "-"}`),
      { flush: "sync" },
    );
  });

  it("never shows the new count with the previous message's preview", async () => {
    store.addMessage(ROOM, incoming());
    // The Dexie preview write lands a little later (EventWriter batch).
    await new Promise((r) => setTimeout(r, 60));
    capture.cb!([{
      type: "upsert",
      room: localRoom({ unreadCount: 1, lastMessagePreview: "new text", lastMessageEventId: "$new", lastMessageTimestamp: 2000, lastMessageReaction: null }),
    }]);
    await waitFor(() => store.sortedRooms.find((r) => r.id === ROOM)?.unreadCount === 1);
    expect(store.sortedRooms.find((r) => r.id === ROOM)?.lastMessage?.id).toBe("$new");
    expect(states).not.toContain("1|$old|👍");
    expect(states.at(-1)).toBe("1|$new|-");
  });

  it("still shows the count when no preview write follows", async () => {
    store.addMessage(ROOM, incoming());
    await waitFor(() => store.sortedRooms.find((r) => r.id === ROOM)?.unreadCount === 1);
  });

  it("does not count a message the push already counted", async () => {
    // The push wrote its placeholder for $new (with its +1) before /sync delivered the event.
    capture.cb!([{
      type: "upsert",
      room: localRoom({ unreadCount: 1, lastMessagePreview: "New message", lastMessageEventId: "$new", lastMessageTimestamp: 2100, lastMessageReaction: null }),
    }]);
    await waitFor(() => store.sortedRooms.find((r) => r.id === ROOM)?.unreadCount === 1);
    store.addMessage(ROOM, incoming());
    await new Promise((r) => setTimeout(r, 400));
    expect(store.sortedRooms.find((r) => r.id === ROOM)?.unreadCount).toBe(1);
  });

  it("a room read right after the message arrived does not get its count back", async () => {
    const unread = () => store.sortedRooms.find((r) => r.id === ROOM)?.unreadCount;
    // No reaction on the last message, so the bump's own Dexie write below is not a visible change.
    capture.cb!([{ type: "upsert", room: localRoom({ lastMessageReaction: null }) }]);
    await waitFor(() => !store.sortedRooms.find((r) => r.id === ROOM)?.lastMessageReaction);
    store.addMessage(ROOM, incoming());
    // The bump's Dexie write comes back and replaces the room object in dexieRoomMap...
    capture.cb!([{ type: "upsert", room: localRoom({ unreadCount: 1, lastMessageReaction: null }) }]);
    await new Promise((r) => setTimeout(r, 20));
    // ...and the chat is opened before the sidebar coalescer has settled.
    store.markRoomAsRead(ROOM);
    await waitFor(() => unread() === 0);
    await new Promise((r) => setTimeout(r, 600));
    expect(unread()).toBe(0);
  });

  it("hasMessage reports a message /sync has already delivered", () => {
    expect(store.hasMessage(ROOM, "$new")).toBe(false);
    store.addMessage(ROOM, incoming());
    expect(store.hasMessage(ROOM, "$new")).toBe(true);
    expect(store.hasMessage("!other:s", "$new")).toBe(false);
  });
});
