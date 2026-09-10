import { describe, it, expect } from "vitest";
import { toParsedMessages } from "./parsed-message";
import { MessageStatus, MessageType, type Message } from "@/entities/chat/model/types";

function msg(overrides: Partial<Message> = {}): Message {
  return {
    id: "$e1",
    roomId: "!r:s",
    senderId: "peer",
    content: "hello",
    timestamp: 1000,
    status: MessageStatus.sent,
    type: MessageType.text,
    ...overrides,
  };
}

describe("toParsedMessages", () => {
  const raw = { event_id: "$e1", type: "m.room.message", content: { msgtype: "m.encrypted" } };

  // Regression (audit A2): the three bulk write paths dropped encryptedRaw,
  // so scrollback history was persisted as unrecoverable "[encrypted]".
  it("attaches the raw event to undecrypted messages", () => {
    const [p] = toParsedMessages([msg({ content: "[encrypted]" })], new Map([["$e1", raw]]));
    expect(p.encryptedRaw).toBe(raw);
  });

  it("does not attach the raw event to decrypted messages", () => {
    const [p] = toParsedMessages([msg()], new Map([["$e1", raw]]));
    expect(p.encryptedRaw).toBeUndefined();
  });

  it("skips optimistic temp messages and keeps callLinkInfo", () => {
    const callLinkInfo = { url: "https://call", label: "t" } as unknown as NonNullable<Message["callLinkInfo"]>;
    const out = toParsedMessages(
      [msg({ id: "msg_tmp" }), msg({ id: "$e2", callLinkInfo })],
      new Map(),
    );
    expect(out.map((p) => p.eventId)).toEqual(["$e2"]);
    expect(out[0].callLinkInfo).toBe(callLinkInfo);
  });
});
