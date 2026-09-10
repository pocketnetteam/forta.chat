/**
 * Regression tests for loadRoomMessages()'s "do we need scrollback" gate.
 *
 * Previously this gate counted timeline events by type ("m.room.message",
 * later also "m.room.encrypted") to decide whether enough history was
 * already loaded. That classification had to track every message-carrying
 * event type the app ever introduces (plain text, the content-level
 * "m.encrypted" wrapper, polls, calls, ...) and silently drifted out of sync
 * more than once, which made the gate re-run scrollback on every single room
 * open even when the timeline already had plenty of history.
 *
 * The gate now trusts two much simpler signals instead: the raw timeline
 * length (not filtered by type — just "is there clearly enough to fill a
 * chat view") and the SDK's own `room.oldState.paginationToken` (null means
 * the server has already told us this is the start of the room — no event
 * classification needed, the SDK already knows this for certain).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
import { useChatStore } from "./chat-store";
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

const makeTimelineEvent = (i: number, type = "m.room.encrypted") => ({
  event: {
    type,
    content: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: `cipher${i}` },
    event_id: `$e${i}`,
    sender: "@peer:s",
    origin_server_ts: 1000 + i,
  },
});

const scrollback = vi.fn(() => Promise.resolve());

vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: vi.fn(() => ({
    getRoom: vi.fn(() => currentMockRoom),
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
      writeMessages: vi.fn(() => Promise.resolve()),
      writeEdit: vi.fn(async () => {}),
    },
    db: { rooms: { update: vi.fn(async () => 1) } },
    retryRoomDecryption: vi.fn(),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let currentMockRoom: any;

function makeMockRoom(events: unknown[], paginationToken: string | null) {
  return {
    roomId: "!a:s",
    getLiveTimeline: () => ({ getEvents: () => events }),
    currentState: { getStateEvents: () => [] },
    oldState: { paginationToken },
  };
}

describe("loadRoomMessages — history-loading gate", () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
    store.rooms = [makeRoom({ id: "!a:s" })];
    store.activeRoomId = "!a:s";
    scrollback.mockClear();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setChatDbKit(makeKit() as any);
  });

  it("skips scrollback when the timeline already has enough events, regardless of their type", async () => {
    // 25 raw events, all "m.room.encrypted" — well above the 20-event floor.
    // The old type-counting gate saw this as zero real messages and always
    // re-fetched; the raw-length check recognizes it correctly.
    const events = Array.from({ length: 25 }, (_, i) => makeTimelineEvent(i));
    currentMockRoom = makeMockRoom(events, "some-token");

    await store.loadRoomMessages("!a:s");

    expect(scrollback).not.toHaveBeenCalled();
  });

  it("skips scrollback when the SDK confirms we're already at the start of the room, even with few events", async () => {
    // Only 3 events, but the server already told the SDK there's no more
    // history (paginationToken === null) — that's authoritative and must
    // short-circuit the loop without ever calling scrollback.
    const events = Array.from({ length: 3 }, (_, i) => makeTimelineEvent(i));
    currentMockRoom = makeMockRoom(events, null);

    await store.loadRoomMessages("!a:s");

    expect(scrollback).not.toHaveBeenCalled();
  });

  it("still fetches more history when the timeline is thin and the SDK says more exists", async () => {
    // Few events AND the server hasn't said we're at the start — this is the
    // one case that legitimately needs scrollback.
    const events = Array.from({ length: 3 }, (_, i) => makeTimelineEvent(i));
    currentMockRoom = makeMockRoom(events, "more-to-fetch");
    // scrollback doesn't grow the mock's fixed timeline, so the loop's
    // "no new events" break condition ends it after the first real attempt.

    await store.loadRoomMessages("!a:s");

    expect(scrollback).toHaveBeenCalledTimes(1);
    expect(scrollback).toHaveBeenCalledWith("!a:s", 50);
  });
});
