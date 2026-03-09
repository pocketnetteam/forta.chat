import { describe, it, expect, beforeEach } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
import { useChatStore } from "./chat-store";
import { makeMsg, makeRoom } from "@/test-utils";
import { MessageStatus, MessageType } from "./types";

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

    it("setActiveRoom resets unreadCount", () => {
      store.addRoom(makeRoom({ id: "!r1:s", unreadCount: 5 }));
      store.setActiveRoom("!r1:s");
      expect(store.rooms[0].unreadCount).toBe(0);
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

    it("sorts by updatedAt desc within same pin status", () => {
      store.addRoom(makeRoom({ id: "!a:s", updatedAt: 100 }));
      store.addRoom(makeRoom({ id: "!b:s", updatedAt: 200 }));
      store.addRoom(makeRoom({ id: "!c:s", updatedAt: 150 }));
      const sorted = store.sortedRooms;
      expect(sorted[0].id).toBe("!b:s");
      expect(sorted[1].id).toBe("!c:s");
      expect(sorted[2].id).toBe("!a:s");
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
});
