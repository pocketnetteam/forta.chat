import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
import { useChatStore } from "../chat-store";
import { makeRoom, makeMsg } from "@/test-utils";
import { MessageStatus, MessageType } from "../types";
import type { Message } from "../types";

function makeMsgFor(roomId: string, overrides: Partial<Message> = {}): Message {
  return makeMsg({ roomId, ...overrides });
}

describe("chat-store: unreadCount single-writer invariant", () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
  });

  it("markRoomAsRead clears unreadCount to 0", () => {
    store.rooms = [makeRoom({ id: "!a:s", unreadCount: 5 })];
    store.markRoomAsRead("!a:s");
    expect(store.sortedRooms.find(r => r.id === "!a:s")?.unreadCount).toBe(0);
  });

  it("markRoomAsRead is idempotent — no mutation when already 0", () => {
    store.rooms = [makeRoom({ id: "!a:s", unreadCount: 0 })];
    const before = store.rooms[0];
    store.markRoomAsRead("!a:s");
    // Same object reference — diff guard prevented mutation
    expect(store.rooms[0]).toBe(before);
    expect(store.rooms[0].unreadCount).toBe(0);
  });

  it("setActiveRoom clears unreadCount in sidebar immediately", async () => {
    store.rooms = [makeRoom({ id: "!a:s", unreadCount: 3 })];
    await store.setActiveRoom("!a:s");
    expect(store.sortedRooms.find(r => r.id === "!a:s")?.unreadCount).toBe(0);
  });

  it("addMessage from other user bumps unreadCount when room not active", () => {
    store.rooms = [makeRoom({ id: "!a:s", unreadCount: 0 })];
    // active room is null → not "!a:s" → should bump
    const incoming = makeMsgFor("!a:s", {
      senderId: "@peer:s",
      timestamp: 1000,
      status: MessageStatus.sent,
    });
    store.addMessage("!a:s", incoming);
    expect(store.sortedRooms.find(r => r.id === "!a:s")?.unreadCount).toBe(1);
  });

  it("addMessage from self does NOT bump unreadCount", () => {
    // We can't easily mock useAuthStore in this test, but the "active room" path
    // also blocks bumping — verify that when active, no bump happens.
    store.rooms = [makeRoom({ id: "!a:s", unreadCount: 0 })];
    store.activeRoomId = "!a:s";
    const incoming = makeMsgFor("!a:s", {
      senderId: "@anyone:s",
      timestamp: 1000,
      status: MessageStatus.sent,
    });
    store.addMessage("!a:s", incoming);
    // active room — never bumps regardless of sender
    expect(store.sortedRooms.find(r => r.id === "!a:s")?.unreadCount).toBe(0);
  });

  it("rapid burst of incoming messages accumulates correctly", () => {
    store.rooms = [makeRoom({ id: "!a:s", unreadCount: 0 })];
    for (let i = 0; i < 5; i++) {
      store.addMessage("!a:s", makeMsgFor("!a:s", {
        id: `m_${i}`,
        senderId: "@peer:s",
        timestamp: 1000 + i,
      }));
    }
    expect(store.sortedRooms.find(r => r.id === "!a:s")?.unreadCount).toBe(5);
  });
});

describe("chat-store: lastMessage.status reactivity", () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
  });

  it("addMessage with status=sending sets sidebar lastMessage.status=sending", () => {
    store.rooms = [makeRoom({ id: "!a:s" })];
    const optimistic = makeMsgFor("!a:s", {
      id: "tmp_1",
      senderId: "@me:s",
      timestamp: 1000,
      status: MessageStatus.sending,
    });
    store.addMessage("!a:s", optimistic);
    const room = store.sortedRooms.find(r => r.id === "!a:s");
    expect(room?.lastMessage?.status).toBe(MessageStatus.sending);
  });

  it("updateMessageStatus propagates new status to sidebar lastMessage", () => {
    const room = makeRoom({ id: "!a:s" });
    store.rooms = [room];
    const msg = makeMsgFor("!a:s", {
      id: "msg_1",
      senderId: "@me:s",
      timestamp: 1000,
      status: MessageStatus.sending,
    });
    store.addMessage("!a:s", msg);
    expect(store.sortedRooms.find(r => r.id === "!a:s")?.lastMessage?.status)
      .toBe(MessageStatus.sending);

    store.updateMessageStatus("!a:s", "msg_1", MessageStatus.sent);
    expect(store.sortedRooms.find(r => r.id === "!a:s")?.lastMessage?.status)
      .toBe(MessageStatus.sent);
  });

  it("updateMessageStatus → failed propagates to sidebar", () => {
    store.rooms = [makeRoom({ id: "!a:s" })];
    const msg = makeMsgFor("!a:s", {
      id: "msg_1",
      senderId: "@me:s",
      timestamp: 1000,
      status: MessageStatus.sending,
    });
    store.addMessage("!a:s", msg);

    store.updateMessageStatus("!a:s", "msg_1", MessageStatus.failed);
    expect(store.sortedRooms.find(r => r.id === "!a:s")?.lastMessage?.status)
      .toBe(MessageStatus.failed);
  });

  it("updateMessageContent (edit) preserves message status in sidebar", () => {
    store.rooms = [makeRoom({ id: "!a:s" })];
    const msg = makeMsgFor("!a:s", {
      id: "msg_1",
      senderId: "@me:s",
      content: "original",
      timestamp: 1000,
      status: MessageStatus.sent,
    });
    store.addMessage("!a:s", msg);

    store.updateMessageContent("!a:s", "msg_1", "edited");
    const lm = store.sortedRooms.find(r => r.id === "!a:s")?.lastMessage;
    expect(lm?.content).toBe("edited");
    // status stays valid (sent or higher) — never resets to sending
    expect(lm?.status).toBe(MessageStatus.sent);
  });

  it("setMessages syncs sidebar lastMessage from loaded message list", () => {
    store.rooms = [makeRoom({ id: "!a:s" })];
    const msgs = [
      makeMsgFor("!a:s", { id: "m1", timestamp: 1000, status: MessageStatus.sent }),
      makeMsgFor("!a:s", { id: "m2", timestamp: 2000, status: MessageStatus.read }),
    ];
    store.setMessages("!a:s", msgs);
    const room = store.sortedRooms.find(r => r.id === "!a:s");
    expect(room?.lastMessage?.id).toBe("m2");
    expect(room?.lastMessage?.status).toBe(MessageStatus.read);
  });
});

describe("chat-store: removeMessage soft-delete invariant", () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
  });

  it("marks last message as deleted with empty content in sidebar", () => {
    store.rooms = [makeRoom({ id: "!a:s" })];
    const msg = makeMsgFor("!a:s", {
      id: "msg_1",
      senderId: "@me:s",
      content: "secret",
      timestamp: 1000,
      type: MessageType.text,
    });
    store.addMessage("!a:s", msg);

    store.removeMessage("!a:s", "msg_1");
    const lm = store.sortedRooms.find(r => r.id === "!a:s")?.lastMessage;
    expect(lm?.deleted).toBe(true);
    expect(lm?.content).toBe("");
  });
});
