import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
import { makeMsg, makeRoom } from "@/test-utils";
import { hexEncode } from "@/shared/lib/matrix/functions";

/**
 * Regression: opening the sidebar with a large public channel (hundreds/
 * thousands of members) used to fetch a profile for EVERY member the
 * instant the room appeared in the room list — loadProfilesForRoomIds()
 * loaded all of ChatRoom.members unconditionally, and ContactList.vue's
 * "eagerly load profiles for ALL rooms" watcher called it for every room,
 * not just visible ones. A shareable-by-link room (public join_rule, or a
 * Bastyon world_readable broadcast channel) only needs its room name
 * (already resolved from Matrix state) and the last-message sender's name
 * in the preview — not every member. Everyone else resolves lazily
 * elsewhere: per-message avatar (UserAvatar's viewport IntersectionObserver)
 * or the capped member list (ChatInfoPanel, see chat-info-panel-member-cap
 * tests).
 *
 * Note: Message.senderId (and therefore ChatRoom.lastMessage.senderId) is
 * already a decoded Bastyon address — matrixIdToAddress() hexDecode()s it
 * before storage (see chat-helpers.ts). It must NOT be hex-encoded here or
 * decoded again in loadProfilesForRoomIds — that was a real regression
 * caught in review (double-decode mangled the address into garbage, making
 * the sender-preload silently do nothing). Only ChatRoom.members entries
 * (the private/group-room branch below) are hex-encoded.
 */

// ── Mock MatrixClientService — join_rule + history_visibility drive
//    isRoomShareableByLink() ──
let roomJoinRule: string | null = "public";
let roomHistoryVisibility: string | null = null;
const mockGetRoom = vi.fn((roomId: string) => ({
  roomId,
  currentState: {
    getStateEvents: (type: string, stateKey?: string) => {
      if (type === "m.room.join_rules") {
        if (roomJoinRule == null) return stateKey === "" ? null : [];
        return { getContent: () => ({ join_rule: roomJoinRule }) };
      }
      if (type === "m.room.history_visibility") {
        if (roomHistoryVisibility == null) return stateKey === "" ? null : [];
        return { getContent: () => ({ history_visibility: roomHistoryVisibility }) };
      }
      return stateKey === "" ? null : [];
    },
  },
}));
const mockGetUserIdFn = vi.fn(() => "@me:server");
const mockMatrixService = {
  getUserId: mockGetUserIdFn,
  getRoom: mockGetRoom,
  sendReadReceipt: vi.fn(async () => true),
  kit: {
    client: { getUserId: mockGetUserIdFn },
    isTetatetChat: vi.fn(() => true),
    getRoomMembers: vi.fn(() => []),
  },
};

vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: vi.fn(() => mockMatrixService),
}));

// ── Mock UserStore — assert exactly which addresses get enqueued ────
const mockEnqueueProfiles = vi.fn();
let mockUsers: Record<string, unknown> = {};
vi.mock("@/entities/user/model", () => ({
  useUserStore: () => ({
    users: mockUsers,
    enqueueProfiles: mockEnqueueProfiles,
  }),
}));

import { useChatStore } from "./../chat-store";

