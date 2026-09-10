/**
 * Regression (audit A2): loadRoomMessages / loadMoreMessages /
 * prefetchNextBatch built their EventWriter input without `encryptedRaw`.
 * An event that could not be decrypted at parse time (keys missing, crypto
 * not ready) was then persisted as "[encrypted]" with no ciphertext and
 * status "ok" — permanently unrecoverable. Only the live-sync path
 * (dexieWriteMessage) kept the raw event.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
import { useChatStore } from "./chat-store";
import { makeRoom } from "@/test-utils";
import type { ParsedMessage } from "@/shared/lib/local-db";

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

/** App-level (Pcrypto) encrypted message: content.msgtype "m.encrypted". */
const makeEncryptedEvent = (i: number) => ({
  event: {
    type: "m.room.message",
    content: { msgtype: "m.encrypted", body: `cipher${i}` },
    event_id: `$e${i}`,
    sender: "@peer:s",
    origin_server_ts: 1000 + i,
  },
});

let timeline: unknown[] = [];
let roomPresent = true;
/** Events the next scrollback() prepends to the timeline. */
let olderBatch: unknown[] = [];
const scrollback = vi.fn(async () => {
  timeline = [...olderBatch, ...timeline];
  olderBatch = [];
});

vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: vi.fn(() => ({
    getRoom: vi.fn(() => (roomPresent
      ? {
          roomId: "!a:s",
          getLiveTimeline: () => ({ getEvents: () => timeline }),
          currentState: { getStateEvents: () => [] },
          oldState: { paginationToken: "more" },
        }
      : undefined)),
    isReady: vi.fn(() => true),
    getUserId: vi.fn(() => "@mock:s"),
    getRooms: vi.fn(() => []),
    getRoomAccountData: vi.fn(() => null),
    getIgnoredMatrixUserIds: vi.fn(() => [] as string[]),
    matrixId: vi.fn((id: string) => id),
    isMe: vi.fn(() => false),
    scrollback,
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

const writeMessages = vi.fn<(msgs: ParsedMessage[]) => Promise<void>>(() => Promise.resolve());

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
      writeMessages,
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

function expectCiphertextKept(written: ParsedMessage[]) {
  const placeholders = written.filter((p) => p.content === "[encrypted]");
  expect(placeholders.length).toBeGreaterThan(0);
  for (const p of placeholders) {
    expect(p.encryptedRaw?.event_id).toBe(p.eventId);
  }
}

describe("chat-store bulk write paths keep the ciphertext of undecrypted events (A2)", () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
    store.rooms = [makeRoom({ id: "!a:s" })];
    store.activeRoomId = "!a:s";
    writeMessages.mockClear();
    scrollback.mockClear();
    timeline = Array.from({ length: 25 }, (_, i) => makeEncryptedEvent(100 + i));
    olderBatch = [];
    roomPresent = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setChatDbKit(makeKit() as any);
  });

  it("loadRoomMessages", async () => {
    await store.loadRoomMessages("!a:s");
    await waitFor(() => writeMessages.mock.calls.length > 0);
    expectCiphertextKept(writeMessages.mock.calls[0][0]);
  });

  it("loadMoreMessages", async () => {
    olderBatch = Array.from({ length: 10 }, (_, i) => makeEncryptedEvent(i));
    expect(await store.loadMoreMessages("!a:s")).toBe(true);
    await waitFor(() => writeMessages.mock.calls.length > 0);
    expectCiphertextKept(writeMessages.mock.calls[0][0]);
  });

  // MessageList uses this to skip the 8s skeleton only for genuinely empty
  // rooms (audit C2) — a missing room or an error must NOT read as "empty".
  it("loadRoomMessages reports the parsed count, 0 for an empty room, undefined when the room is missing", async () => {
    expect(await store.loadRoomMessages("!a:s")).toBe(25);

    timeline = [];
    expect(await store.loadRoomMessages("!a:s")).toBe(0);

    roomPresent = false;
    expect(await store.loadRoomMessages("!a:s")).toBeUndefined();
  });

  it("prefetchNextBatch", async () => {
    olderBatch = Array.from({ length: 10 }, (_, i) => makeEncryptedEvent(i));
    expect(await store.prefetchNextBatch("!a:s")).toBe(true);
    expect(writeMessages).toHaveBeenCalledTimes(1);
    expectCiphertextKept(writeMessages.mock.calls[0][0]);
  });
});
