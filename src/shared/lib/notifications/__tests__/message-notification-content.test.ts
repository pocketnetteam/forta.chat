import { describe, it, expect } from "vitest";
import { buildMessageNotificationContent } from "../message-notification-content";

const base = {
  body: "see you at 10",
  fallbackTitle: "Forta Chat",
};

describe("buildMessageNotificationContent", () => {
  it("puts the group name in the title and the sender in the body", () => {
    expect(
      buildMessageNotificationContent({
        ...base,
        senderName: "Alice",
        roomName: "Forta Team",
        isGroup: true,
      }),
    ).toEqual({ title: "Forta Team", body: "Alice: see you at 10" });
  });

  it("leaves direct chats as sender-titled with a bare body", () => {
    expect(
      buildMessageNotificationContent({
        ...base,
        senderName: "Alice",
        roomName: "Alice",
        isGroup: false,
      }),
    ).toEqual({ title: "Alice", body: "see you at 10" });
  });

  it("falls back to the direct-chat layout when a group has no known name", () => {
    expect(
      buildMessageNotificationContent({
        ...base,
        senderName: "Alice",
        roomName: "   ",
        isGroup: true,
      }),
    ).toEqual({ title: "Alice", body: "see you at 10" });
  });

  it("keeps the group title when the sender is unknown", () => {
    expect(
      buildMessageNotificationContent({
        ...base,
        senderName: null,
        roomName: "Forta Team",
        isGroup: true,
      }),
    ).toEqual({ title: "Forta Team", body: "see you at 10" });
  });

  it("never prefixes the body with a raw Matrix ID", () => {
    // The push pipeline falls back to the bare sender id when member state
    // has not loaded yet (WEE-11 / forta-bugs#660).
    expect(
      buildMessageNotificationContent({
        ...base,
        senderName: "@PXXX123:matrix.bastyon.com",
        roomName: "Forta Team",
        isGroup: true,
      }),
    ).toEqual({ title: "Forta Team", body: "see you at 10" });
  });

  it("never titles a direct chat with a raw Matrix ID", () => {
    expect(
      buildMessageNotificationContent({
        ...base,
        senderName: "@PXXX123:matrix.bastyon.com",
        roomName: "Alice",
        isGroup: false,
      }),
    ).toEqual({ title: "Alice", body: "see you at 10" });
  });

  it("prefers the room name in a direct chat when the caller asks for it", () => {
    // Web/Electron: `room.name` is resolved from the chat list, while the
    // sender chain can still be showing a truncated address.
    expect(
      buildMessageNotificationContent({
        ...base,
        senderName: "Pk3Xy...9f2a",
        roomName: "Alice",
        isGroup: false,
        directTitlePrefers: "room",
      }),
    ).toEqual({ title: "Alice", body: "see you at 10" });
  });

  it("still falls back to the sender when the room name is missing", () => {
    expect(
      buildMessageNotificationContent({
        ...base,
        senderName: "Alice",
        roomName: null,
        isGroup: false,
        directTitlePrefers: "room",
      }),
    ).toEqual({ title: "Alice", body: "see you at 10" });
  });

  it("uses the room name when only it is known", () => {
    expect(
      buildMessageNotificationContent({
        ...base,
        senderName: "",
        roomName: "Alice",
        isGroup: false,
      }),
    ).toEqual({ title: "Alice", body: "see you at 10" });
  });

  it("falls back to the app name when nothing is known", () => {
    expect(
      buildMessageNotificationContent({
        ...base,
        senderName: undefined,
        roomName: undefined,
        isGroup: true,
      }),
    ).toEqual({ title: "Forta Chat", body: "see you at 10" });
  });
});
