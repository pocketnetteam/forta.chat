/**
 * Background history work must not get in the way of opening a chat:
 * - list previews need no history load when Dexie already has the preview,
 *   and no SDK scrollback when the SDK's in-memory timeline has messages;
 * - list previews and backfill of other rooms wait while a room is opened.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
import { useChatStore } from "./chat-store";
import { makeRoom } from "@/test-utils";
import type { LocalRoom } from "@/shared/lib/local-db";

vi.mock("dexie", async (importOriginal) => {
  const actual = await importOriginal<typeof import("dexie")>();
  return {
    ...actual,
    liveQuery: (querier: () => unknown) => ({
      subscribe(sub: { next: (v: unknown) => void; error: (e: unknown) => void }) {
        let active = true;
        Promise.resolve().then(() => querier()).then(
          (v) => { if (active) sub.next(v); },
          (e) => { if (active) sub.error(e); },
        );
        return { unsubscribe() { active = false; } };
      },
    }),
  };
});

type Raw = Record<string, unknown>;
let timelines: Record<string, Raw[]>;
const scrollback = vi.fn(async () => {});
const text = (id: string, ts: number): Raw => ({
  type: "m.room.message", content: { msgtype: "m.text", body: `body ${id}` }, event_id: id, sender: "@peer:s", origin_server_ts: ts,
});

vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: vi.fn(() => ({
    getRoom: vi.fn((roomId: string) => ({
      roomId,
      getLiveTimeline: () => ({ getEvents: () => (timelines[roomId] ?? []).map((e) => ({ event: e })) }),
      currentState: { getStateEvents: () => null },
      oldState: { paginationToken: "tok" },
    })),
    isReady: vi.fn(() => true),
    getUserId: vi.fn(() => "@me:s"),
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
      getMessages: vi.fn(async () => []),
      getByEventIds: vi.fn(async () => []),
      patchUnresolvedReplies: vi.fn(async () => {}),
      bulkUpdateReactions: vi.fn(async () => 0),
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

const flush = () => new Promise((r) => setTimeout(r, 0));
async function waitFor(fn: () => boolean, timeout = 2_000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

let store: ReturnType<typeof useChatStore>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let kit: any;

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  setActivePinia(createTestingPinia({ stubActions: false }));
  store = useChatStore();
  store.rooms = [makeRoom({ id: "!list:s" }), makeRoom({ id: "!open:s" })];
  timelines = {};
  scrollback.mockClear();
  kit = makeKit();
  store.setChatDbKit(kit);
});

describe("list previews", () => {
  it("need no history load when Dexie already has the preview", async () => {
    store.dexieRoomMap.set("!list:s", { id: "!list:s", lastMessagePreview: "hi" } as LocalRoom);
    timelines["!list:s"] = [text("$a", 1)];

    store.ensureRoomsLoaded(["!list:s"], "high");
    await waitFor(() => store.roomFetchStates.get("!list:s")?.status === "success");

    expect(kit.messages.getByEventIds).not.toHaveBeenCalled();
    expect(scrollback).not.toHaveBeenCalled();
  });

  it("use the SDK's in-memory events before any scrollback", async () => {
    timelines["!list:s"] = [text("$a", 1)];

    store.ensureRoomsLoaded(["!list:s"], "high");
    await waitFor(() => store.roomFetchStates.get("!list:s")?.status === "success");

    expect(kit.eventWriter.writeMessages).toHaveBeenCalled();
    expect(scrollback).not.toHaveBeenCalled();
  });

  it("scroll back only for a room the SDK has no messages of", async () => {
    store.ensureRoomsLoaded(["!list:s"], "high");
    await waitFor(() => store.roomFetchStates.get("!list:s")?.status === "success");
    expect(scrollback).toHaveBeenCalled();
  });
});

describe("quiet window while a room opens", () => {
  it("list previews wait until the opened room is revealed", async () => {
    timelines["!list:s"] = [text("$a", 1)];
    store.setActiveRoom("!open:s");

    store.ensureRoomsLoaded(["!list:s"], "high");
    await flush();
    await flush();
    expect(kit.messages.getByEventIds).not.toHaveBeenCalled();

    store.endRoomOpenQuiet();
    await waitFor(() => store.roomFetchStates.get("!list:s")?.status === "success");
  });

  it("the window ends by itself if the reveal never reports", async () => {
    vi.useFakeTimers();
    try {
      timelines["!list:s"] = [text("$a", 1)];
      store.setActiveRoom("!open:s");
      store.ensureRoomsLoaded(["!list:s"], "high");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(kit.messages.getByEventIds).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(600);
      expect(kit.messages.getByEventIds).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("quiet window edge cases", () => {
  it("a waiter released by the timer does not find the window still open", async () => {
    vi.useFakeTimers();
    const realNow = Date.now;
    try {
      timelines["!list:s"] = [text("$a", 1)];
      store.setActiveRoom("!open:s");
      store.ensureRoomsLoaded(["!list:s"], "high");
      // The timer fires 1ms before the clock reaches the deadline.
      const start = realNow.call(Date);
      vi.spyOn(Date, "now").mockImplementation(() => start + 1_499);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(kit.messages.getByEventIds).toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("logout drops the paused work instead of running it", async () => {
    timelines["!list:s"] = [text("$a", 1)];
    store.setActiveRoom("!open:s");
    store.ensureRoomsLoaded(["!list:s"], "high");

    store.cleanup();
    await flush();
    await flush();

    expect(kit.messages.getByEventIds).not.toHaveBeenCalled();
  });
});

