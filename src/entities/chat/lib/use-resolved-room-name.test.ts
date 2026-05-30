import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
import { useResolvedRoomName } from "./use-resolved-room-name";
import { useChatStore } from "../model/chat-store";
import { useUserStore } from "@/entities/user/model";
import { useAuthStore } from "@/entities/auth";
import { hexEncode } from "@/shared/lib/matrix/functions";
import type { ChatRoom } from "../model/types";

/**
 * Regression test for the Session 51 bug "alias saves but chat list / header
 * still show old name". Root cause: `resolveMemberNames` consulted
 * `userStore.users[addr].name` directly without checking `localAliases`, so a
 * Pocketnet-known user always rendered with their Pocketnet name regardless
 * of the user's local rename. This test pins the new priority chain:
 *
 *     localAlias > Pocketnet user.name > Matrix displayname > address fallback
 */

function makeDmRoom(peerHex: string, name: string = "fallback name"): ChatRoom {
  return {
    id: "!room:server",
    name,
    isGroup: false,
    members: [peerHex],
    invitedMembers: [],
    membership: "join",
    unreadCount: 0,
    lastReadInboundTs: 0,
    lastReadOutboundTs: 0,
    updatedAt: Date.now(),
    syncedAt: Date.now(),
    hasMoreHistory: true,
    isDeleted: false,
    deletedAt: null,
    deleteReason: null,
  } as ChatRoom;
}

describe("useResolvedRoomName — local alias priority (Session 51)", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setActivePinia(createTestingPinia({ stubActions: false }));
  });

  it("returns Pocketnet displayname when no alias is set", () => {
    const auth = useAuthStore();
    auth.address = "PMyAddr";
    const user = useUserStore();
    const peer = "PPeerAddr";
    user.users[peer] = { name: "Peer Pocketnet Name" } as any;

    const room = makeDmRoom(hexEncode(peer));
    const { resolve } = useResolvedRoomName();
    expect(resolve(room)).toBe("Peer Pocketnet Name");
  });

  it("returns local alias when set, overriding Pocketnet displayname", () => {
    const auth = useAuthStore();
    auth.address = "PMyAddr";
    const user = useUserStore();
    const chat = useChatStore();
    const peer = "PPeerAddr";
    user.users[peer] = { name: "Peer Pocketnet Name" } as any;
    chat.localAliases[peer] = "Дядя Петя";

    const room = makeDmRoom(hexEncode(peer));
    const { resolve } = useResolvedRoomName();
    expect(resolve(room)).toBe("Дядя Петя");
  });

  it("falls back to Pocketnet after alias is cleared", async () => {
    const auth = useAuthStore();
    auth.address = "PMyAddr";
    const user = useUserStore();
    const chat = useChatStore();
    const peer = "PPeerAddr";
    user.users[peer] = { name: "Pocketnet Name" } as any;

    await chat.setContactAlias(peer, "Custom");
    const { resolve } = useResolvedRoomName();
    const room = makeDmRoom(hexEncode(peer));
    expect(resolve(room)).toBe("Custom");

    await chat.setContactAlias(peer, null);
    expect(resolve(room)).toBe("Pocketnet Name");
  });
});
