/**
 * Regression (audit A1): activeMessages reused the previous Message object
 * whenever a hand-picked field list matched. `content` and
 * `decryptionStatus` were not on the list, so when DecryptionWorker wrote
 * the plaintext into Dexie the liveQuery re-emitted, the computed re-ran —
 * and still returned the stale "[encrypted]" object. Same for a second
 * edit: `edited` was already true on both sides, so the new text never
 * rendered. The memo now compares the fully mapped Message.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
import { useChatStore } from "./chat-store";
import { MessageType } from "./types";
import { makeRoom } from "@/test-utils";
import type { LocalMessage, LocalRoom } from "@/shared/lib/local-db";

// Controllable liveQuery stub: every active subscription registers a
// re-run hook so the test can simulate "Dexie row changed → re-emit".
const { liveReruns } = vi.hoisted(() => ({ liveReruns: new Set<() => void>() }));

vi.mock("dexie", async (importOriginal) => {
  const actual = await importOriginal<typeof import("dexie")>();
  return {
    ...actual,
    liveQuery: (querier: () => unknown) => ({
      subscribe(sub: { next: (v: unknown) => void; error: (e: unknown) => void }) {
        let active = true;
        const run = () => {
          Promise.resolve()
            .then(() => querier())
            .then(
              (v) => { if (active) sub.next(v); },
              (e) => { if (active) sub.error(e); },
            );
        };
        run();
        liveReruns.add(run);
        return { unsubscribe() { active = false; liveReruns.delete(run); } };
      },
    }),
  };
});

vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: vi.fn(() => ({
    getRoom: vi.fn(() => ({
      roomId: "!a:s",
      getLiveTimeline: () => ({ getEvents: () => [] }),
      currentState: { getStateEvents: () => [] },
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

function makeLocalMsg(eventId: string, overrides: Partial<LocalMessage> = {}): LocalMessage {
  return {
    eventId,
    clientId: `c_${eventId}`,
    roomId: "!a:s",
    senderId: "peer",
    content: `content ${eventId}`,
    timestamp: 1000,
    type: MessageType.text,
    status: "synced",
    version: 1,
    softDeleted: false,
    // EventWriter copies `deleted` from the parsed Message (boolean). Leaving
    // it undefined would make the old memo's `prev.deleted === local.deleted`
    // (false vs undefined) never match and hide the bug.
    deleted: false,
    ...overrides,
  };
}

function makeLocalRoom(id: string): LocalRoom {
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
  } as LocalRoom;
}

/** Backing "table": getMessages returns fresh clones, like Dexie does. */
let rows: LocalMessage[] = [];

function makeKit() {
  return {
    rooms: {
      getAllRooms: vi.fn(async () => [makeLocalRoom("!a:s")]),
      observeRoomChanges: vi.fn(() => () => {}),
      bulkSyncRooms: vi.fn(async () => {}),
      getRoom: vi.fn(async () => undefined),
      updateOutboundWatermark: vi.fn(async () => {}),
    },
    messages: {
      getMessages: vi.fn(() => Promise.resolve(rows.map((r) => structuredClone(r)))),
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

function reemit() {
  for (const run of liveReruns) run();
}

describe("chat-store — activeMessages memo invalidates on content changes (A1)", () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    liveReruns.clear();
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
    store.rooms = [makeRoom({ id: "!a:s" })];
  });

  async function openRoomWith(initial: LocalMessage[]) {
    rows = initial;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setChatDbKit(makeKit() as any);
    await store.setActiveRoom("!a:s");
    await waitFor(() => store.activeMessages.length === initial.length);
  }

  it("renders the plaintext after a successful decrypt updates only content + decryptionStatus", async () => {
    await openRoomWith([makeLocalMsg("$e1", { content: "[encrypted]", decryptionStatus: "pending" })]);
    expect(store.activeMessages[0].content).toBe("[encrypted]");
    expect(store.activeMessages[0].decryptionStatus).toBe("pending");

    // What DecryptionWorker.commitSuccess writes.
    rows = [{ ...rows[0], content: "hello", decryptionStatus: "ok", encryptedBody: undefined }];
    reemit();

    await waitFor(() => store.activeMessages[0]?.content === "hello");
    expect(store.activeMessages[0].decryptionStatus).toBeUndefined();
  });

  it("renders a second edit of an already-edited message", async () => {
    await openRoomWith([makeLocalMsg("$e1", { content: "v1", edited: true })]);
    expect(store.activeMessages[0].content).toBe("v1");

    rows = [{ ...rows[0], content: "v2" }];
    reemit();

    await waitFor(() => store.activeMessages[0]?.content === "v2");
  });

  it("still reuses the Message object for rows that did not change", async () => {
    await openRoomWith([
      makeLocalMsg("$e1", { timestamp: 1000 }),
      makeLocalMsg("$e2", { timestamp: 2000, content: "[encrypted]", decryptionStatus: "pending" }),
    ]);
    const before = store.activeMessages;
    const untouched = before.find((m) => m.id === "$e1");

    rows = [rows[0], { ...rows[1], content: "decrypted", decryptionStatus: "ok" }];
    reemit();

    await waitFor(() => store.activeMessages.find((m) => m.id === "$e2")?.content === "decrypted");
    expect(store.activeMessages.find((m) => m.id === "$e1")).toBe(untouched);
  });
});
