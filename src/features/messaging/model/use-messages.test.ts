import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
import { useChatStore, MessageStatus, MessageType } from "@/entities/chat";
import { makeMsg } from "@/test-utils";

// Mock auth store
vi.mock("@/entities/auth", () => ({
  useAuthStore: vi.fn(() => ({
    address: "PMyAddress123456789012345678901234",
    pcrypto: null,
  })),
}));

// Mock connectivity
vi.mock("@/shared/lib/connectivity", () => ({
  useConnectivity: vi.fn(() => ({ isOnline: { value: true } })),
}));

// Mock MatrixClientService with all needed methods
const mockRedactEvent = vi.fn();
const mockSendReaction = vi.fn(() => "$reaction_event_1");
const mockSendEncryptedText = vi.fn(() => "$server_event_1");
const mockSendText = vi.fn(() => "$server_event_1");
const mockSendPollStart = vi.fn(() => "$poll_event_1");
const mockSendPollResponse = vi.fn();
const mockSendPollEnd = vi.fn();

vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: vi.fn(() => ({
    isReady: () => true,
    getUserId: () => "@mockuser:server",
    sendText: mockSendText,
    sendEncryptedText: mockSendEncryptedText,
    redactEvent: mockRedactEvent,
    sendReaction: mockSendReaction,
    setTyping: vi.fn(),
    uploadContent: vi.fn(() => "mxc://server/uploaded"),
    sendPollStart: mockSendPollStart,
    sendPollResponse: mockSendPollResponse,
    sendPollEnd: mockSendPollEnd,
    getRoom: vi.fn(),
  })),
  resetMatrixClientService: vi.fn(),
  MatrixClientService: vi.fn(),
}));

import { useMessages } from "./use-messages";

