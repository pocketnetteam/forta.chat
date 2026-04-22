import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
import { makeMsg, makeRoom } from "@/test-utils";
import { MessageType, MessageStatus } from "@/entities/chat";

// Auth store mock — formatPreview reads `address` for "You:" prefix in groups.
vi.mock("@/entities/auth", () => ({
  useAuthStore: vi.fn(() => ({ address: "PMe000000000000000000000000000001" })),
}));

// Matrix service mock — chat-store touches it at init.
vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: vi.fn(() => ({
    getUserId: () => "@me:server",
    getRoom: () => ({ selfMembership: "join" }),
    sendReadReceipt: vi.fn(async () => true),
    kit: {
      client: { getUserId: () => "@me:server" },
      isTetatetChat: vi.fn(() => true),
      getRoomMembers: vi.fn(() => []),
    },
  })),
}));

import { useFormatPreview } from "./format-preview";

describe("useFormatPreview", () => {
  beforeEach(() => {
    setActivePinia(createTestingPinia({ stubActions: false }));
    // English locale is default in happy-dom (navigator.language = "en-US").
  });

  describe("call event previews (regression: BAST bug — shown as deleted)", () => {
    // Real-world shape: event-writer stores "[message]" as lastMessagePreview
    // when getPreviewText returned empty for a system event. chat-store rebuilds
    // lastMessage with content="[message]" but preserves callInfo + systemMeta.
    // formatPreview must render the call label via systemMeta, not "deleted".
    it("renders voice-call preview from systemMeta even when content is the [message] sentinel", () => {
      const { formatPreview } = useFormatPreview();
      const room = makeRoom({ isGroup: false });
      const msg = makeMsg({
        content: "[message]",
        type: MessageType.system,
        callInfo: { callType: "voice", missed: false, duration: 42 },
        systemMeta: { template: "system.voiceCall", senderAddr: "PCaller00000000000000000000000001" },
      });

      const result = formatPreview(msg, room);

      expect(result).toBe("📞 Voice call");
      expect(result).not.toContain("deleted");
    });

    it("renders video-call preview from systemMeta with 📹 icon", () => {
      const { formatPreview } = useFormatPreview();
      const room = makeRoom({ isGroup: false });
      const msg = makeMsg({
        content: "[message]",
        type: MessageType.system,
        callInfo: { callType: "video", missed: false, duration: 120 },
        systemMeta: { template: "system.videoCall", senderAddr: "PCaller00000000000000000000000001" },
      });

      expect(formatPreview(msg, room)).toBe("📹 Video call");
    });

    it("renders missed-call preview without mislabeling as deleted", () => {
      const { formatPreview } = useFormatPreview();
      const room = makeRoom({ isGroup: false });
      const msg = makeMsg({
        content: "[message]",
        type: MessageType.system,
        callInfo: { callType: "voice", missed: true },
        systemMeta: { template: "system.missedVoiceCall", senderAddr: "PCaller00000000000000000000000001" },
      });

      expect(formatPreview(msg, room)).toBe("📞 Missed voice call");
    });

    it("still renders call preview when content is empty string", () => {
      const { formatPreview } = useFormatPreview();
      const room = makeRoom({ isGroup: false });
      const msg = makeMsg({
        content: "",
        type: MessageType.system,
        callInfo: { callType: "voice", missed: false, duration: 10 },
        systemMeta: { template: "system.voiceCall", senderAddr: "PCaller00000000000000000000000001" },
      });

      expect(formatPreview(msg, room)).toBe("📞 Voice call");
    });
  });

  describe("system message without meta (edge case)", () => {
    // If a system event arrives without systemMeta.template and without callInfo
    // (e.g. legacy/unknown event), [message] should normalise to empty and the
    // switch's system branch should return an empty preview — never "deleted".
    it("returns empty (not deleted) for system msg with [message] content and no meta", () => {
      const { formatPreview } = useFormatPreview();
      const room = makeRoom({ isGroup: false });
      const msg = makeMsg({ content: "[message]", type: MessageType.system });

      const result = formatPreview(msg, room);

      expect(result).not.toContain("deleted");
      expect(result).toBe("");
    });
  });

  describe("media placeholder fallback (regression: [message] → deleted)", () => {
    it("renders photo fallback when image content is the [message] sentinel", () => {
      const { formatPreview } = useFormatPreview();
      const room = makeRoom({ isGroup: false });
      const msg = makeMsg({
        content: "[message]",
        type: MessageType.image,
        fileInfo: { name: "img.jpg", type: "image/jpeg", size: 1, url: "x" },
        status: MessageStatus.sent,
      });

      expect(formatPreview(msg, room)).toBe("📷 Photo");
    });
  });

  describe("deletion markers (preserve existing behavior)", () => {
    it("renders 'deleted' when msg.deleted is true", () => {
      const { formatPreview } = useFormatPreview();
      const room = makeRoom({ isGroup: false });
      const msg = makeMsg({ content: "whatever", deleted: true });

      expect(formatPreview(msg, room)).toBe("🚫 This message was deleted");
    });

    it("renders 'deleted' for the explicit legacy literal marker", () => {
      const { formatPreview } = useFormatPreview();
      const room = makeRoom({ isGroup: false });
      const msg = makeMsg({ content: "🚫 Message deleted" });

      expect(formatPreview(msg, room)).toBe("🚫 This message was deleted");
    });

    it("renders 'deleted' for empty text with no fileInfo (legacy pattern)", () => {
      const { formatPreview } = useFormatPreview();
      const room = makeRoom({ isGroup: false });
      const msg = makeMsg({ content: "", type: MessageType.text });

      expect(formatPreview(msg, room)).toBe("🚫 This message was deleted");
    });
  });
});
