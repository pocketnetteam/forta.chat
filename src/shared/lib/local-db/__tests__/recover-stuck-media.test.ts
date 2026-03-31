import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Dexie from "dexie";
import "fake-indexeddb/auto";
import { MessageRepository } from "../message-repository";
import type { LocalMessage } from "../schema";
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
    super("TestDb_recoverMedia", { indexedDB, IDBKeyRange });
    this.version(1).stores({
      messages:
        "++localId, eventId, clientId, [roomId+timestamp], [roomId+status], senderId, status",
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

function makeMsg(overrides: Partial<LocalMessage> = {}): LocalMessage {
  return {
    eventId: null,
    clientId: `cli_${Math.random().toString(36).slice(2)}`,
    roomId: "!room:server",
    senderId: "user1",
    content: "image.png",
    timestamp: Date.now() - 5 * 60 * 1000, // 5 min ago (older than default cutoff)
    type: MessageType.image,
    status: "pending",
    version: 1,
    softDeleted: false,
    uploadProgress: 42,
    ...overrides,
  } as LocalMessage;
}

describe("MessageRepository.recoverStuckMedia", () => {
  let db: TestDb;
  let repo: MessageRepository;

  beforeEach(() => {
    db = new TestDb();
    repo = new MessageRepository(db as any);
  });

  afterEach(async () => {
    await db.delete();
  });

  it("marks old pending media messages as failed", async () => {
    const id = await db.messages.add(makeMsg());

    const count = await repo.recoverStuckMedia();

    expect(count).toBe(1);
    const msg = await db.messages.get(id);
    expect(msg!.status).toBe("failed");
    expect(msg!.uploadProgress).toBeUndefined();
  });

  it("does not touch recent pending media (within cutoff)", async () => {
    const id = await db.messages.add(
      makeMsg({ timestamp: Date.now() - 30_000, uploadProgress: 50 }),
    );

    const count = await repo.recoverStuckMedia();

    expect(count).toBe(0);
    const msg = await db.messages.get(id);
    expect(msg!.status).toBe("pending");
    expect(msg!.uploadProgress).toBe(50);
  });

  it("does not touch pending text messages (no uploadProgress)", async () => {
    const id = await db.messages.add(
      makeMsg({ type: MessageType.text, uploadProgress: undefined }),
    );

    const count = await repo.recoverStuckMedia();

    expect(count).toBe(0);
    const msg = await db.messages.get(id);
    expect(msg!.status).toBe("pending");
  });

  it("does not touch already-synced messages", async () => {
    const id = await db.messages.add(
      makeMsg({ status: "synced", uploadProgress: 100 }),
    );

    const count = await repo.recoverStuckMedia();

    expect(count).toBe(0);
    const msg = await db.messages.get(id);
    expect(msg!.status).toBe("synced");
  });

  it("does not touch already-failed messages", async () => {
    const id = await db.messages.add(
      makeMsg({ status: "failed", uploadProgress: 10 }),
    );

    const count = await repo.recoverStuckMedia();

    expect(count).toBe(0);
    const msg = await db.messages.get(id);
    expect(msg!.status).toBe("failed");
  });

  it("recovers multiple stuck uploads in one call", async () => {
    await db.messages.bulkAdd([
      makeMsg({ clientId: "a" }),
      makeMsg({ clientId: "b" }),
      makeMsg({ clientId: "c" }),
    ]);

    const count = await repo.recoverStuckMedia();

    expect(count).toBe(3);
    const all = await db.messages.toArray();
    expect(all.every((m) => m.status === "failed")).toBe(true);
    expect(all.every((m) => m.uploadProgress === undefined)).toBe(true);
  });

  it("respects custom maxAgeMs parameter", async () => {
    // Message is 3 minutes old
    const id = await db.messages.add(
      makeMsg({ timestamp: Date.now() - 3 * 60 * 1000 }),
    );

    // With 5-minute cutoff, should NOT recover
    let count = await repo.recoverStuckMedia(5 * 60 * 1000);
    expect(count).toBe(0);

    // With 1-minute cutoff, should recover
    count = await repo.recoverStuckMedia(1 * 60 * 1000);
    expect(count).toBe(1);
    const msg = await db.messages.get(id);
    expect(msg!.status).toBe("failed");
  });
});
