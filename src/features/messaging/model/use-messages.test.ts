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
const mockSendEncryptedText = vi.fn<
  (roomId: string, content: Record<string, unknown>, clientId?: string) => string
>(() => "$server_event_1");
const mockSendText = vi.fn(() => "$server_event_1");
const mockSendPollStart = vi.fn(() => "$poll_event_1");
const mockSendPollResponse = vi.fn();
const mockSendPollEnd = vi.fn();
const mockIsReady = vi.fn(() => true);

vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: vi.fn(() => ({
    isReady: () => mockIsReady(),
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

  // ─── sendMessage (optimistic UI guarantee) ────────────────────

  describe("sendMessage", () => {
    it("returns false when roomId is empty", async () => {
      chatStore.activeRoomId = null as unknown as string;
      const result = await messaging.sendMessage("hello");
      expect(result).toBe(false);
    });

    it("returns false when content is empty", async () => {
      const result = await messaging.sendMessage("   ");
      expect(result).toBe(false);
    });

    it("creates optimistic message and sends via legacy path", async () => {
      const result = await messaging.sendMessage("Hello world");
      expect(result).toBe(true);
      const msgs = chatStore.messages["!room:server"];
      expect(msgs).toHaveLength(1);
      expect(msgs[0].content).toBe("Hello world");
      expect(msgs[0].status).toBe(MessageStatus.sent);
      expect(mockSendText).toHaveBeenCalled();
    });

    it("shows optimistic message as failed when matrixService is not ready (legacy path)", async () => {
      mockIsReady.mockReturnValue(false);
      const result = await messaging.sendMessage("I should still appear");
      expect(result).toBe(true);
      const msgs = chatStore.messages["!room:server"];
      expect(msgs).toHaveLength(1);
      expect(msgs[0].content).toBe("I should still appear");
      expect(msgs[0].status).toBe(MessageStatus.failed);
      expect(mockSendText).not.toHaveBeenCalled();
    });

    it("marks message as failed when sendText throws", async () => {
      mockSendText.mockRejectedValueOnce(new Error("Network error"));
      const result = await messaging.sendMessage("Will fail on send");
      expect(result).toBe(true);
      const msgs = chatStore.messages["!room:server"];
      expect(msgs).toHaveLength(1);
      expect(msgs[0].status).toBe(MessageStatus.failed);
    });
  });

  // ─── sendReply (optimistic UI guarantee) ──────────────────────

  describe("sendReply", () => {
    it("returns false when no replyTo is set", async () => {
      chatStore.replyingTo = null;
      const result = await messaging.sendReply("reply text");
      expect(result).toBe(false);
    });

    it("creates optimistic reply and sends via legacy path", async () => {
      const replyTarget = makeMsg({ roomId: "!room:server", content: "original" });
      chatStore.addMessage("!room:server", replyTarget);
      chatStore.replyingTo = replyTarget;

      const result = await messaging.sendReply("my reply");
      expect(result).toBe(true);
      const msgs = chatStore.messages["!room:server"];
      // original + reply
      expect(msgs).toHaveLength(2);
      const reply = msgs[1];
      expect(reply.content).toBe("my reply");
      expect(reply.replyTo).toBeDefined();
      expect(chatStore.replyingTo).toBeNull();
    });

    it("shows optimistic reply as failed when matrixService not ready (legacy path)", async () => {
      mockIsReady.mockReturnValue(false);
      const replyTarget = makeMsg({ roomId: "!room:server" });
      chatStore.addMessage("!room:server", replyTarget);
      chatStore.replyingTo = replyTarget;

      const result = await messaging.sendReply("reply when offline");
      expect(result).toBe(true);
      const msgs = chatStore.messages["!room:server"];
      const reply = msgs[1];
      expect(reply.content).toBe("reply when offline");
      expect(reply.status).toBe(MessageStatus.failed);
    });
  });

  // ─── deleteMessages (bulk) ────────────────────────────────────

  describe("deleteMessages (bulk)", () => {
    beforeEach(() => {
      // Reset mock return values that vi.clearAllMocks() doesn't clear
      mockIsReady.mockReturnValue(true);
      mockRedactEvent.mockReset();
    });

    it("redacts ALL selected messages when forEveryone=true", async () => {
      const m1 = makeMsg({ roomId: "!room:server", id: "$e1" });
      const m2 = makeMsg({ roomId: "!room:server", id: "$e2" });
      const m3 = makeMsg({ roomId: "!room:server", id: "$e3" });
      chatStore.addMessage("!room:server", m1);
      chatStore.addMessage("!room:server", m2);
      chatStore.addMessage("!room:server", m3);

      const result = await messaging.deleteMessages(["$e1", "$e2", "$e3"], true);

      expect(mockRedactEvent).toHaveBeenCalledTimes(3);
      expect(mockRedactEvent).toHaveBeenCalledWith("!room:server", "$e1", "deleted");
      expect(mockRedactEvent).toHaveBeenCalledWith("!room:server", "$e2", "deleted");
      expect(mockRedactEvent).toHaveBeenCalledWith("!room:server", "$e3", "deleted");
      expect(result.succeeded).toBe(3);
      expect(result.failed).toBe(0);
    });

    it("continues on partial failure and reports counts", async () => {
      mockRedactEvent.mockImplementation(
        async (_roomId: string, eventId: string): Promise<void> => {
          if (eventId === "$e2") throw new Error("transient network");
        },
      );
      const m1 = makeMsg({ roomId: "!room:server", id: "$e1" });
      const m2 = makeMsg({ roomId: "!room:server", id: "$e2" });
      const m3 = makeMsg({ roomId: "!room:server", id: "$e3" });
      chatStore.addMessage("!room:server", m1);
      chatStore.addMessage("!room:server", m2);
      chatStore.addMessage("!room:server", m3);

      const result = await messaging.deleteMessages(["$e1", "$e2", "$e3"], true);

      expect(result.succeeded).toBe(2);
      expect(result.failed).toBe(1);
    });

    it("skips redact and only marks locally deleted when forEveryone=false", async () => {
      const m1 = makeMsg({ roomId: "!room:server", id: "$e1" });
      const m2 = makeMsg({ roomId: "!room:server", id: "$e2" });
      chatStore.addMessage("!room:server", m1);
      chatStore.addMessage("!room:server", m2);

      const result = await messaging.deleteMessages(["$e1", "$e2"], false);

      expect(mockRedactEvent).not.toHaveBeenCalled();
      expect(result.succeeded).toBe(2);
      expect(result.failed).toBe(0);
      // removeMessage marks as deleted (WhatsApp-style placeholder), doesn't splice
      const roomMsgs = chatStore.messages["!room:server"];
      expect(roomMsgs.every((m) => m.deleted === true)).toBe(true);
    });

    it("handles empty array gracefully", async () => {
      const result = await messaging.deleteMessages([], true);
      expect(result.succeeded).toBe(0);
      expect(result.failed).toBe(0);
      expect(mockRedactEvent).not.toHaveBeenCalled();
    });

    it("returns zero on all-fail when matrixService is not ready", async () => {
      mockIsReady.mockReturnValue(false);
      const m1 = makeMsg({ roomId: "!room:server", id: "$e1" });
      chatStore.addMessage("!room:server", m1);

      const result = await messaging.deleteMessages(["$e1"], true);
      // No redact attempted (service not ready) — treat as no-op
      expect(mockRedactEvent).not.toHaveBeenCalled();
      expect(result.failed + result.succeeded).toBe(1);
    });
  });

  // ─── forwardMessages (bulk) ───────────────────────────────────

  describe("forwardMessages (bulk)", () => {
    beforeEach(() => {
      mockIsReady.mockReturnValue(true);
      mockSendEncryptedText.mockReset();
      mockSendEncryptedText.mockImplementation(() => "$fwd_sent_event");
    });

    it("forwards N selected messages to the target room", async () => {
      const m1 = makeMsg({ roomId: "!src:server", id: "$m1", content: "hi", senderId: "user1" });
      const m2 = makeMsg({ roomId: "!src:server", id: "$m2", content: "there", senderId: "user1" });
      chatStore.addMessage("!src:server", m1);
      chatStore.addMessage("!src:server", m2);

      const result = await messaging.forwardMessages(
        ["$m1", "$m2"],
        "!target:server",
      );

      expect(result.succeeded).toBe(2);
      expect(result.failed).toBe(0);
      // All sends went to TARGET room, not the source.
      const roomIds = (mockSendEncryptedText.mock.calls as unknown[][]).map((c) => c[0]);
      expect(roomIds.every((r) => r === "!target:server")).toBe(true);
      expect(roomIds.length).toBe(2);
    });

    it("preserves source-order by timestamp when ids arrive scrambled", async () => {
      const m1 = makeMsg({ roomId: "!src:server", id: "$m1", content: "first", timestamp: 10 });
      const m2 = makeMsg({ roomId: "!src:server", id: "$m2", content: "second", timestamp: 20 });
      const m3 = makeMsg({ roomId: "!src:server", id: "$m3", content: "third", timestamp: 30 });
      chatStore.addMessage("!src:server", m1);
      chatStore.addMessage("!src:server", m2);
      chatStore.addMessage("!src:server", m3);

      await messaging.forwardMessages(["$m3", "$m1", "$m2"], "!target:server");

      const bodies = (mockSendEncryptedText.mock.calls as unknown[][]).map(
        (c) => (c[1] as { body?: string })?.body,
      );
      expect(bodies).toEqual(["first", "second", "third"]);
    });

    it("continues on partial failure and reports counts", async () => {
      mockSendEncryptedText.mockImplementation(
        (_roomId: string, content: { body?: string }) => {
          if (content?.body === "bad") throw new Error("transient");
          return "$ok";
        },
      );
      const m1 = makeMsg({ roomId: "!src:server", id: "$m1", content: "good1", timestamp: 1 });
      const m2 = makeMsg({ roomId: "!src:server", id: "$m2", content: "bad", timestamp: 2 });
      const m3 = makeMsg({ roomId: "!src:server", id: "$m3", content: "good2", timestamp: 3 });
      chatStore.addMessage("!src:server", m1);
      chatStore.addMessage("!src:server", m2);
      chatStore.addMessage("!src:server", m3);

      const result = await messaging.forwardMessages(
        ["$m1", "$m2", "$m3"],
        "!target:server",
      );
      expect(result.succeeded).toBe(2);
      expect(result.failed).toBe(1);
    });

    it("attaches forwarded_from attribution when sender is known", async () => {
      const m1 = makeMsg({ roomId: "!src:server", id: "$m1", content: "orig", senderId: "userA" });
      chatStore.addMessage("!src:server", m1);

      await messaging.forwardMessages(["$m1"], "!target:server");

      const call = (mockSendEncryptedText.mock.calls as unknown[][])[0];
      const content = call[1] as Record<string, unknown>;
      expect(content.forwarded_from).toEqual(
        expect.objectContaining({ sender_id: "userA" }),
      );
    });

    it("handles empty array gracefully", async () => {
      const result = await messaging.forwardMessages([], "!target:server");
      expect(result.succeeded).toBe(0);
      expect(result.failed).toBe(0);
      expect(mockSendEncryptedText).not.toHaveBeenCalled();
    });

    it("omits forwarded_from when withSenderInfo option is false", async () => {
      const m1 = makeMsg({ roomId: "!src:server", id: "$m1", content: "anon", senderId: "userA" });
      chatStore.addMessage("!src:server", m1);

      await messaging.forwardMessages(["$m1"], "!target:server", { withSenderInfo: false });

      const call = (mockSendEncryptedText.mock.calls as unknown[][])[0];
      const content = call[1] as Record<string, unknown>;
      expect(content.forwarded_from).toBeUndefined();
    });
  });
});
