// @vitest-environment happy-dom
/**
 * Regression: opening a chat while its key request was still in flight (or
 * had timed out) reported "missing" — "Peer hasn't published encryption keys"
 * — for a peer that had keys; the chat recovered only minutes later. Keys not
 * received yet must read as "loading", and a failed request for the open chat
 * must be retried instead of waiting for an unrelated event.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
import { makeRoom } from "@/test-utils";
import type { KeysLoadState } from "@/entities/matrix/model/matrix-crypto";

const ROOM_ID = "!dm:s";

const mxRoom = { roomId: ROOM_ID, getJoinedMemberCount: () => 2 };
const mockMatrixService = {
  getRoom: vi.fn(() => mxRoom),
  getRooms: vi.fn(() => [mxRoom]),
  isReady: vi.fn(() => true),
  getUserId: vi.fn(() => "@me:s"),
  getRoomAccountData: vi.fn(() => null),
  getIgnoredMatrixUserIds: vi.fn(() => [] as string[]),
  matrixId: vi.fn((id: string) => id),
  isMe: vi.fn(() => false),
  kit: {
    client: { getUserId: () => "@me:s" },
    isTetatetChat: vi.fn(() => true),
    getRoomMembers: vi.fn(() => []),
  },
};
vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: vi.fn(() => mockMatrixService),
}));

import { useChatStore } from "../chat-store";
import { useAuthStore } from "@/entities/auth";

describe("checkPeerKeys — keys not received yet", () => {
  let store: ReturnType<typeof useChatStore>;
  let keysState: KeysLoadState;
  let canEncrypt: boolean;
  const prepare = vi.fn(async () => roomCrypto);
  const roomCrypto = {
    canBeEncrypt: () => canEncrypt,
    getKeysLoadState: () => keysState,
    prepare,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
    prepare.mockClear();
    keysState = "loading";
    canEncrypt = false;
    const pcrypto = { rooms: { [ROOM_ID]: roomCrypto } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setHelpers(mockMatrixService.kit as any, pcrypto as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (useAuthStore() as any).pcrypto = pcrypto;
    store.addRoom(makeRoom({ id: ROOM_ID }));
    store.activeRoomId = ROOM_ID;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports 'loading', not 'missing', while the key request is in flight", async () => {
    expect(await store.checkPeerKeys(ROOM_ID)).toBe("loading");
    expect(store.peerKeysStatus.get(ROOM_ID)).toBe("loading");
  });

  it("reports 'missing' only once the keys were received and the peer has none", async () => {
    keysState = "loaded";
    expect(await store.checkPeerKeys(ROOM_ID)).toBe("missing");
  });

  it("reports 'available' when the room can encrypt", async () => {
    canEncrypt = true;
    keysState = "loaded";
    expect(await store.checkPeerKeys(ROOM_ID)).toBe("available");
  });

  it("retries a failed key request for the open chat with backoff", async () => {
    keysState = "failed";
    expect(await store.checkPeerKeys(ROOM_ID)).toBe("loading");
    expect(prepare).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3_000);
    expect(prepare).toHaveBeenCalledTimes(1);

    // The retry failed again → onKeysFailed → checkPeerKeys: next delay doubles
    await store.checkPeerKeys(ROOM_ID);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(prepare).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it("reports 'load-failed' after repeated failures so the banner offers a forced retry", async () => {
    keysState = "failed";
    // Each failure → onKeysFailed → checkPeerKeys; three automatic retries fail
    expect(await store.checkPeerKeys(ROOM_ID)).toBe("loading");
    expect(await store.checkPeerKeys(ROOM_ID)).toBe("loading");
    for (const delay of [3_000, 6_000]) {
      await vi.advanceTimersByTimeAsync(delay);
      expect(await store.checkPeerKeys(ROOM_ID)).toBe("loading");
    }
    await vi.advanceTimersByTimeAsync(12_000);
    expect(await store.checkPeerKeys(ROOM_ID)).toBe("load-failed");

    // Keys finally arrive → available, and the failure count resets
    canEncrypt = true;
    keysState = "loaded";
    expect(await store.checkPeerKeys(ROOM_ID)).toBe("available");
    canEncrypt = false;
    keysState = "failed";
    expect(await store.checkPeerKeys(ROOM_ID)).toBe("loading");
  });

  it("does not retry for a chat that is no longer open", async () => {
    keysState = "failed";
    await store.checkPeerKeys(ROOM_ID);
    store.activeRoomId = null;

    await vi.advanceTimersByTimeAsync(30_000);
    expect(prepare).not.toHaveBeenCalled();
  });
});
