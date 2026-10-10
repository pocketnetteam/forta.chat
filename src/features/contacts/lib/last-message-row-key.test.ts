// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import type { ChatRoom, Message } from "@/entities/chat";
import { MessageType, MessageStatus } from "@/entities/chat";
import { lastMessageRowKey } from "./last-message-row-key";

function room(lastMessage: Partial<Message>, extra: Partial<ChatRoom> = {}): ChatRoom {
  return {
    id: "!r:s",
    name: "Peer",
    unreadCount: 0,
    members: [],
    isGroup: false,
    updatedAt: 1000,
    lastMessage: {
      id: "$e",
      roomId: "!r:s",
      senderId: "peer",
      content: "[message]",
      timestamp: 1000,
      status: MessageStatus.sent,
      type: MessageType.system,
      ...lastMessage,
    } as Message,
    ...extra,
  };
}

describe("lastMessageRowKey", () => {
  it("is the same for two rooms whose rows show the same thing", () => {
    const call = { callType: "voice" as const, missed: false };
    expect(lastMessageRowKey(room({ callInfo: call }))).toBe(lastMessageRowKey(room({ callInfo: { ...call } })));
  });

  it("changes when a reaction lands on the last message", () => {
    const before = room({ type: MessageType.text, content: "hi" });
    const after = room({ type: MessageType.text, content: "hi" }, {
      lastMessageReaction: { emoji: "👍", senderAddress: "peer", timestamp: 2000 },
    });
    expect(lastMessageRowKey(after)).not.toBe(lastMessageRowKey(before));
  });

  it("changes when the reaction is replaced", () => {
    const like = room({}, { lastMessageReaction: { emoji: "👍", senderAddress: "peer", timestamp: 2000 } });
    const heart = room({}, { lastMessageReaction: { emoji: "❤️", senderAddress: "peer", timestamp: 3000 } });
    expect(lastMessageRowKey(heart)).not.toBe(lastMessageRowKey(like));
  });

  it("changes when the same hangup turns missed", () => {
    const answered = room({ callInfo: { callType: "voice", missed: false }, systemMeta: { template: "system.voiceCall", senderAddr: "peer" } });
    const missed = room({ callInfo: { callType: "voice", missed: true }, systemMeta: { template: "system.missedVoiceCall", senderAddr: "peer" } });
    expect(lastMessageRowKey(missed)).not.toBe(lastMessageRowKey(answered));
  });

  it("changes when the message is deleted in place", () => {
    const text = room({ type: MessageType.text, content: "hi" });
    const deleted = room({ type: MessageType.text, content: "hi", deleted: true });
    expect(lastMessageRowKey(deleted)).not.toBe(lastMessageRowKey(text));
  });

  it("handles a room with no last message", () => {
    const empty = { ...room({}), lastMessage: undefined };
    expect(typeof lastMessageRowKey(empty)).toBe("string");
  });
});