describe("useMessages", () => {
  let chatStore: ReturnType<typeof useChatStore>;
  let messaging: ReturnType<typeof useMessages>;

  beforeEach(() => {
    vi.clearAllMocks();
    setActivePinia(createTestingPinia({ stubActions: false }));
    chatStore = useChatStore();
    chatStore.activeRoomId = "!room:server";
    messaging = useMessages();
  });

  // ─── toggleReaction ───────────────────────────────────────────

  describe("toggleReaction", () => {
    it("adds a new reaction (first reaction on message)", async () => {
      const msg = makeMsg({ roomId: "!room:server" });
      chatStore.addMessage("!room:server", msg);

      await messaging.toggleReaction(msg.id, "👍");

      // Should have called optimisticAddReaction then sendReaction
      const reactions = chatStore.messages["!room:server"][0].reactions;
      expect(reactions?.["👍"]).toBeDefined();
      expect(mockSendReaction).toHaveBeenCalledWith("!room:server", msg.id, "👍");
    });

    it("toggles off same emoji (redacts)", async () => {
      const msg = makeMsg({ roomId: "!room:server" });
      chatStore.addMessage("!room:server", msg);

      // Simulate existing reaction with server event ID
      chatStore.optimisticAddReaction("!room:server", msg.id, "👍", "PMyAddress123456789012345678901234");
      chatStore.setReactionEventId("!room:server", msg.id, "👍", "$existing_reaction");

      await messaging.toggleReaction(msg.id, "👍");

      expect(mockRedactEvent).toHaveBeenCalledWith("!room:server", "$existing_reaction");
    });

    it("replaces different emoji (redacts old + sends new)", async () => {
      const msg = makeMsg({ roomId: "!room:server" });
      chatStore.addMessage("!room:server", msg);

      // Simulate existing "❤️" reaction with server event ID
      chatStore.optimisticAddReaction("!room:server", msg.id, "❤️", "PMyAddress123456789012345678901234");
      chatStore.setReactionEventId("!room:server", msg.id, "❤️", "$old_reaction");

      await messaging.toggleReaction(msg.id, "😂");

      // Should redact old and send new
      expect(mockRedactEvent).toHaveBeenCalledWith("!room:server", "$old_reaction");
      expect(mockSendReaction).toHaveBeenCalledWith("!room:server", msg.id, "😂");
    });
  });

  // ─── sendTransferMessage ──────────────────────────────────────

  describe("sendTransferMessage", () => {
    it("builds JSON body with _transfer: true marker", async () => {
      await messaging.sendTransferMessage("txid123", 5.5, "PReceiverAddr", "Payment for lunch");

      // Optimistic message should be in store
      const msgs = chatStore.messages["!room:server"];
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe(MessageType.transfer);
      expect(msgs[0].transferInfo).toEqual({
        txId: "txid123",
        amount: 5.5,
        from: "PMyAddress123456789012345678901234",
        to: "PReceiverAddr",
        message: "Payment for lunch",
      });
    });

    it("sends the transfer message via Matrix", async () => {
      await messaging.sendTransferMessage("txid456", 1.0, "PReceiverAddr");

      // sendText or sendEncryptedText should have been called
      expect(mockSendText).toHaveBeenCalled();
      const body = (mockSendText.mock.calls[0] as any[])[1] as string;
      const parsed = JSON.parse(body);
      expect(parsed._transfer).toBe(true);
      expect(parsed.txId).toBe("txid456");
      expect(parsed.amount).toBe(1.0);
    });
  });

  // ─── sendPoll ─────────────────────────────────────────────────

  describe("sendPoll", () => {
    it("builds MSC3381 poll format", async () => {
      await messaging.sendPoll("Favorite color?", ["Red", "Blue", "Green"]);

      expect(mockSendPollStart).toHaveBeenCalled();
      const content = (mockSendPollStart.mock.calls[0] as any[])[1] as Record<string, any>;
      const poll = content["org.matrix.msc3381.poll.start"];
      expect(poll.question.body).toBe("Favorite color?");
      expect(poll.answers).toHaveLength(3);
      expect(poll.answers[0].body).toBe("Red");
      expect(poll.answers[1].id).toBe("opt-1");
      expect(poll.kind).toBe("org.matrix.msc3381.poll.disclosed");
      expect(poll.max_selections).toBe(1);
    });

    it("adds optimistic poll message to store", async () => {
      await messaging.sendPoll("Yes or No?", ["Yes", "No"]);

      const msgs = chatStore.messages["!room:server"];
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe(MessageType.poll);
      expect(msgs[0].pollInfo?.question).toBe("Yes or No?");
      expect(msgs[0].pollInfo?.options).toHaveLength(2);
    });
  });

  // ─── forwardMessage ───────────────────────────────────────────

  describe("forwardMessage", () => {
    it("forwards text with forwarded_from metadata", async () => {
      const msg = makeMsg({
        roomId: "!room:server",
        senderId: "OriginalSender",
        content: "forwarded text",
      });

      await messaging.forwardMessage(msg, "!target:server", true);

      expect(mockSendEncryptedText).toHaveBeenCalled();
      const call = mockSendEncryptedText.mock.calls[0] as any[];
      const [targetRoom, content] = call;
      expect(targetRoom).toBe("!target:server");
      expect(content.body).toBe("forwarded text");
      expect(content.forwarded_from).toBeDefined();
      expect(content.forwarded_from.sender_id).toBe("OriginalSender");
    });

    it("forwards text without sender info when withSenderInfo=false", async () => {
      const msg = makeMsg({ content: "anonymous forward" });

      await messaging.forwardMessage(msg, "!target:server", false);

      const content = (mockSendEncryptedText.mock.calls[0] as any[])[1];
      expect(content.forwarded_from).toBeUndefined();
    });

    it("preserves original forwarded_from when re-forwarding", async () => {
      const msg = makeMsg({
        content: "double forwarded",
        forwardedFrom: { senderId: "OriginalAuthor", senderName: "Alice" },
      });

      await messaging.forwardMessage(msg, "!target:server", true);

      const content = (mockSendEncryptedText.mock.calls[0] as any[])[1];
      expect(content.forwarded_from.sender_id).toBe("OriginalAuthor");
      expect(content.forwarded_from.sender_name).toBe("Alice");
    });
  });
});
