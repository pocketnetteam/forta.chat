import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Dexie from "dexie";
import "fake-indexeddb/auto";
import { MessageRepository } from "../message-repository";
import type { ChatDatabase, LocalMessage } from "../schema";
import { MessageType } from "@/entities/chat/model/types";

class TestDb extends Dexie {
  messages!: Dexie.Table<LocalMessage, number>;
  rooms!: Dexie.Table<Record<string, unknown>, string>;
  decryptionQueue!: Dexie.Table<Record<string, unknown>, number>;
  listenedMessages!: Dexie.Table<Record<string, unknown>, string>;
  pendingOps!: Dexie.Table<Record<string, unknown>, number>;
  users!: Dexie.Table<Record<string, unknown>, string>;
  syncState!: Dexie.Table<Record<string, unknown>, string>;
  attachments!: Dexie.Table<Record<string, unknown>, number>;

  constructor() {
    super("TestDb_timeline", { indexedDB, IDBKeyRange });
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

function makeLocal(overrides: Partial<LocalMessage> = {}): LocalMessage {
  return {
    eventId: overrides.eventId ?? `$evt_${Math.random().toString(36).slice(2)}`,
    clientId: overrides.clientId ?? `cli_${Math.random().toString(36).slice(2)}`,
    roomId: overrides.roomId ?? "!room:server",
    senderId: "u1",
    content: "hi",
    timestamp: overrides.timestamp ?? Date.now(),
    type: MessageType.text,
    status: "synced",
    version: 1,
    softDeleted: false,
    ...overrides,
  } as LocalMessage;
}

describe("MessageRepository timeline ordering", () => {
  let db: TestDb;
  let repo: MessageRepository;
  const roomId = "!room:server";

  beforeEach(async () => {
    db = new TestDb();
    await db.open();
    repo = new MessageRepository(db as unknown as ChatDatabase);
  });

  afterEach(async () => {
    await db.delete();
  });

  it("getMessageContext returns chronologically sorted messages and correct targetIndex", async () => {
    const t0 = 1000;
    const target = makeLocal({
      roomId,
      eventId: "$target",
      timestamp: t0 + 50,
      clientId: "c-target",
    });
    const older = makeLocal({
      roomId,
      eventId: "$old1",
      timestamp: t0,
      clientId: "c-old",
    });
    const newer = makeLocal({
      roomId,
      eventId: "$new1",
      timestamp: t0 + 100,
      clientId: "c-new",
    });

    await db.messages.bulkAdd([newer, older, target]);

    const ctx = await repo.getMessageContext(roomId, "$target", 25);
    expect(ctx).not.toBeNull();
    expect(ctx!.targetIndex).toBe(1);
    expect(ctx!.messages.map(m => m.eventId)).toEqual(["$old1", "$target", "$new1"]);
  });

  it("getMessagesAroundTimestamp yields sorted messages and anchor after watermark", async () => {
    const watermark = 5000;
    const beforeMsg = makeLocal({
      roomId,
      eventId: "$b1",
      timestamp: watermark - 100,
    });
    const atWatermark = makeLocal({
      roomId,
      eventId: "$at",
      timestamp: watermark,
    });
    const afterMsg = makeLocal({
      roomId,
      eventId: "$a1",
      timestamp: watermark + 1,
    });

    await db.messages.bulkAdd([afterMsg, atWatermark, beforeMsg]);

    const { messages, anchorIndex } = await repo.getMessagesAroundTimestamp(
      roomId,
      watermark,
      15,
      35,
    );

    expect(messages.map(m => m.eventId)).toEqual(["$b1", "$at", "$a1"]);
    expect(anchorIndex).toBe(2);
  });
});
