import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
import { useChatStore } from "./chat-store";
import { makeRoom, makeMsg } from "@/test-utils";

// ── Mocks ─────────────────────────────────────────────────────────
vi.mock("@/shared/lib/cache/chat-cache", () => ({
  cacheRooms: vi.fn(() => Promise.resolve()),
  getCachedRooms: vi.fn(() => Promise.resolve([])),
  cacheMessages: vi.fn(() => Promise.resolve()),
  getCachedMessages: vi.fn(() => Promise.resolve([])),
  getCacheTimestamp: vi.fn(() => Promise.resolve(null)),
}));

const mockSendReadReceipt = vi.fn(async () => true);

vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: vi.fn(() => ({
    isReady: () => true,
    getUserId: () => "@mock:s",
    getRoom: vi.fn((roomId: string) => ({
      roomId,
      getLiveTimeline: () => ({
        getEvents: () => [
          {
            getTs: () => 1000,
            event: { origin_server_ts: 1000, event_id: "$ev1" },
          },
          {
            getTs: () => 2000,
            event: { origin_server_ts: 2000, event_id: "$ev2" },
          },
          {
            getTs: () => 3000,
            event: { origin_server_ts: 3000, event_id: "$ev3" },
          },
        ],
      }),
    })),
    getRooms: () => [],
    sendReadReceipt: mockSendReadReceipt,
  })),
}));

/** Advance coalescing timer (100ms) and flush microtasks */
async function flushCoalescing() {
  vi.advanceTimersByTime(150);
  await new Promise<void>((r) => { queueMicrotask(r); });
  await new Promise<void>((r) => { queueMicrotask(r); });
}

describe("receipt throttling", () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Ensure document.visibilityState returns "visible" for sendReadReceiptIfVisible
    vi.stubGlobal("document", {
      ...document,
      visibilityState: "visible",
      addEventListener: document.addEventListener.bind(document),
      removeEventListener: document.removeEventListener.bind(document),
    });
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
    store.addRoom(makeRoom({ id: "!r1:s" }));
    store.addMessage("!r1:s", makeMsg({ roomId: "!r1:s", timestamp: 1000 }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("sends receipt on first call", async () => {
    await store.advanceInboundWatermark("!r1:s", 1000);
    await flushCoalescing();
    expect(mockSendReadReceipt).toHaveBeenCalledTimes(1);
  });

  it("throttles rapid calls within cooldown window", async () => {
    await store.advanceInboundWatermark("!r1:s", 1000);
    await flushCoalescing();
    expect(mockSendReadReceipt).toHaveBeenCalledTimes(1);

    // Within 3s cooldown — queued, not sent
    await store.advanceInboundWatermark("!r1:s", 2000);
    await flushCoalescing();
    expect(mockSendReadReceipt).toHaveBeenCalledTimes(1);

    await store.advanceInboundWatermark("!r1:s", 3000);
    await flushCoalescing();
    expect(mockSendReadReceipt).toHaveBeenCalledTimes(1);
  });

  it("allows receipt after cooldown expires", async () => {
    await store.advanceInboundWatermark("!r1:s", 1000);
    await flushCoalescing();
    expect(mockSendReadReceipt).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(3100);

    await store.advanceInboundWatermark("!r1:s", 2000);
    await flushCoalescing();
    expect(mockSendReadReceipt).toHaveBeenCalledTimes(2);
  });

  it("different rooms have independent cooldowns", async () => {
    store.addRoom(makeRoom({ id: "!r2:s" }));

    await store.advanceInboundWatermark("!r1:s", 1000);
    await flushCoalescing();

    // Room change flushes previous room immediately + starts coalescing for new room
    await store.advanceInboundWatermark("!r2:s", 1000);
    await flushCoalescing();

    expect(mockSendReadReceipt).toHaveBeenCalledTimes(2);
  });
});
