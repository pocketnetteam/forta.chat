// @vitest-environment happy-dom
/**
 * Lazy-loaded members (plan 2026-10-03-initial-sync-lazy-members, phase I).
 * With `lazyLoadMembers` the SDK member list of a 1:1 room can hold only the
 * own user until the peer posts. Everything that used to read the peer from
 * that list must find them elsewhere or load the members first:
 *  - the preview cycle loads all its rooms' keys in ONE request, with the
 *    peer taken from the encrypted events (else one request per room);
 *  - profile loading does not mark a 1:1 room done while only the own
 *    address is known;
 *  - deleting a chat loads the members before kicking them.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
import { makeRoom, makeMsg } from "@/test-utils";
import { hexEncode } from "@/shared/lib/matrix/functions";

const ME = "PMeAddress1111";
const PEER_A = "PPeerAddressAA";
const PEER_B = "PPeerAddressBB";
const hex = (a: string) => hexEncode(a).toLowerCase();
const b64Json = (obj: unknown) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64");

/** One's own last message in a 1:1 room — its Pcrypto body names the peer. */
const ownEncrypted = (id: string, peer: string) => ({
  event: {
    type: "m.room.message",
    sender: `@${hex(ME)}:s`,
    content: { msgtype: "m.encrypted", body: b64Json({ [hex(ME)]: { e: 1 }, [hex(peer)]: { e: 1 } }) },
    event_id: id,
    origin_server_ts: 1000,
  },
});

const mxRooms = new Map<string, Record<string, unknown>>();
const mockMatrixService = {
  getUserId: vi.fn(() => `@${hex(ME)}:s`),
  getRoom: vi.fn((id: string) => mxRooms.get(id)),
  getRooms: vi.fn(() => [...mxRooms.values()]),
  isReady: vi.fn(() => true),
  sendReadReceipt: vi.fn(async () => true),
  kick: vi.fn(async () => {}),
  leaveRoom: vi.fn(async () => {}),
  forgetRoom: vi.fn(async () => {}),
  deleteAlias: vi.fn(async () => {}),
  kit: {
    client: { getUserId: () => `@${hex(ME)}:s` },
    isTetatetChat: vi.fn(() => true),
    getRoomMembers: vi.fn(() => []),
  },
};
vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: vi.fn(() => mockMatrixService),
}));

const authMock = { address: ME, loadUsersInfo: vi.fn(async (_addresses: string[]) => {}), pcrypto: null };
vi.mock("@/entities/auth/model/stores", () => ({ useAuthStore: () => authMock }));

const mockEnqueueProfiles = vi.fn();
let mockUsers: Record<string, unknown> = {};
vi.mock("@/entities/user/model", () => ({
  useUserStore: () => ({
    users: mockUsers,
    enqueueProfiles: mockEnqueueProfiles,
    loadUserIfMissing: vi.fn(),
    getUser: (a: string) => mockUsers[a],
  }),
}));

vi.mock("../../lib/room-guards", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/room-guards")>()),
  resetPowerLevel: vi.fn(async () => {}),
}));

import { useChatStore } from "../chat-store";

