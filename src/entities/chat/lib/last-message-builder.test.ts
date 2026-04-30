import { describe, it, expect } from "vitest";
import type { LocalRoom } from "@/shared/lib/local-db";
import {
  buildLastMessage,
  lastMessageFromMessage,
  resolveLastMessagePreview,
} from "./last-message-builder";
import { MessageStatus, MessageType } from "../model/types";

function makeLocalRoom(overrides: Partial<LocalRoom> = {}): LocalRoom {
  return {
    id: "!r:s",
    name: "Room",
    avatar: undefined,
    isGroup: false,
    members: [],
    membership: "join",
    unreadCount: 0,
    lastReadInboundTs: 0,
    lastReadOutboundTs: 0,
    updatedAt: 0,
    isDeleted: false,
    deletedAt: null,
    deleteReason: null,
    syncedAt: 0,
    hasMoreHistory: true,
    ...overrides,
  } as LocalRoom;
}

describe("resolveLastMessagePreview", () => {
  it("returns rawPreview when not encrypted", () => {
    expect(resolveLastMessagePreview("hello")).toBe("hello");
  });

  it("returns decrypted preview when raw is [encrypted]", () => {
    expect(resolveLastMessagePreview("[encrypted]", "hello")).toBe("hello");
  });

  it("returns decrypted preview when raw is m.bad.encrypted", () => {
    expect(resolveLastMessagePreview("m.bad.encrypted", "decoded")).toBe("decoded");
  });

  it("returns decrypted preview for ** Unable to decrypt prefix", () => {
    expect(resolveLastMessagePreview("** Unable to decrypt: ...", "yo")).toBe("yo");
  });

  it("falls back to raw [encrypted] when no decrypted cache", () => {
    expect(resolveLastMessagePreview("[encrypted]")).toBe("[encrypted]");
  });

  it("returns undefined when raw is undefined", () => {
    expect(resolveLastMessagePreview(undefined)).toBeUndefined();
  });
});

describe("buildLastMessage", () => {
  it("returns undefined when lastMessagePreview is missing", () => {
    expect(buildLastMessage(makeLocalRoom())).toBeUndefined();
  });

  it("status='sending' when lastMessageLocalStatus='pending'", () => {
    const lr = makeLocalRoom({
      lastMessagePreview: "hi",
      lastMessageLocalStatus: "pending",
      lastMessageTimestamp: 1000,
    });
    expect(buildLastMessage(lr)?.status).toBe(MessageStatus.sending);
  });

  it("status='sending' when lastMessageLocalStatus='syncing'", () => {
    const lr = makeLocalRoom({
      lastMessagePreview: "hi",
      lastMessageLocalStatus: "syncing",
      lastMessageTimestamp: 1000,
    });
    expect(buildLastMessage(lr)?.status).toBe(MessageStatus.sending);
  });

  it("status='sent' when lastMessageLocalStatus='synced' and watermark < timestamp", () => {
    const lr = makeLocalRoom({
      lastMessagePreview: "hi",
      lastMessageLocalStatus: "synced",
      lastMessageTimestamp: 2000,
      lastReadOutboundTs: 1000,
    });
    expect(buildLastMessage(lr)?.status).toBe(MessageStatus.sent);
  });

  it("status='read' when lastMessageLocalStatus='synced' and watermark >= timestamp", () => {
    const lr = makeLocalRoom({
      lastMessagePreview: "hi",
      lastMessageLocalStatus: "synced",
      lastMessageTimestamp: 1000,
      lastReadOutboundTs: 1000,
    });
    expect(buildLastMessage(lr)?.status).toBe(MessageStatus.read);
  });

  it("status='failed' when lastMessageLocalStatus='failed'", () => {
    const lr = makeLocalRoom({
      lastMessagePreview: "hi",
      lastMessageLocalStatus: "failed",
      lastMessageTimestamp: 1000,
    });
    expect(buildLastMessage(lr)?.status).toBe(MessageStatus.failed);
  });

  it("status='cancelled' when lastMessageLocalStatus='cancelled'", () => {
    const lr = makeLocalRoom({
      lastMessagePreview: "hi",
      lastMessageLocalStatus: "cancelled",
      lastMessageTimestamp: 1000,
    });
    expect(buildLastMessage(lr)?.status).toBe(MessageStatus.cancelled);
  });

  it("falls back to status='sent' when lastMessageLocalStatus is undefined", () => {
    const lr = makeLocalRoom({
      lastMessagePreview: "hi",
      lastMessageTimestamp: 1000,
    });
    expect(buildLastMessage(lr)?.status).toBe(MessageStatus.sent);
  });

  it("uses decrypted preview override when raw is [encrypted]", () => {
    const lr = makeLocalRoom({
      lastMessagePreview: "[encrypted]",
      lastMessageLocalStatus: "synced",
      lastMessageTimestamp: 1000,
    });
    expect(buildLastMessage(lr, "decoded")?.content).toBe("decoded");
  });

  it("preserves all metadata fields (type, callInfo, systemMeta, decryptionStatus)", () => {
    const lr = makeLocalRoom({
      lastMessagePreview: "[voice message]",
      lastMessageLocalStatus: "synced",
      lastMessageTimestamp: 1000,
      lastMessageType: MessageType.audio,
      lastMessageDecryptionStatus: "pending",
      lastMessageCallInfo: { callType: "voice", missed: false, duration: 30 },
      lastMessageSystemMeta: { template: "system.voiceCall", senderAddr: "addr" },
      lastMessageEventId: "$event:s",
      lastMessageSenderId: "@me:s",
    });
    const msg = buildLastMessage(lr)!;
    expect(msg.id).toBe("$event:s");
    expect(msg.senderId).toBe("@me:s");
    expect(msg.type).toBe(MessageType.audio);
    expect(msg.decryptionStatus).toBe("pending");
    expect(msg.callInfo).toEqual({ callType: "voice", missed: false, duration: 30 });
    expect(msg.systemMeta).toEqual({ template: "system.voiceCall", senderAddr: "addr" });
  });
});

