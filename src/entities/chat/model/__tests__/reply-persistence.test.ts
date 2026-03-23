import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Dexie from "dexie";
import "fake-indexeddb/auto";
import { MessageRepository } from "@/shared/lib/local-db/message-repository";
import type { ChatDatabase, LocalMessage } from "@/shared/lib/local-db/schema";
import { MessageType } from "@/entities/chat/model/types";

class TestDb extends Dexie {
  messages!: Dexie.Table<LocalMessage, number>;
  rooms!: Dexie.Table<any, string>;
  decryptionQueue!: Dexie.Table<any, number>;
  listenedMessages!: Dexie.Table<any, string>;
  pendingOps!: Dexie.Table<any, number>;
  users!: Dexie.Table<any, string>;

  constructor(name: string) {
    super(name, { indexedDB, IDBKeyRange });
    this.version(1).stores({
      messages: "++localId, eventId, clientId, [roomId+timestamp], [roomId+status], senderId",
      rooms: "id, updatedAt, membership, isDeleted",
      decryptionQueue: "++id, status, [status+nextAttemptAt]",
      listenedMessages: "messageId",
      pendingOps: "++id, status",
      users: "address",
    });
  }
}

function makeLocalMsg(overrides: Partial<LocalMessage> = {}): LocalMessage {
  return {
    eventId: overrides.eventId ?? `$evt_${Math.random().toString(36).slice(2)}`,
    clientId: overrides.clientId ?? `cli_${Math.random().toString(36).slice(2)}`,
    roomId: overrides.roomId ?? "!room:server",
    senderId: overrides.senderId ?? "user1",
    content: overrides.content ?? "hello",
    timestamp: overrides.timestamp ?? Date.now(),
    type: overrides.type ?? MessageType.text,
    status: "synced" as const,
    version: 1,
    softDeleted: false,
    ...overrides,
  } as LocalMessage;
}

describe("Reply Preview Persistence (regression)", () => {
  let db: TestDb;
  let repo: MessageRepository;

  beforeEach(async () => {
    db = new TestDb(`TestReplyRegression_${Math.random()}`);
    await db.open();
    repo = new MessageRepository(db as unknown as ChatDatabase);
  });

  afterEach(async () => {
    await db.delete();
  });

  it("REGRESSION: reply arriving while user is in another room gets patched on room open", async () => {
    await db.messages.add(makeLocalMsg({
      eventId: "$original",
      roomId: "!r:s",
      content: "Hey, check this out",
      senderId: "bob",
      timestamp: 1000,
    }));

    await db.messages.add(makeLocalMsg({
      eventId: "$reply",
      roomId: "!r:s",
      content: "Sure, looks good",
      senderId: "alice",
      timestamp: 2000,
      replyTo: { id: "$original", senderId: "", content: "" },
    }));

    const before = await repo.getByEventId("$reply");
    expect(before?.replyTo?.senderId).toBe("");
    expect(before?.replyTo?.content).toBe("");

    await repo.patchUnresolvedReplies([{
      eventId: "$reply",
      replyTo: { id: "$original", senderId: "bob", content: "Hey, check this out", type: MessageType.text },
    }]);

    const after = await repo.getByEventId("$reply");
    expect(after?.replyTo?.senderId).toBe("bob");
    expect(after?.replyTo?.content).toBe("Hey, check this out");
    expect(after?.replyTo?.type).toBe(MessageType.text);
  });

  it("REGRESSION: already-resolved reply is not overwritten on subsequent load", async () => {
    await db.messages.add(makeLocalMsg({
      eventId: "$reply2",
      roomId: "!r:s",
      replyTo: { id: "$orig2", senderId: "carol", content: "Important text", type: MessageType.text },
    }));

    await repo.patchUnresolvedReplies([{
      eventId: "$reply2",
      replyTo: { id: "$orig2", senderId: "dave", content: "Wrong text" },
    }]);

    const msg = await repo.getByEventId("$reply2");
    expect(msg?.replyTo?.senderId).toBe("carol");
    expect(msg?.replyTo?.content).toBe("Important text");
  });

  it("REGRESSION: cold start — reply target never synced locally", async () => {
    await db.messages.add(makeLocalMsg({
      eventId: "$reply3",
      roomId: "!r:s",
      replyTo: { id: "$ancient", senderId: "", content: "" },
    }));

    await repo.patchUnresolvedReplies([]);

    const msg = await repo.getByEventId("$reply3");
    expect(msg?.replyTo?.senderId).toBe("");
  });

  it("REGRESSION: deleted reply target stays deleted after patch attempt", async () => {
    await db.messages.add(makeLocalMsg({
      eventId: "$reply4",
      roomId: "!r:s",
      replyTo: { id: "$deleted", senderId: "", content: "", deleted: true },
    }));

    await repo.patchUnresolvedReplies([{
      eventId: "$reply4",
      replyTo: { id: "$deleted", senderId: "eve", content: "Resurrected?" },
    }]);

    const msg = await repo.getByEventId("$reply4");
    expect(msg?.replyTo?.deleted).toBe(true);
    expect(msg?.replyTo?.senderId).toBe("");
  });
});
