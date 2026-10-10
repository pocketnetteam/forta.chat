import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Dexie from "dexie";
import "fake-indexeddb/auto";
import { MessageRepository } from "../message-repository";
import type { ChatDatabase, LocalMessage, LocalRoom } from "../schema";
import { MessageType } from "@/entities/chat/model/types";

/**
 * Regression: a text sent right after a missed call showed in the chat list in
 * red as a missed call — the optimistic preview write kept the call's
 * lastMessageCallInfo, and the server echo usually lost the monotonic guard.
 */

class TestDb extends Dexie {
  messages!: Dexie.Table<LocalMessage, number>;
  rooms!: Dexie.Table<LocalRoom, string>;

  constructor() {
    super("TestDb_createLocalCallPreview", { indexedDB, IDBKeyRange });
    this.version(1).stores({
      messages: "++localId, eventId, clientId, [roomId+timestamp], [roomId+status], senderId",
      rooms: "id, updatedAt, membership, isDeleted",
    });
  }
}

describe("createLocal — replaces the previous last message's details", () => {
  let db: TestDb;
  let repo: MessageRepository;

  beforeEach(async () => {
    db = new TestDb();
    await db.open();
    repo = new MessageRepository(db as unknown as ChatDatabase);
    await db.rooms.add({
      id: "!room:server",
      updatedAt: 1,
      membership: "join",
      isDeleted: false,
      lastMessageType: MessageType.system,
      lastMessageCallInfo: { callType: "voice", missed: true },
      lastMessageSystemMeta: { template: "system.missedVoiceCall", senderAddr: "peer" },
      lastMessageDecryptionStatus: "failed",
    } as unknown as LocalRoom);
  });

  afterEach(async () => {
    await db.delete();
  });

  it("drops the missed call's info when a text is sent after it", async () => {
    await repo.createLocal({ roomId: "!room:server", senderId: "me", content: "Илья?", type: MessageType.text });

    const room = await db.rooms.get("!room:server");
    expect(room?.lastMessagePreview).toBe("Илья?");
    expect(room?.lastMessageType).toBe(MessageType.text);
    expect(room?.lastMessageCallInfo).toBeUndefined();
    expect(room?.lastMessageSystemMeta).toBeUndefined();
    expect(room?.lastMessageDecryptionStatus).toBeUndefined();
  });
});
