import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
import { makeMsg, makeRoom } from "@/test-utils";
import { MessageStatus, MessageType } from "./types";

// ── Mock MatrixClientService ───────────────────────────────────────
const mockGetRoom = vi.fn(() => ({ selfMembership: "join" }));
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

import { useChatStore } from "./chat-store";
import { getMatrixClientService } from "@/entities/matrix";

describe("chat-store", () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
  });

  // ─── addMessage ───────────────────────────────────────────────

  describe("addMessage", () => {
    it("adds a message to a room", () => {
      const msg = makeMsg({ roomId: "!r1:s" });
      store.addMessage("!r1:s", msg);
      expect(store.messages["!r1:s"]).toHaveLength(1);
      expect(store.messages["!r1:s"][0].id).toBe(msg.id);
    });

    it("avoids duplicate messages (same id)", () => {
      const msg = makeMsg({ id: "dup1", roomId: "!r1:s" });
      store.addMessage("!r1:s", msg);
      store.addMessage("!r1:s", msg);
      expect(store.messages["!r1:s"]).toHaveLength(1);
    });

    it("updates room lastMessage and updatedAt", () => {
      const room = makeRoom({ id: "!r1:s" });
      store.rooms.push(room);
      const msg = makeMsg({ roomId: "!r1:s", timestamp: 999 });
      store.addMessage("!r1:s", msg);
      expect(store.rooms[0].lastMessage?.id).toBe(msg.id);
      expect(store.rooms[0].updatedAt).toBe(999);
    });

    it("creates message array for new room", () => {
      const msg = makeMsg({ roomId: "!new:s" });
      store.addMessage("!new:s", msg);
      expect(store.messages["!new:s"]).toBeDefined();
    });
  });

  // ─── updateMessageStatus ──────────────────────────────────────

  describe("updateMessageStatus", () => {
    it("transitions message status", () => {
      const msg = makeMsg({ roomId: "!r1:s", status: MessageStatus.sending });
      store.addMessage("!r1:s", msg);
      store.updateMessageStatus("!r1:s", msg.id, MessageStatus.sent);
      expect(store.messages["!r1:s"][0].status).toBe(MessageStatus.sent);
    });

    it("does nothing for non-existent message", () => {
      store.addMessage("!r1:s", makeMsg({ roomId: "!r1:s" }));
      store.updateMessageStatus("!r1:s", "nonexistent", MessageStatus.read);
      expect(store.messages["!r1:s"]).toHaveLength(1);
    });

    it("transitions through all status stages", () => {
      const msg = makeMsg({ roomId: "!r1:s", status: MessageStatus.sending });
      store.addMessage("!r1:s", msg);

      store.updateMessageStatus("!r1:s", msg.id, MessageStatus.sent);
      expect(store.messages["!r1:s"][0].status).toBe(MessageStatus.sent);

      store.updateMessageStatus("!r1:s", msg.id, MessageStatus.delivered);
      expect(store.messages["!r1:s"][0].status).toBe(MessageStatus.delivered);

      store.updateMessageStatus("!r1:s", msg.id, MessageStatus.read);
      expect(store.messages["!r1:s"][0].status).toBe(MessageStatus.read);
    });
  });

  // ─── updateMessageContent ─────────────────────────────────────

  describe("updateMessageContent", () => {
    it("updates content and sets edited flag", () => {
      const msg = makeMsg({ roomId: "!r1:s", content: "original" });
      store.addMessage("!r1:s", msg);
      store.updateMessageContent("!r1:s", msg.id, "edited text");
      expect(store.messages["!r1:s"][0].content).toBe("edited text");
      expect(store.messages["!r1:s"][0].edited).toBe(true);
    });

    it("does nothing for non-existent message", () => {
      store.addMessage("!r1:s", makeMsg({ roomId: "!r1:s" }));
      store.updateMessageContent("!r1:s", "nonexistent", "new");
      // No crash
    });
  });

  // ─── removeMessage ────────────────────────────────────────────

  describe("removeMessage", () => {
    it("marks message as deleted (WhatsApp-style)", () => {
      const msg = makeMsg({ roomId: "!r1:s" });
      store.addMessage("!r1:s", msg);
      store.removeMessage("!r1:s", msg.id);
      expect(store.messages["!r1:s"]).toHaveLength(1);
      expect(store.messages["!r1:s"][0].deleted).toBe(true);
      expect(store.messages["!r1:s"][0].content).toBe("");
    });

    it("does not crash for non-existent room", () => {
      store.removeMessage("!missing:s", "msg1");
      // No crash
    });
  });

  // ─── optimisticAddReaction ────────────────────────────────────

  describe("optimisticAddReaction", () => {
    it("creates a reaction entry", () => {
      const msg = makeMsg({ roomId: "!r1:s" });
      store.addMessage("!r1:s", msg);
      store.optimisticAddReaction("!r1:s", msg.id, "👍", "alice");
      const reactions = store.messages["!r1:s"][0].reactions;
      expect(reactions?.["👍"]).toBeDefined();
      expect(reactions?.["👍"].count).toBe(1);
      expect(reactions?.["👍"].users).toContain("alice");
      expect(reactions?.["👍"].myEventId).toBe("__optimistic__");
    });

    it("does not duplicate same user reaction", () => {
      const msg = makeMsg({ roomId: "!r1:s" });
      store.addMessage("!r1:s", msg);
      store.optimisticAddReaction("!r1:s", msg.id, "👍", "alice");
      store.optimisticAddReaction("!r1:s", msg.id, "👍", "alice");
      expect(store.messages["!r1:s"][0].reactions?.["👍"].count).toBe(1);
    });

    it("allows different users to react with same emoji", () => {
      const msg = makeMsg({ roomId: "!r1:s" });
      store.addMessage("!r1:s", msg);
      store.optimisticAddReaction("!r1:s", msg.id, "❤️", "alice");
      store.optimisticAddReaction("!r1:s", msg.id, "❤️", "bob");
      expect(store.messages["!r1:s"][0].reactions?.["❤️"].count).toBe(2);
    });
  });

  // ─── optimisticRemoveReaction ─────────────────────────────────

  describe("optimisticRemoveReaction", () => {
    it("decrements count and removes user", () => {
      const msg = makeMsg({ roomId: "!r1:s" });
      store.addMessage("!r1:s", msg);
      store.optimisticAddReaction("!r1:s", msg.id, "👍", "alice");
      store.optimisticAddReaction("!r1:s", msg.id, "👍", "bob");
      store.optimisticRemoveReaction("!r1:s", msg.id, "👍", "alice");
      const rd = store.messages["!r1:s"][0].reactions?.["👍"];
      expect(rd?.count).toBe(1);
      expect(rd?.users).not.toContain("alice");
    });

    it("removes entire emoji entry when count reaches 0", () => {
      const msg = makeMsg({ roomId: "!r1:s" });
      store.addMessage("!r1:s", msg);
      store.optimisticAddReaction("!r1:s", msg.id, "👍", "alice");
      store.optimisticRemoveReaction("!r1:s", msg.id, "👍", "alice");
      expect(store.messages["!r1:s"][0].reactions?.["👍"]).toBeUndefined();
    });

    it("does nothing for non-existent reaction", () => {
      const msg = makeMsg({ roomId: "!r1:s" });
      store.addMessage("!r1:s", msg);
      store.optimisticRemoveReaction("!r1:s", msg.id, "👍", "alice");
      // No crash
    });
  });

  // ─── setReactionEventId ───────────────────────────────────────

  describe("setReactionEventId", () => {
    it("replaces __optimistic__ with server ID", () => {
      const msg = makeMsg({ roomId: "!r1:s" });
      store.addMessage("!r1:s", msg);
      store.optimisticAddReaction("!r1:s", msg.id, "👍", "alice");
      store.setReactionEventId("!r1:s", msg.id, "👍", "$serverEvent123");
      expect(store.messages["!r1:s"][0].reactions?.["👍"].myEventId).toBe("$serverEvent123");
    });
  });

  // ─── addRoom / setActiveRoom ──────────────────────────────────

  describe("addRoom / setActiveRoom", () => {
    it("adds a new room", () => {
      store.addRoom(makeRoom({ id: "!r1:s" }));
      expect(store.rooms).toHaveLength(1);
    });

    it("replaces existing room with same id", () => {
      store.addRoom(makeRoom({ id: "!r1:s", name: "Old" }));
      store.addRoom(makeRoom({ id: "!r1:s", name: "New" }));
      expect(store.rooms).toHaveLength(1);
      expect(store.rooms[0].name).toBe("New");
    });

    it("setActiveRoom sets the active room id", () => {
      store.addRoom(makeRoom({ id: "!r1:s", unreadCount: 5 }));
      store.setActiveRoom("!r1:s");
      expect(store.activeRoomId).toBe("!r1:s");
      // Note: unreadCount is now cleared by IntersectionObserver, not setActiveRoom
      expect(store.rooms[0].unreadCount).toBe(5);
    });

    it("setActiveRoom(null) clears active room", () => {
      store.setActiveRoom("!r1:s");
      store.setActiveRoom(null);
      expect(store.activeRoomId).toBeNull();
    });
  });

  // ─── sortedRooms ──────────────────────────────────────────────

  describe("sortedRooms", () => {
    it("sorts pinned rooms first", () => {
      store.addRoom(makeRoom({ id: "!a:s", updatedAt: 100 }));
      store.addRoom(makeRoom({ id: "!b:s", updatedAt: 200 }));
      store.togglePinRoom("!a:s");
      const sorted = store.sortedRooms;
      expect(sorted[0].id).toBe("!a:s"); // pinned, despite older
    });

    it("returns a sorted copy (not the same reference as rooms)", () => {
      store.addRoom(makeRoom({ id: "!a:s" }));
      store.addRoom(makeRoom({ id: "!b:s" }));
      // Pin a room to force sortedRooms recompute
      store.togglePinRoom("!a:s");
      const sorted = store.sortedRooms;
      expect(sorted).toHaveLength(2);
      // sortedRooms is a new array, not the rooms ref itself
      expect(sorted).not.toBe(store.rooms);
    });
  });

  // ─── totalUnread ──────────────────────────────────────────────

  describe("totalUnread", () => {
    it("sums unreadCount across all rooms", () => {
      store.addRoom(makeRoom({ id: "!a:s", unreadCount: 3 }));
      store.addRoom(makeRoom({ id: "!b:s", unreadCount: 7 }));
      expect(store.totalUnread).toBe(10);
    });

    it("returns 0 when no rooms", () => {
      expect(store.totalUnread).toBe(0);
    });
  });

  // ─── selection mode ───────────────────────────────────────────

  describe("selection mode", () => {
    it("enters selection mode with initial message", () => {
      store.enterSelectionMode("msg1");
      expect(store.selectionMode).toBe(true);
      expect(store.selectedMessageIds.has("msg1")).toBe(true);
    });

    it("toggleSelection adds and removes message IDs", () => {
      store.enterSelectionMode("msg1");
      store.toggleSelection("msg2");
      expect(store.selectedMessageIds.has("msg2")).toBe(true);
      store.toggleSelection("msg2");
      expect(store.selectedMessageIds.has("msg2")).toBe(false);
    });

    it("exits selection mode and clears state", () => {
      store.enterSelectionMode("msg1");
      store.toggleSelection("msg2");
      store.exitSelectionMode();
      expect(store.selectionMode).toBe(false);
      expect(store.selectedMessageIds.size).toBe(0);
    });
  });

  // ─── togglePinRoom / toggleMuteRoom ───────────────────────────

  describe("togglePinRoom / toggleMuteRoom", () => {
    it("togglePinRoom pins and unpins", () => {
      store.togglePinRoom("!r1:s");
      expect(store.pinnedRoomIds.has("!r1:s")).toBe(true);
      store.togglePinRoom("!r1:s");
      expect(store.pinnedRoomIds.has("!r1:s")).toBe(false);
    });

    it("toggleMuteRoom mutes and unmutes", () => {
      store.toggleMuteRoom("!r1:s");
      expect(store.mutedRoomIds.has("!r1:s")).toBe(true);
      store.toggleMuteRoom("!r1:s");
      expect(store.mutedRoomIds.has("!r1:s")).toBe(false);
    });
  });

  // ─── typing indicators ───────────────────────────────────────

  describe("typing indicators", () => {
    it("setTypingUsers and getTypingUsers round-trip", () => {
      store.setTypingUsers("!r1:s", ["alice", "bob"]);
      expect(store.getTypingUsers("!r1:s")).toEqual(["alice", "bob"]);
    });

    it("getTypingUsers returns empty for unknown room", () => {
      expect(store.getTypingUsers("!unknown:s")).toEqual([]);
    });

    it("updates typing users for same room", () => {
      store.setTypingUsers("!r1:s", ["alice"]);
      store.setTypingUsers("!r1:s", ["bob"]);
      expect(store.getTypingUsers("!r1:s")).toEqual(["bob"]);
    });
  });

  // ─── getDisplayName ───────────────────────────────────────────

  describe("getDisplayName", () => {
    it("returns '?' for empty address", () => {
      expect(store.getDisplayName("")).toBe("?");
    });

    it("truncates long unknown addresses", () => {
      const longAddr = "P" + "a".repeat(33);
      const result = store.getDisplayName(longAddr);
      expect(result).toContain("\u2026");
      expect(result.length).toBeLessThan(longAddr.length);
    });

    it("returns short address as-is when ≤ 16 chars", () => {
      expect(store.getDisplayName("shortAddr")).toBe("shortAddr");
    });

    it("returns fallback format: first 8 + … + last 4", () => {
      const addr = "PPbNqCweFnTePQyXWR21B9jXWCiDJa2yYu";
      const result = store.getDisplayName(addr);
      expect(result).toBe("PPbNqCwe\u20262yYu");
    });
  });

  // ─── markRoomAsRead ───────────────────────────────────────────

  describe("markRoomAsRead", () => {
    it("resets unreadCount to 0", () => {
      store.addRoom(makeRoom({ id: "!r1:s", unreadCount: 10 }));
      store.markRoomAsRead("!r1:s");
      expect(store.rooms[0].unreadCount).toBe(0);
    });
  });

  // ─── handleReceiptEvent (cross-device read sync) ─────────────

  describe("handleReceiptEvent", () => {
    const MY_USER_ID = "@me:server";
    const OTHER_USER_ID = "@other:server";

    beforeEach(() => {
      // Override the mock to return the correct userId for receipt tests
      mockGetUserIdFn.mockReturnValue(MY_USER_ID);
    });

    it("clears in-memory unreadCount when receiving own read receipt from another device", () => {
      const roomId = "!r1:server";
      store.addRoom(makeRoom({ id: roomId }));
      store.setActiveRoom(roomId);
      const msg = makeMsg({ id: "$evt1", roomId, timestamp: 1000, senderId: "other" });
      store.addMessage(roomId, msg);
      store.rooms[0].unreadCount = 5;

      // Simulate receipt event from /sync with our own userId
      const receiptEvent = {
        getContent: () => ({
          "$evt1": {
            "m.read": {
              [MY_USER_ID]: { ts: 1000 },
            },
          },
        }),
      };

      store.handleReceiptEvent(receiptEvent, { roomId });

      // Own receipt should clear unreadCount (cross-device sync)
      expect(store.rooms[0].unreadCount).toBe(0);
    });

    it("does not clear unreadCount for receipts from other users", () => {
      const roomId = "!r1:server";
      store.addRoom(makeRoom({ id: roomId }));
      store.setActiveRoom(roomId);
      const msg = makeMsg({ id: "$evt1", roomId, timestamp: 1000, senderId: "me" });
      store.addMessage(roomId, msg);
      store.rooms[0].unreadCount = 5;

      const receiptEvent = {
        getContent: () => ({
          "$evt1": {
            "m.read": {
              [OTHER_USER_ID]: { ts: 1000 },
            },
          },
        }),
      };

      store.handleReceiptEvent(receiptEvent, { roomId });

      // Other user's receipt should NOT clear our unreadCount
      expect(store.rooms[0].unreadCount).toBe(5);
    });

    it("handles mixed own + other receipts in same event", () => {
      const roomId = "!r1:server";
      store.addRoom(makeRoom({ id: roomId }));
      // Set active room so addMessage doesn't increment unreadCount
      store.setActiveRoom(roomId);
      const msg = makeMsg({ id: "$evt1", roomId, timestamp: 2000, senderId: "someone" });
      store.addMessage(roomId, msg);
      // Set unread manually to simulate state before receipt
      store.rooms[0].unreadCount = 8;

      const receiptEvent = {
        getContent: () => ({
          "$evt1": {
            "m.read": {
              [OTHER_USER_ID]: { ts: 2000 },
              [MY_USER_ID]: { ts: 2000 },
            },
          },
        }),
      };

      store.handleReceiptEvent(receiptEvent, { roomId });

      // Own receipt in the mix should still clear unread
      expect(store.rooms[0].unreadCount).toBe(0);
    });

    it("ignores receipt events with no content", () => {
      store.addRoom(makeRoom({ id: "!r1:server", unreadCount: 3 }));

      store.handleReceiptEvent({ getContent: () => null }, { roomId: "!r1:server" });

      expect(store.rooms[0].unreadCount).toBe(3);
    });

    it("falls back to receipt ts when message not found in memory", () => {
      const roomId = "!r1:server";
      store.addRoom(makeRoom({ id: roomId, unreadCount: 4 }));
      // Note: NOT adding message to store — simulates messages not loaded yet

      const receiptEvent = {
        getContent: () => ({
          "$unknown_evt": {
            "m.read": {
              [MY_USER_ID]: { ts: 5000 },
            },
          },
        }),
      };

      store.handleReceiptEvent(receiptEvent, { roomId });

      // Should still clear unread even without message in memory
      expect(store.rooms[0].unreadCount).toBe(0);
    });
  });
});
