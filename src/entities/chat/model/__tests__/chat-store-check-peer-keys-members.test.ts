// @vitest-environment happy-dom
/**
 * checkPeerKeys() completes the open chat's participant list before reading
 * canBeEncrypt(): with lazy-loaded members a fresh 1:1 room has no peer, and
 * the banner said "peer hasn't published encryption keys" although they had
 * (the bug behind ba89a056). Rooms that are not open are left alone — the
 * bulk callers would turn it into a /members request per room.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
import { makeRoom } from "@/test-utils";

const ROOM_ID = "!dm:s";
const OTHER_ID = "!other:s";

const mxRoom = (roomId: string) => ({ roomId, getJoinedMemberCount: () => 2 });
const mockMatrixService = {
  getRoom: vi.fn((id: string) => mxRoom(id)),
  getRooms: vi.fn(() => [mxRoom(ROOM_ID), mxRoom(OTHER_ID)]),
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

/** A room crypto whose peer shows up only once the members are loaded. */
const lazyCrypto = (loadFails = false) => {
  let peerKnown = false;
  return {
    ensureMembers: vi.fn(async () => {
      if (loadFails) throw new Error("members 500");
      peerKnown = true;
    }),
    canBeEncrypt: () => peerKnown,
    getKeysLoadState: () => "loaded" as const,
    prepare: vi.fn(async () => undefined),
  };
};

describe("checkPeerKeys — participants completed first", () => {
  let store: ReturnType<typeof useChatStore>;

  const setup = (rooms: Record<string, ReturnType<typeof lazyCrypto>>) => {
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
    const pcrypto = { rooms };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setHelpers(mockMatrixService.kit as any, pcrypto as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (useAuthStore() as any).pcrypto = pcrypto;
    store.addRoom(makeRoom({ id: ROOM_ID }));
    store.addRoom(makeRoom({ id: OTHER_ID }));
    store.activeRoomId = ROOM_ID;
  };

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("reports 'available' for the open chat once its peer is loaded (regression: ba89a056)", async () => {
    const crypto = lazyCrypto();
    setup({ [ROOM_ID]: crypto });

    expect(await store.checkPeerKeys(ROOM_ID)).toBe("available");
    expect(crypto.ensureMembers).toHaveBeenCalled();
  });

  it("does not load members for a room that is not open", async () => {
    const other = lazyCrypto();
    setup({ [ROOM_ID]: lazyCrypto(), [OTHER_ID]: other });

    await store.checkPeerKeys(OTHER_ID);

    expect(other.ensureMembers).not.toHaveBeenCalled();
  });

  it("still answers when the members cannot be loaded", async () => {
    setup({ [ROOM_ID]: lazyCrypto(true) });
    expect(await store.checkPeerKeys(ROOM_ID)).toBe("missing");
  });
});
