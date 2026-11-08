import { describe, it, expect } from "vitest";
import { deriveOutboundStatus, localToMessage, localStatusToMessageStatus } from "./mappers";
import { MessageStatus, MessageType } from "@/entities/chat/model/types";
import type { LocalMessage } from "./schema";

describe("deriveOutboundStatus", () => {
  it("returns sending for pending status regardless of watermark", () => {
    expect(deriveOutboundStatus("pending", 1000, 2000)).toBe(MessageStatus.sending);
  });

  it("returns sending for syncing status regardless of watermark", () => {
    expect(deriveOutboundStatus("syncing", 1000, 2000)).toBe(MessageStatus.sending);
  });

  it("returns failed for failed status regardless of watermark", () => {
    expect(deriveOutboundStatus("failed", 1000, 2000)).toBe(MessageStatus.failed);
  });

  it("returns cancelled for cancelled status", () => {
    expect(deriveOutboundStatus("cancelled", 1000, 2000)).toBe(MessageStatus.cancelled);
  });

  it("returns read when watermark >= message timestamp", () => {
    expect(deriveOutboundStatus("synced", 1000, 1000)).toBe(MessageStatus.read);
    expect(deriveOutboundStatus("synced", 1000, 2000)).toBe(MessageStatus.read);
  });

  it("returns sent when watermark < message timestamp", () => {
    expect(deriveOutboundStatus("synced", 2000, 1000)).toBe(MessageStatus.sent);
  });

  it("transitions from sent to read as watermark advances", () => {
    const msgTs = 5000;
    expect(deriveOutboundStatus("synced", msgTs, 0)).toBe(MessageStatus.sent);
    expect(deriveOutboundStatus("synced", msgTs, 4999)).toBe(MessageStatus.sent);
    expect(deriveOutboundStatus("synced", msgTs, 5000)).toBe(MessageStatus.read);
    expect(deriveOutboundStatus("synced", msgTs, 9999)).toBe(MessageStatus.read);
  });
});

describe("localStatusToMessageStatus", () => {
  it("maps cancelled to cancelled", () => {
    expect(localStatusToMessageStatus("cancelled")).toBe(MessageStatus.cancelled);
  });
});

describe("localToMessage status derivation", () => {
  const baseLocal: LocalMessage = {
    clientId: "c1",
    eventId: "$ev1",
    roomId: "!r:s",
    senderId: "alice",
    content: "hello",
    timestamp: 1000,
    status: "synced",
    type: MessageType.text,
    deleted: false,
    version: 1,
    softDeleted: false,
  };

  it("derives read status for own message when watermark >= timestamp", () => {
    const msg = localToMessage(baseLocal, 1500, "alice");
    expect(msg.status).toBe(MessageStatus.read);
  });

  it("derives sent status for own message when watermark < timestamp", () => {
    const msg = localToMessage(baseLocal, 500, "alice");
    expect(msg.status).toBe(MessageStatus.sent);
  });

  it("uses localStatus for other user messages (ignores watermark)", () => {
    const msg = localToMessage(baseLocal, 1500, "bob");
    expect(msg.status).toBe(MessageStatus.sent); // "synced" → sent
  });

  it("uses localStatus when no watermark provided", () => {
    const msg = localToMessage(baseLocal, undefined, "alice");
    expect(msg.status).toBe(MessageStatus.sent); // "synced" → sent
  });

  it("exposes sendError only while the message is failed", () => {
    const failed = localToMessage({ ...baseLocal, status: "failed", sendError: "M_FORBIDDEN" });
    expect(failed.sendError).toBe("M_FORBIDDEN");
    const synced = localToMessage({ ...baseLocal, sendError: "stale" });
    expect(synced.sendError).toBeUndefined();
  });
});
