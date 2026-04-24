import { describe, it, expect } from "vitest";
import { isSendButtonVisible, isSendButtonDisabled, type SendButtonState } from "./send-button-state";

const base: SendButtonState = {
  text: "",
  sending: false,
  showForwardPreview: false,
  showBulkForwardPreview: false,
  peerKeysOk: true,
};

describe("send-button-state", () => {
  describe("isSendButtonVisible", () => {
    it("hidden when idle and no content", () => {
      expect(isSendButtonVisible(base)).toBe(false);
    });

    it("visible when user typed text", () => {
      expect(isSendButtonVisible({ ...base, text: "hi" })).toBe(true);
    });

    it("visible while sending (spinner)", () => {
      expect(isSendButtonVisible({ ...base, sending: true })).toBe(true);
    });

    it("visible during singular forward without caption", () => {
      expect(isSendButtonVisible({ ...base, showForwardPreview: true })).toBe(true);
    });

    // Regression: bulk forward preview was added without updating the
    // send button's v-if — on mobile (Enter = newline) this made it
    // impossible to complete a multi-select forward without a caption.
    it("visible during bulk forward without caption", () => {
      expect(isSendButtonVisible({ ...base, showBulkForwardPreview: true })).toBe(true);
    });

    it("whitespace-only text alone is not enough to show", () => {
      expect(isSendButtonVisible({ ...base, text: "   " })).toBe(false);
    });
  });

  describe("isSendButtonDisabled", () => {
    it("disabled when nothing to send", () => {
      expect(isSendButtonDisabled(base)).toBe(true);
    });

    it("enabled with text and ready peers", () => {
      expect(isSendButtonDisabled({ ...base, text: "hi" })).toBe(false);
    });

    it("enabled for singular forward without caption", () => {
      expect(isSendButtonDisabled({ ...base, showForwardPreview: true })).toBe(false);
    });

    // Regression: the same omission in :disabled would leave the button
    // grayed out even if it were somehow made visible.
    it("enabled for bulk forward without caption", () => {
      expect(isSendButtonDisabled({ ...base, showBulkForwardPreview: true })).toBe(false);
    });

    it("disabled while sending, even with content", () => {
      expect(isSendButtonDisabled({ ...base, text: "hi", sending: true })).toBe(true);
    });

    it("disabled when peer keys are missing, even with content", () => {
      expect(isSendButtonDisabled({ ...base, text: "hi", peerKeysOk: false })).toBe(true);
    });

    it("disabled for bulk forward when peer keys are missing", () => {
      expect(isSendButtonDisabled({ ...base, showBulkForwardPreview: true, peerKeysOk: false })).toBe(true);
    });

    // Real runtime state on mobile: user taps Send during a bulk forward.
    // Button must stay visible (so the spinner renders) AND stay disabled
    // so a second tap doesn't re-enqueue the same batch.
    it("visible and disabled while a bulk forward is in flight", () => {
      const state = { ...base, showBulkForwardPreview: true, sending: true };
      expect(isSendButtonVisible(state)).toBe(true);
      expect(isSendButtonDisabled(state)).toBe(true);
    });
  });
});
