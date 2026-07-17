import { describe, it, expect } from "vitest";
import { isMessageFailedForRetry } from "./message-failed-state";
import { MessageStatus, MessageType } from "@/entities/chat/model/types";
import type { Message } from "@/entities/chat/model/types";

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "client_123",
    _key: "client_123",
    roomId: "!room:server",
    senderId: "@alice:server",
    content: "hello",
    timestamp: 0,
    status: MessageStatus.failed,
    type: MessageType.text,
    ...overrides,
  };
}

describe("isMessageFailedForRetry", () => {
  it("flags a never-delivered failed message (id still equals clientId)", () => {
    const msg = makeMessage({ id: "cli_1", _key: "cli_1", status: MessageStatus.failed });
    expect(isMessageFailedForRetry(msg)).toBe(true);
  });

  it("hides retry for a confirmed message whose id flipped to eventId (WEE-40)", () => {
    // localToMessage sets id = eventId once confirmSent runs. If the queue
    // later runs markMessageFailed because the SDK threw on the read side
    // after the server accepted the event, this guard keeps the UI silent
    // instead of slapping a red retry icon on a delivered bubble.
    const msg = makeMessage({
      id: "$server_event_id",
      _key: "cli_1",
      status: MessageStatus.failed,
    });
    expect(isMessageFailedForRetry(msg)).toBe(false);
  });

  it("returns false for non-failed statuses regardless of id/_key", () => {
    expect(isMessageFailedForRetry(makeMessage({ status: MessageStatus.sent }))).toBe(false);
    expect(isMessageFailedForRetry(makeMessage({ status: MessageStatus.sending }))).toBe(false);
    expect(isMessageFailedForRetry(makeMessage({ status: MessageStatus.read }))).toBe(false);
  });

  it("falls back to status-only when _key is missing", () => {
    const failed: Pick<Message, "status" | "id"> & { _key?: undefined } = {
      id: "anything",
      status: MessageStatus.failed,
      _key: undefined,
    };
    expect(isMessageFailedForRetry(failed)).toBe(true);

    const ok: Pick<Message, "status" | "id"> & { _key?: undefined } = {
      id: "anything",
      status: MessageStatus.sent,
      _key: undefined,
    };
    expect(isMessageFailedForRetry(ok)).toBe(false);
  });
});
