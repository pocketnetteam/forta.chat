/**
 * Regression (audit B3/B4): MessageList waited 300ms for
 * `activeMessages.length` to change after expandMessageWindow(), while the
 * window itself only reached the liveQuery after a 200ms debounce plus the
 * Dexie read. On slow devices that routinely missed, so every scroll-up
 * fell through to a full network scrollback. expandMessageWindow() now
 * applies the window immediately and resolves on the actual emission.
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

function makeRows(n: number): LocalMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    eventId: `$e${i}`,
    clientId: `c_${i}`,
    roomId: "!a:s",
    senderId: "peer",
    content: `m${i}`,
    timestamp: 1000 + i,
    type: MessageType.text,
    status: "synced",
    version: 1,
    softDeleted: false,
  }));
}

let stored: LocalMessage[] = [];
let readDelayMs = 0;

const getMessages = vi.fn((_roomId: string, limit: number) =>
  new Promise<LocalMessage[]>((r) => setTimeout(() => r(stored.slice(-limit)), readDelayMs)));

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
      getMessages,
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

describe("chat-store expandMessageWindow resolves on the liveQuery emission (B3/B4)", () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
    store.rooms = [makeRoom({ id: "!a:s" })];
    readDelayMs = 0;
    getMessages.mockClear();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setChatDbKit(makeKit() as any);
  });

  async function openRoom(rowCount: number) {
    stored = makeRows(rowCount);
    await store.setActiveRoom("!a:s");
    await waitFor(() => store.activeMessages.length === Math.min(rowCount, 50));
  }

  it("re-queries Dexie with the new window immediately, without the 200ms debounce", async () => {
    await openRoom(200);
    void store.expandMessageWindow();
    await new Promise((r) => setTimeout(r, 30));
    expect(getMessages).toHaveBeenLastCalledWith("!a:s", 75, undefined, undefined);
  });

  it("resolves true after a slow Dexie read (longer than the old 300ms guess)", async () => {
    await openRoom(200);
    readDelayMs = 450;
    const filled = await store.expandMessageWindow();
    expect(filled).toBe(true);
    expect(store.activeMessages).toHaveLength(75);
  });

  it("resolves false when Dexie has no more rows than the new window", async () => {
    await openRoom(60);
    expect(await store.expandMessageWindow()).toBe(false);
    expect(store.activeMessages).toHaveLength(60);
  });

  it("resolves false when the room changes before the emission", async () => {
    await openRoom(200);
    readDelayMs = 200;
    const pending = store.expandMessageWindow();
    store.rooms = [makeRoom({ id: "!a:s" }), makeRoom({ id: "!b:s" })];
    void store.setActiveRoom("!b:s");
    expect(await pending).toBe(false);
  });
});
