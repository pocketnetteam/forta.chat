import { describe, it, expect } from "vitest";
import {
  getRoomTitleForUI,
  getUserDisplayNameForUI,
  getMessagePreviewForUI,
} from "./display-result";

describe("getRoomTitleForUI", () => {
  it("returns ready for human-readable name", () => {
    const result = getRoomTitleForUI("My Chat Room", { gaveUp: false, roomId: "!abcd:server" });
    expect(result).toEqual({ state: "ready", text: "My Chat Room" });
  });

  it("returns resolving for hex hash when not gave up", () => {
    const result = getRoomTitleForUI("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4", { gaveUp: false, roomId: "!abcd:server" });
    expect(result).toEqual({ state: "resolving", text: "" });
  });

  it("returns failed with fallback prefix when gave up", () => {
    const result = getRoomTitleForUI("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4", { gaveUp: true, roomId: "!WXYZ:server", fallbackPrefix: "Chat" });
    expect(result).toEqual({ state: "failed", text: "Chat #WXYZ" });
  });

  it("uses default 'Chat' prefix when fallbackPrefix not provided", () => {
    const result = getRoomTitleForUI("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4", { gaveUp: true, roomId: "!WXYZ:server" });
    expect(result).toEqual({ state: "failed", text: "Chat #WXYZ" });
  });

  it("returns ready for names starting with @", () => {
    const result = getRoomTitleForUI("@alice", { gaveUp: false, roomId: "!abcd:server" });
    expect(result).toEqual({ state: "ready", text: "@alice" });
  });

  it("returns resolving for truncated hex (a1b2c3d4\u2026)", () => {
    const result = getRoomTitleForUI("a1b2c3d4\u2026", { gaveUp: false, roomId: "!abcd:server" });
    expect(result).toEqual({ state: "resolving", text: "" });
  });

  it("returns failed for truncated hex when gave up", () => {
    const result = getRoomTitleForUI("a1b2c3d4\u2026", { gaveUp: true, roomId: "!RSTU:server", fallbackPrefix: "Chat" });
    expect(result).toEqual({ state: "failed", text: "Chat #RSTU" });
  });

  it("returns resolving for Matrix room IDs (!abc:server)", () => {
    const result = getRoomTitleForUI("!abc123:matrix.org", { gaveUp: false, roomId: "!abc123:matrix.org" });
    expect(result).toEqual({ state: "resolving", text: "" });
  });

  it("returns resolving for raw Bastyon address (20+ alphanum chars)", () => {
    const result = getRoomTitleForUI("PPbNqCweRt12345AbCdE", { gaveUp: false, roomId: "!abcd:server" });
    expect(result).toEqual({ state: "resolving", text: "" });
  });

  it("returns resolving for hex-encoded room alias (#hex)", () => {
    const result = getRoomTitleForUI("#312313abcdef", { gaveUp: false, roomId: "!abcd:server" });
    expect(result).toEqual({ state: "resolving", text: "" });
  });

  it("returns resolving for hex-encoded room alias with server (#hex:server)", () => {
    const result = getRoomTitleForUI("#726f6f6d31:matrix.org", { gaveUp: false, roomId: "!abcd:server" });
    expect(result).toEqual({ state: "resolving", text: "" });
  });
});

describe("getUserDisplayNameForUI", () => {
  it("returns ready for proper name", () => {
    const result = getUserDisplayNameForUI("Alice", "Unknown User");
    expect(result).toEqual({ state: "ready", text: "Alice" });
  });

  it("returns failed for truncated hex", () => {
    const result = getUserDisplayNameForUI("a1b2c3d4\u2026", "Unknown User");
    expect(result).toEqual({ state: "failed", text: "Unknown User" });
  });

  it("returns failed for long hex string", () => {
    const result = getUserDisplayNameForUI("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4", "Unknown User");
    expect(result).toEqual({ state: "failed", text: "Unknown User" });
  });

  it("returns ready for short name", () => {
    const result = getUserDisplayNameForUI("Bo", "Unknown User");
    expect(result).toEqual({ state: "ready", text: "Bo" });
  });

  it("returns failed for empty string", () => {
    const result = getUserDisplayNameForUI("", "Unknown User");
    expect(result).toEqual({ state: "failed", text: "Unknown User" });
  });

  it("returns failed for single char", () => {
    const result = getUserDisplayNameForUI("A", "Unknown User");
    expect(result).toEqual({ state: "failed", text: "Unknown User" });
  });
});

describe("getMessagePreviewForUI", () => {
  it("returns ready for normal text", () => {
    const result = getMessagePreviewForUI("Hello world", undefined, "Cannot decrypt");
    expect(result).toEqual({ state: "ready", text: "Hello world" });
  });

  it("returns resolving for [encrypted] with pending status", () => {
    const result = getMessagePreviewForUI("[encrypted]", "pending", "Cannot decrypt");
    expect(result).toEqual({ state: "resolving", text: "" });
  });

  it("returns resolving for [encrypted] with no status (undefined)", () => {
    const result = getMessagePreviewForUI("[encrypted]", undefined, "Cannot decrypt");
    expect(result).toEqual({ state: "resolving", text: "" });
  });

  it("returns failed for [encrypted] with failed status", () => {
    const result = getMessagePreviewForUI("[encrypted]", "failed", "Cannot decrypt");
    expect(result).toEqual({ state: "failed", text: "Cannot decrypt" });
  });

  it("returns failed for m.bad.encrypted with failed status", () => {
    const result = getMessagePreviewForUI("m.bad.encrypted", "failed", "Cannot decrypt");
    expect(result).toEqual({ state: "failed", text: "Cannot decrypt" });
  });

  it('returns resolving for "** Unable to decrypt **" with pending', () => {
    const result = getMessagePreviewForUI("** Unable to decrypt **", "pending", "Cannot decrypt");
    expect(result).toEqual({ state: "resolving", text: "" });
  });

  it("returns ready for empty content (returns empty string)", () => {
    const result = getMessagePreviewForUI("", undefined, "Cannot decrypt");
    expect(result).toEqual({ state: "ready", text: "" });
  });

  it("returns ready for null content (returns empty string)", () => {
    const result = getMessagePreviewForUI(null, undefined, "Cannot decrypt");
    expect(result).toEqual({ state: "ready", text: "" });
  });

  // WEE-39 regression — decrypted content carrying an @mention must pass
  // through the preview pipeline byte-identical. A future "strip mentions"
  // backward-compat patch must not silently drop or rewrite @user tokens
  // because the contacts list relies on the original sender wording.
  it("preserves @mention text in decrypted preview (WEE-39)", () => {
    const text = "Привет @AlexD как дела?";
    const result = getMessagePreviewForUI(text, "ok", "Cannot decrypt");
    expect(result).toEqual({ state: "ready", text });
  });

  // WEE-39 regression — the function MUST return the caller-supplied
  // `failedText` byte-identical for permanent decrypt fails (decryptionStatus
  // === "failed"). The current English localisation is exercised here as a
  // sentinel; production callers pass `t("message.notDecrypted")` from i18n.
  // If the wording in en.ts/ru.ts changes, update the constant below in lock-step.
  it("surfaces actionable wording for permanent decrypt fail (WEE-39)", () => {
    const failedText = "Couldn't decrypt — ask the sender to resend or update the app";
    const result = getMessagePreviewForUI("[encrypted]", "failed", failedText);
    expect(result.state).toBe("failed");
    expect(result.text).toBe(failedText);
    expect(result.text).not.toBe("Message not decrypted");
  });
});