describe("chat-store with lazy-loaded members", () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
    mxRooms.clear();
    mockUsers = {};
    vi.clearAllMocks();
  });

  describe("preview cycle", () => {
    const order: string[] = [];

    const setup = (rooms: { id: string; peer: string; joined?: number }[]) => {
      const roomsCrypto: Record<string, unknown> = {};
      for (const { id, peer, joined } of rooms) {
        mxRooms.set(id, {
          roomId: id,
          getLiveTimeline: () => ({ getEvents: () => [ownEncrypted(`$${id}`, peer)] }),
          getJoinedMemberCount: () => joined ?? 2,
        });
        roomsCrypto[id] = {
          decryptEvent: vi.fn(async () => {
            order.push(`decrypt ${id}`);
            return { body: `plain ${id}`, msgtype: "m.text" };
          }),
        };
        // The SDK delivered only the own member: the stored room knows no peer.
        store.addRoom(makeRoom({
          id,
          isGroup: false,
          members: [hex(ME)],
          lastMessage: makeMsg({ id: `$${id}`, roomId: id, content: "[encrypted]" }),
        }));
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      store.setHelpers(mockMatrixService.kit as any, { rooms: roomsCrypto } as any);
    };

    it("loads the keys of all its rooms in one request, peers taken from the encrypted events", async () => {
      order.length = 0;
      setup([{ id: "!a:s", peer: PEER_A }, { id: "!b:s", peer: PEER_B }]);
      authMock.loadUsersInfo.mockImplementation(async (_addresses: string[]) => { order.push("preload"); });

      store.setVisibleSidebarRooms(["!a:s", "!b:s"]);
      const preview = (id: string) => store.rooms.find((r) => r.id === id)?.lastMessage?.content;
      await vi.waitFor(() => expect(preview("!b:s")).toBe("plain !b:s"));

      const preloads = authMock.loadUsersInfo.mock.calls.filter((c) => (c[0] as string[]).length > 1);
      expect(preloads).toHaveLength(1);
      expect((preloads[0][0] as string[]).sort()).toEqual([PEER_A, PEER_B].sort());
      // Started before any room decrypted.
      expect(order[0]).toBe("preload");
    });

    it("leaves out a large group by the server's count", async () => {
      setup([{ id: "!a:s", peer: PEER_A }, { id: "!g:s", peer: PEER_B, joined: 80 }]);

      store.setVisibleSidebarRooms(["!a:s", "!g:s"]);
      await vi.waitFor(() => expect(authMock.loadUsersInfo).toHaveBeenCalled());

      expect(authMock.loadUsersInfo.mock.calls[0][0]).toEqual([PEER_A]);
    });
  });

  describe("profile loading", () => {
    it("keeps a 1:1 room open while only the own address is known", () => {
      mockUsers[ME] = { address: ME, name: "Me" };
      store.rooms.push(makeRoom({ id: "!c:s", isGroup: false, members: [hex(ME)] }));

      store.loadProfilesForRoomIds(["!c:s"]);
      expect(mockEnqueueProfiles).not.toHaveBeenCalled();

      // Members arrive (loaded or synced): the next call must still look.
      store.rooms[store.rooms.length - 1].members = [hex(ME), hex(PEER_A)];
      store.loadProfilesForRoomIds(["!c:s"]);
      expect(mockEnqueueProfiles).toHaveBeenCalledWith([PEER_A]);
    });

    it("finds the peer in the stored room when the SDK list has only the own user", () => {
      mockUsers[ME] = { address: ME, name: "Me" };
      mxRooms.set("!d:s", { roomId: "!d:s", getLiveTimeline: () => ({ getEvents: () => [] }) });
      store.rooms.push(makeRoom({ id: "!d:s", isGroup: false, members: [hex(ME), hex(PEER_B)] }));

      store.loadProfilesForRoomIds(["!d:s"]);

      expect(mockEnqueueProfiles).toHaveBeenCalledWith([PEER_B]);
    });
  });

  describe("deleting a chat", () => {
    it("loads the members before kicking, so the peer is kicked too", async () => {
      const joined = [{ userId: `@${hex(ME)}:s` }];
      let loaded = false;
      mxRooms.set("!e:s", {
        roomId: "!e:s",
        membersLoaded: () => loaded,
        getMyMembership: () => "join",
        loadMembersIfNeeded: vi.fn(async () => {
          joined.push({ userId: `@${hex(PEER_A)}:s` });
          loaded = true;
          return true;
        }),
        getJoinedMembers: () => joined,
        getLiveTimeline: () => ({ getEvents: () => [] }),
      });
      store.rooms.push(makeRoom({ id: "!e:s", isGroup: false, members: [hex(ME)] }));

      await store.removeRoom("!e:s");

      expect(mockMatrixService.kick).toHaveBeenCalledWith("!e:s", `@${hex(PEER_A)}:s`);
      expect(mockMatrixService.leaveRoom).toHaveBeenCalledWith("!e:s");
    });

    it("does not request members when the SDK has them all (lazy loading off)", async () => {
      const loadMembersIfNeeded = vi.fn(async () => true);
      mxRooms.set("!f:s", {
        roomId: "!f:s",
        membersLoaded: () => true,
        loadMembersIfNeeded,
        getJoinedMembers: () => [{ userId: `@${hex(ME)}:s` }, { userId: `@${hex(PEER_B)}:s` }],
        getLiveTimeline: () => ({ getEvents: () => [] }),
      });
      store.rooms.push(makeRoom({ id: "!f:s", isGroup: false, members: [hex(ME), hex(PEER_B)] }));

      await store.removeRoom("!f:s");

      expect(loadMembersIfNeeded).not.toHaveBeenCalled();
      expect(mockMatrixService.kick).toHaveBeenCalledWith("!f:s", `@${hex(PEER_B)}:s`);
    });
  });
});
