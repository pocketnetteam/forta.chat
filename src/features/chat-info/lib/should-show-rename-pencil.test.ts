import { describe, it, expect } from "vitest";
import { shouldShowPeerRenamePencil } from "./should-show-rename-pencil";

describe("shouldShowPeerRenamePencil (WEE-37)", () => {
  const peer = "0x1111111111111111111111111111111111111111";
  const me = "0x2222222222222222222222222222222222222222";

  it("shows pencil for 1:1 DM with resolved peer different from me", () => {
    expect(shouldShowPeerRenamePencil(false, peer, me)).toBe(true);
  });

  it("hides pencil for group chats (only member-list pencils belong there)", () => {
    expect(shouldShowPeerRenamePencil(true, peer, me)).toBe(false);
  });

  it("hides pencil for self DM (peerAddress === myAddress)", () => {
    expect(shouldShowPeerRenamePencil(false, me, me)).toBe(false);
  });

  it("hides pencil when peer address has not resolved yet (null)", () => {
    expect(shouldShowPeerRenamePencil(false, null, me)).toBe(false);
  });

  it("hides pencil when peer address has not resolved yet (undefined)", () => {
    expect(shouldShowPeerRenamePencil(false, undefined, me)).toBe(false);
  });

  it("hides pencil when peer address is empty string", () => {
    expect(shouldShowPeerRenamePencil(false, "", me)).toBe(false);
  });

  it("hides pencil before auth resolves my address (null)", () => {
    expect(shouldShowPeerRenamePencil(false, peer, null)).toBe(false);
  });

  it("hides pencil before auth resolves my address (empty string)", () => {
    expect(shouldShowPeerRenamePencil(false, peer, "")).toBe(false);
  });
});