describe("loadProfilesForRoomIds — shareable-by-link rooms skip the full member list", () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
    mockEnqueueProfiles.mockClear();
    mockUsers = {};
    roomJoinRule = "public";
    roomHistoryVisibility = null;
  });

  it("loads only the last-message sender (already a decoded address), not all members, for a public room", () => {
    const senderAddr = "PSenderAddress1111111111111111111111";
    const hugeMemberList = Array.from({ length: 500 }, (_, i) => hexEncode(`PMember${i}`));

    store.rooms.push(makeRoom({
      id: "!public:server",
      isGroup: true,
      members: hugeMemberList,
      lastMessage: makeMsg({ senderId: senderAddr }),
    }));

    store.loadProfilesForRoomIds(["!public:server"]);

    expect(mockEnqueueProfiles).toHaveBeenCalledTimes(1);
    expect(mockEnqueueProfiles).toHaveBeenCalledWith([senderAddr]);
  });

  it("also skips the full member list for a world_readable broadcast channel (join_rule=invite)", () => {
    roomJoinRule = "invite";
    roomHistoryVisibility = "world_readable";
    const senderAddr = "PBroadcastSender333333333333333333333";

    store.rooms.push(makeRoom({
      id: "!broadcast:server",
      isGroup: true,
      members: Array.from({ length: 300 }, (_, i) => hexEncode(`PMember${i}`)),
      lastMessage: makeMsg({ senderId: senderAddr }),
    }));

    store.loadProfilesForRoomIds(["!broadcast:server"]);

    expect(mockEnqueueProfiles).toHaveBeenCalledTimes(1);
    expect(mockEnqueueProfiles).toHaveBeenCalledWith([senderAddr]);
  });

  it("does not enqueue anything when the sender is already cached", () => {
    const senderAddr = "PSenderAddress2222222222222222222222";
    mockUsers = { [senderAddr]: { name: "Already cached" } };

    store.rooms.push(makeRoom({
      id: "!public2:server",
      isGroup: true,
      members: Array.from({ length: 200 }, (_, i) => hexEncode(`PMember${i}`)),
      lastMessage: makeMsg({ senderId: senderAddr }),
    }));

    store.loadProfilesForRoomIds(["!public2:server"]);

    expect(mockEnqueueProfiles).not.toHaveBeenCalled();
  });

  it("still loads every member for a private/group room (unaffected by this change)", () => {
    roomJoinRule = "invite";
    const members = [hexEncode("PMemberA"), hexEncode("PMemberB")];

    store.rooms.push(makeRoom({
      id: "!private:server",
      isGroup: true,
      members,
    }));

    store.loadProfilesForRoomIds(["!private:server"]);

    expect(mockEnqueueProfiles).toHaveBeenCalledTimes(1);
    const loaded = mockEnqueueProfiles.mock.calls[0][0] as string[];
    expect(new Set(loaded)).toEqual(new Set(["PMemberA", "PMemberB"]));
  });

  it("does not treat a 2-member room as shareable even if its state says public (isGroup gate)", () => {
    // Regression (review): loadProfilesForRoomIds lacked the isGroup guard
    // ChatInfoPanel's own roomShareable computed has — a misclassified DM
    // would only preload the last-message sender, silently starving the
    // other participant's profile.
    roomJoinRule = "public";
    const members = [hexEncode("PMemberA"), hexEncode("PMemberB")];

    store.rooms.push(makeRoom({
      id: "!dm:server",
      isGroup: false,
      members,
    }));

    store.loadProfilesForRoomIds(["!dm:server"]);

    expect(mockEnqueueProfiles).toHaveBeenCalledTimes(1);
    const loaded = mockEnqueueProfiles.mock.calls[0][0] as string[];
    expect(new Set(loaded)).toEqual(new Set(["PMemberA", "PMemberB"]));
  });

  it("still recognizes a broadcast channel as shareable at cold start, before the Matrix room has synced", () => {
    // Regression (review): isRoomShareableByLink() needs a live Matrix SDK
    // room object. At cold start (ChatSidebar renders Dexie-cached rooms
    // before login/sync finishes) getRoom() returns undefined and the live
    // check returns false — falling through to the expensive full-member
    // load for exactly the large rooms this fix targets. The persisted
    // dexieRoomMap.historyVisibility (written the last time the room WAS
    // live-checked) must still catch this case.
    mockGetRoom.mockReturnValueOnce(undefined as never);
    const senderAddr = "PColdStartSender4444444444444444444444";

    store.rooms.push(makeRoom({
      id: "!coldstart:server",
      isGroup: true,
      members: Array.from({ length: 400 }, (_, i) => hexEncode(`PMember${i}`)),
      lastMessage: makeMsg({ senderId: senderAddr }),
    }));
    store.dexieRoomMap.set("!coldstart:server", { historyVisibility: "world_readable" } as never);

    store.loadProfilesForRoomIds(["!coldstart:server"]);

    expect(mockEnqueueProfiles).toHaveBeenCalledTimes(1);
    expect(mockEnqueueProfiles).toHaveBeenCalledWith([senderAddr]);
  });
});