describe("lastMessageFromMessage", () => {
  const baseMessage = {
    id: "$ev:s",
    roomId: "!r:s",
    senderId: "@me:s",
    content: "hi",
    timestamp: 1000,
    status: MessageStatus.sent,
    type: MessageType.text,
  } as const;

  it("returns message unchanged when LocalRoom missing", () => {
    expect(lastMessageFromMessage(baseMessage)).toBe(baseMessage);
  });

  it("downgrades status to 'sending' when Dexie says pending", () => {
    const lr = makeLocalRoom({ lastMessageLocalStatus: "pending", lastMessageTimestamp: 1000 });
    const result = lastMessageFromMessage(baseMessage, lr);
    expect(result.status).toBe(MessageStatus.sending);
    expect(result).not.toBe(baseMessage); // new object
  });

  it("upgrades status to 'read' when Dexie watermark >= ts", () => {
    const lr = makeLocalRoom({
      lastMessageLocalStatus: "synced",
      lastMessageTimestamp: 1000,
      lastReadOutboundTs: 1500,
    });
    const result = lastMessageFromMessage(baseMessage, lr);
    expect(result.status).toBe(MessageStatus.read);
  });

  it("returns same object when status doesn't change (perf)", () => {
    const lr = makeLocalRoom({
      lastMessageLocalStatus: "synced",
      lastMessageTimestamp: 1000,
      lastReadOutboundTs: 0,
    });
    const result = lastMessageFromMessage(baseMessage, lr);
    expect(result).toBe(baseMessage); // same reference, no allocation
  });

  it("propagates 'failed' status from Dexie", () => {
    const lr = makeLocalRoom({ lastMessageLocalStatus: "failed", lastMessageTimestamp: 1000 });
    expect(lastMessageFromMessage(baseMessage, lr).status).toBe(MessageStatus.failed);
  });

  it("uses message.timestamp when Dexie has no lastMessageTimestamp", () => {
    const lr = makeLocalRoom({
      lastMessageLocalStatus: "synced",
      lastReadOutboundTs: 1500,
    });
    // baseMessage.timestamp = 1000, watermark 1500 > ts → read
    expect(lastMessageFromMessage(baseMessage, lr).status).toBe(MessageStatus.read);
  });
});
