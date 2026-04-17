import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Dexie from "dexie";
import "fake-indexeddb/auto";
import { MessageRepository } from "../message-repository";
import type { ChatDatabase, LocalMessage } from "../schema";
import { MessageType } from "@/entities/chat/model/types";

// Minimal in-memory Dexie for testing
class TestDb extends Dexie {
  messages!: Dexie.Table<LocalMessage, number>;
  rooms!: Dexie.Table<any, string>;
  decryptionQueue!: Dexie.Table<any, number>;
  listenedMessages!: Dexie.Table<any, string>;
  pendingOps!: Dexie.Table<any, number>;
  users!: Dexie.Table<any, string>;
  syncState!: Dexie.Table<any, string>;
  attachments!: Dexie.Table<any, number>;

  constructor() {
    super("TestDb_reply", { indexedDB, IDBKeyRange });
    this.version(1).stores({
      messages:
        "++localId, eventId, clientId, [roomId+timestamp], [roomId+status], senderId",
      rooms: "id, updatedAt, membership, isDeleted",
      decryptionQueue: "++id, status, [status+nextAttemptAt]",
      listenedMessages: "eventId",
      pendingOps: "++id, status",
      users: "address",
      syncState: "key",
      attachments: "++id, messageLocalId, status",
    });
  }
}

function makeLocalMsg(overrides: Partial<LocalMessage> = {}): LocalMessage {
  return {
    eventId:
      overrides.eventId ?? `$evt_${Math.random().toString(36).slice(2)}`,
    clientId:
      overrides.clientId ?? `cli_${Math.random().toString(36).slice(2)}`,
    roomId: overrides.roomId ?? "!room:server",
    senderId: overrides.senderId ?? "user1",
    content: overrides.content ?? "hello",
    timestamp: overrides.timestamp ?? Date.now(),
    type: overrides.type ?? MessageType.text,
    status: overrides.status ?? "synced",
    version: 1,
    softDeleted: false,
    ...overrides,
  } as LocalMessage;
}

describe("MessageRepository.patchUnresolvedReplies", () => {
  let db: TestDb;
  let repo: MessageRepository;

  beforeEach(async () => {
    db = new TestDb();
    await db.open();
    repo = new MessageRepository(db as unknown as ChatDatabase);
  });

  afterEach(async () => {
    await db.delete();
  });

  it("updates unresolved replyTo with resolved data", async () => {
    const msg = makeLocalMsg({
      eventId: "$reply1",
      roomId: "!r:s",
      replyTo: { id: "$original1", senderId: "", content: "" },
    });
    await db.messages.add(msg);

    await repo.patchUnresolvedReplies([
      {
        eventId: "$reply1",
        replyTo: {
          id: "$original1",
          senderId: "alice",
          content: "Hello world",
          type: MessageType.text,
        },
      },
    ]);

    const updated = await repo.getByEventId("$reply1");
    expect(updated?.replyTo?.senderId).toBe("alice");
    expect(updated?.replyTo?.content).toBe("Hello world");
    expect(updated?.replyTo?.type).toBe(MessageType.text);
  });

  it("does NOT overwrite already-resolved replyTo", async () => {
    const msg = makeLocalMsg({
      eventId: "$reply2",
      roomId: "!r:s",
      replyTo: { id: "$original2", senderId: "bob", content: "Original text" },
    });
    await db.messages.add(msg);

    await repo.patchUnresolvedReplies([
      {
        eventId: "$reply2",
        replyTo: {
          id: "$original2",
          senderId: "charlie",
          content: "Different text",
        },
      },
    ]);

    const unchanged = await repo.getByEventId("$reply2");
    expect(unchanged?.replyTo?.senderId).toBe("bob");
    expect(unchanged?.replyTo?.content).toBe("Original text");
  });

  it("does NOT overwrite deleted replyTo", async () => {
    const msg = makeLocalMsg({
      eventId: "$reply3",
      roomId: "!r:s",
      replyTo: {
        id: "$original3",
        senderId: "",
        content: "",
        deleted: true,
      },
    });
    await db.messages.add(msg);

    await repo.patchUnresolvedReplies([
      {
        eventId: "$reply3",
        replyTo: { id: "$original3", senderId: "dave", content: "text" },
      },
    ]);

    const unchanged = await repo.getByEventId("$reply3");
    expect(unchanged?.replyTo?.deleted).toBe(true);
    expect(unchanged?.replyTo?.senderId).toBe("");
  });

  it("handles empty input gracefully", async () => {
    await repo.patchUnresolvedReplies([]);
    // No error thrown
  });

  it("skips messages without replyTo", async () => {
    const msg = makeLocalMsg({ eventId: "$noreply", roomId: "!r:s" });
    await db.messages.add(msg);

    await repo.patchUnresolvedReplies([
      {
        eventId: "$noreply",
        replyTo: { id: "$x", senderId: "eve", content: "text" },
      },
    ]);

    const unchanged = await repo.getByEventId("$noreply");
    expect(unchanged?.replyTo).toBeUndefined();
  });

  it("batch-patches multiple messages in one call", async () => {
    await db.messages.bulkAdd([
      makeLocalMsg({
        eventId: "$a",
        roomId: "!r:s",
        replyTo: { id: "$t1", senderId: "", content: "" },
      }),
      makeLocalMsg({
        eventId: "$b",
        roomId: "!r:s",
        replyTo: { id: "$t2", senderId: "", content: "" },
      }),
    ]);

    await repo.patchUnresolvedReplies([
      { eventId: "$a", replyTo: { id: "$t1", senderId: "alice", content: "msg1" } },
      { eventId: "$b", replyTo: { id: "$t2", senderId: "bob", content: "msg2" } },
    ]);

    const a = await repo.getByEventId("$a");
    const b = await repo.getByEventId("$b");
    expect(a?.replyTo?.senderId).toBe("alice");
    expect(b?.replyTo?.senderId).toBe("bob");
  });
});

describe("MessageRepository media recovery (no standalone messages.status index)", () => {
  let db: TestDb;
  let repo: MessageRepository;

  beforeEach(async () => {
    db = new TestDb();
    await db.open();
    repo = new MessageRepository(db as unknown as ChatDatabase);
  });

  afterEach(async () => {
    await db.delete();
  });

  it("recoverStuckMedia uses filter+modify without SchemaError", async () => {
    const old = Date.now() - 10 * 60 * 1000;
    await db.messages.add(
      makeLocalMsg({
        eventId: "",
        clientId: "c1",
        status: "pending",
        timestamp: old,
        uploadProgress: 42,
      }),
    );
    const n = await repo.recoverStuckMedia(2 * 60 * 1000);
    expect(n).toBe(1);
    const m = await db.messages.orderBy("localId").last();
    expect(m?.status).toBe("failed");
    expect(m?.uploadProgress).toBeUndefined();
  });

  it("cleanupCancelledUploads uses filter without SchemaError", async () => {
    const old = Date.now() - 10 * 60 * 1000;
    await db.messages.add(
      makeLocalMsg({
        eventId: "$x",
        status: "cancelled",
        timestamp: old,
      }),
    );
    const n = await repo.cleanupCancelledUploads(5 * 60 * 1000);
    expect(n).toBe(1);
    expect(await db.messages.count()).toBe(0);
  });
});
