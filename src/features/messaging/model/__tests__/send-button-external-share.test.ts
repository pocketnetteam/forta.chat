import { describe, it, expect } from "vitest";
import { isSendButtonDisabled } from "../send-button-state";

// Regression for Session 48: Android Share Sheet → Forta → pick a fresh DM →
// peerKeysStatus for that target room is still "missing" past the grace
// window. Before the fix, the gate stayed disabled and Send tapped silently
// did nothing — the user perceived the share flow as broken. External share
// must bypass peerKeysOk because the user already explicitly picked a target
// and SyncEngine queues the op until keys arrive.
describe("send-button — external share bypasses peerKeysOk", () => {
  it("enabled when external share + peerKeysOk=false (forward preview visible)", () => {
    expect(
      isSendButtonDisabled({
        text: "",
        sending: false,
        showForwardPreview: true,
        showBulkForwardPreview: false,
        peerKeysOk: false,
        isExternalShare: true,
      }),
    ).toBe(false);
  });

  it("disabled when normal forward + peerKeysOk=false", () => {
    expect(
      isSendButtonDisabled({
        text: "hi",
        sending: false,
        showForwardPreview: false,
        showBulkForwardPreview: false,
        peerKeysOk: false,
        isExternalShare: false,
      }),
    ).toBe(true);
  });

  it("still disabled while sending even for external share", () => {
    expect(
      isSendButtonDisabled({
        text: "",
        sending: true,
        showForwardPreview: true,
        showBulkForwardPreview: false,
        peerKeysOk: false,
        isExternalShare: true,
      }),
    ).toBe(true);
  });

  it("still disabled when external share with no sendable content", () => {
    expect(
      isSendButtonDisabled({
        text: "",
        sending: false,
        showForwardPreview: false,
        showBulkForwardPreview: false,
        peerKeysOk: false,
        isExternalShare: true,
      }),
    ).toBe(true);
  });

  it("isExternalShare omitted preserves existing behavior (default false)", () => {
    expect(
      isSendButtonDisabled({
        text: "hi",
        sending: false,
        showForwardPreview: false,
        showBulkForwardPreview: false,
        peerKeysOk: false,
      }),
    ).toBe(true);
  });
});
