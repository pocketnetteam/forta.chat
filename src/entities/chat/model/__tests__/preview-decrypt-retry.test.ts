import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
import { makeRoom, makeMsg } from "@/test-utils";

/**
 * WEE-96 follow-up regression: at cold start the first preview-decrypt pass
 * can exhaust DECRYPT_MAX_RETRIES while the RPC backend is still warming up,
 * and incremental refreshes never re-attempt quiet rooms — previews stayed
 * "[encrypted]" until the chat was opened. retryEncryptedPreviews() must
 * re-run the pass with a fresh retry budget.
 */

const ROOM_ID = "!enc-room:server";

const ENCRYPTED_EVENT = {
  event: {
    type: "m.room.message",
    sender: "@peer:server",
    content: { msgtype: "m.encrypted", body: "b64..." },
    event_id: "$e1",
    origin_server_ts: 1000,
  },
};

const mxRoom = {
  roomId: ROOM_ID,
  getLiveTimeline: () => ({ getEvents: () => [ENCRYPTED_EVENT] }),
};

const mockMatrixService = {
  getUserId: vi.fn(() => "@me:server"),
  getRoom: vi.fn(() => mxRoom),
  getRooms: vi.fn(() => [mxRoom]),
  isReady: vi.fn(() => true),
  sendReadReceipt: vi.fn(async () => true),
  kit: {
    client: { getUserId: () => "@me:server" },
    isTetatetChat: vi.fn(() => true),
    getRoomMembers: vi.fn(() => []),
  },
};
vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: vi.fn(() => mockMatrixService),
}));

import { useChatStore } from "../chat-store";

describe("chat-store — retryEncryptedPreviews (WEE-96 cold-start latch)", () => {
  let store: ReturnType<typeof useChatStore>;
  let decryptEvent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
    vi.clearAllMocks();
    // clearAllMocks doesn't reset implementations — re-establish defaults so
    // per-test mockReturnValue overrides don't leak between tests.
    mockMatrixService.isReady.mockReturnValue(true);
    mockMatrixService.getRooms.mockImplementation(() => [mxRoom]);
    mockMatrixService.getRoom.mockImplementation(() => mxRoom);

    decryptEvent = vi.fn();
    const pcryptoStub = {
      // Pre-seeded room instance — ensureRoomCrypto returns it directly
      rooms: { [ROOM_ID]: { decryptEvent } },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setHelpers(mockMatrixService.kit as any, pcryptoStub as any);

    store.addRoom(makeRoom({
      id: ROOM_ID,
      lastMessage: makeMsg({ roomId: ROOM_ID, content: "[encrypted]" }),
    }));
  });

  it("decrypts the preview even after earlier passes exhausted the retry budget", async () => {
    // Cold start: three passes fail (RPC down) — burns DECRYPT_MAX_RETRIES=3
    decryptEvent.mockRejectedValue(new Error("getusersinfo timed out"));
    for (let attempt = 1; attempt <= 3; attempt++) {
      store.retryEncryptedPreviews();
      await vi.waitFor(() => expect(decryptEvent).toHaveBeenCalledTimes(attempt));
    }

    // Backend warmed up — the next scheduled pass must attempt again
    // (without the fresh-budget clear it would be skipped forever).
    decryptEvent.mockResolvedValue({ body: "real preview", msgtype: "m.text" });
    store.retryEncryptedPreviews();

    await vi.waitFor(() => {
      const room = store.rooms.find((r) => r.id === ROOM_ID);
      expect(room?.lastMessage?.content).toBe("real preview");
    });
  });

  it("is a no-op when Matrix is not ready", () => {
    mockMatrixService.isReady.mockReturnValueOnce(false);
    store.retryEncryptedPreviews();
    expect(mockMatrixService.getRooms).not.toHaveBeenCalled();
  });

  it("rotates the per-cycle cap so later passes reach rooms 21+", async () => {
    // 25 encrypted rooms — one pass caps at 20; without rotation the retry
    // passes would re-attempt the same first 20 forever and starve the rest.
    const attempted = new Set<string>();
    const roomsCrypto: Record<string, unknown> = {};
    const mxRooms: unknown[] = [];
    for (let i = 0; i < 25; i++) {
      const id = `!r${i}:server`;
      roomsCrypto[id] = {
        decryptEvent: vi.fn(async () => {
          attempted.add(id);
          throw new Error("cold backend");
        }),
      };
      mxRooms.push({ roomId: id, getLiveTimeline: () => ({ getEvents: () => [ENCRYPTED_EVENT] }) });
      store.addRoom(makeRoom({
        id,
        lastMessage: makeMsg({ roomId: id, content: "[encrypted]" }),
      }));
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockMatrixService.getRooms.mockReturnValue(mxRooms as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setHelpers(mockMatrixService.kit as any, { rooms: roomsCrypto } as any);

    store.retryEncryptedPreviews();
    await vi.waitFor(() => expect(attempted.size).toBe(20));

    store.retryEncryptedPreviews();
    await vi.waitFor(() => expect(attempted.size).toBe(25));
  });

  it("skips rooms whose preview is already decrypted", async () => {
    // First pass succeeds and caches the result
    decryptEvent.mockResolvedValue({ body: "real preview", msgtype: "m.text" });
    store.retryEncryptedPreviews();
    await vi.waitFor(() => expect(decryptEvent).toHaveBeenCalledTimes(1));

    // A later warm-up pass must not redo the work
    store.retryEncryptedPreviews();
    await new Promise((r) => setTimeout(r, 50));
    expect(decryptEvent).toHaveBeenCalledTimes(1);
  });
});
