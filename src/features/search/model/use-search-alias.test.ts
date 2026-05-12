import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
import { useSearch } from "./use-search";
import { useChatStore } from "@/entities/chat";
import { useUserStore } from "@/entities/user/model";
import { hexEncode } from "@/shared/lib/matrix/functions";
import type { ChatRoom } from "@/entities/chat";

/**
 * Regression test for Session 51 follow-up: chat search must include local
 * aliases. Before this fix, `useSearch.chatResults` only consulted
 * userStore.users[addr].name in `getMemberNameLower`, so a user-set alias
 * was invisible to the chat list / quick search ranker.
 *
 * Verifies:
 *   1. A DM with alias "Дядя Петя" is found when typing "Петя".
 *   2. The same DM is still found by the Pocketnet profile name.
 *   3. Clearing the alias removes alias-only matches.
 */

// Mock the matrix client service — search needs to call getMatrixRoom().
vi.mock("@/entities/matrix", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/entities/matrix");
  return {
    ...actual,
    getMatrixClientService: () => ({ getRoom: () => null }),
  };
});

function makeDmRoom(peerHex: string, id: string = "!dm:s"): ChatRoom {
  return {
    id,
    name: "DM",
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

describe("useSearch — alias-aware chat search (Session 51)", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setActivePinia(createTestingPinia({ stubActions: false }));
  });

  it("finds a DM by the user's local alias", () => {
    const chat = useChatStore();
    const user = useUserStore();
    const peer = "PPeerAddr";
    const room = makeDmRoom(hexEncode(peer));
    chat.rooms = [room];
    user.users[peer] = { name: "Original Pocketnet" } as any;
    chat.localAliases[peer] = "Дядя Петя";

    const search = useSearch();
    search.query.value = "Петя";
    expect(search.chatResults.value.map(r => r.id)).toContain(room.id);
  });

  it("still finds a DM by Pocketnet profile name when alias is set", () => {
    const chat = useChatStore();
    const user = useUserStore();
    const peer = "PPeerAddr";
    const room = makeDmRoom(hexEncode(peer));
    chat.rooms = [room];
    user.users[peer] = { name: "Original Pocketnet" } as any;
    chat.localAliases[peer] = "Custom";

    const search = useSearch();
    search.query.value = "Pocketnet";
    expect(search.chatResults.value.map(r => r.id)).toContain(room.id);
  });

  it("does not match by alias after the alias is cleared", async () => {
    const chat = useChatStore();
    const user = useUserStore();
    const peer = "PPeerAddr";
    const room = makeDmRoom(hexEncode(peer));
    chat.rooms = [room];
    user.users[peer] = { name: "Original" } as any;

    await chat.setContactAlias(peer, "TempAlias");
    const search = useSearch();
    search.query.value = "TempAlias";
    expect(search.chatResults.value.map(r => r.id)).toContain(room.id);

    await chat.setContactAlias(peer, null);
    expect(search.chatResults.value.map(r => r.id)).not.toContain(room.id);
  });
});
