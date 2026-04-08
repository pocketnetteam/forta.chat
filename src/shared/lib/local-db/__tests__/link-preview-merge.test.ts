import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Dexie from "dexie";
import "fake-indexeddb/auto";
import { MessageRepository } from "../message-repository";
import type { ChatDatabase, LocalMessage } from "../schema";
import { MessageType } from "@/entities/chat/model/types";

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
    super("TestDb_linkPreview", { indexedDB, IDBKeyRange });
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
    eventId: overrides.eventId ?? `$evt_${Math.random().toString(36).slice(2)}`,
    clientId: overrides.clientId ?? `cli_${Math.random().toString(36).slice(2)}`,
    roomId: overrides.roomId ?? "!room:server",
    senderId: overrides.senderId ?? "user1",
    content: overrides.content ?? "Check https://example.com",
    timestamp: overrides.timestamp ?? Date.now(),
    type: overrides.type ?? MessageType.text,
    status: overrides.status ?? "synced",
    version: 1,
    softDeleted: false,
    ...overrides,
  } as LocalMessage;
}

const PREVIEW = {
  url: "https://example.com",
  title: "Example",
  description: "An example page",
  siteName: "Example.com",
};

describe("upsertFromServer — linkPreview merge on own echo", () => {
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

  it("preserves local linkPreview when server echo lacks it", async () => {
    // 1. Create local pending message with linkPreview
    const local = makeLocalMsg({
      eventId: null,
      clientId: "txn_123",
      status: "pending",
      linkPreview: PREVIEW,
    });
    local.localId = (await db.messages.add(local)) as number;

    // 2. Server echo arrives without linkPreview
    const serverMsg = makeLocalMsg({
      eventId: "$server_evt_1",
      clientId: "txn_123",
      status: "synced",
      serverTs: Date.now(),
    });

    const result = await repo.upsertFromServer(serverMsg);
    expect(result).toBe("updated");

    // 3. Verify linkPreview preserved from local
    const updated = await db.messages.get(local.localId!);
    expect(updated!.linkPreview).toEqual(PREVIEW);
    expect(updated!.eventId).toBe("$server_evt_1");
    expect(updated!.status).toBe("synced");
  });

  it("uses server linkPreview when local has none", async () => {
    // 1. Create local pending message without linkPreview
    const local = makeLocalMsg({
      eventId: null,
      clientId: "txn_456",
      status: "pending",
    });
    local.localId = (await db.messages.add(local)) as number;

    // 2. Server echo has linkPreview (parsed from url_preview)
    const serverMsg = makeLocalMsg({
      eventId: "$server_evt_2",
      clientId: "txn_456",
      status: "synced",
      linkPreview: PREVIEW,
      serverTs: Date.now(),
    });

    const result = await repo.upsertFromServer(serverMsg);
    expect(result).toBe("updated");

    const updated = await db.messages.get(local.localId!);
    expect(updated!.linkPreview).toEqual(PREVIEW);
  });

  it("preserves localBlobUrl during echo merge", async () => {
    const local = makeLocalMsg({
      eventId: null,
      clientId: "txn_789",
      status: "pending",
      localBlobUrl: "blob:http://localhost/abc",
    });
    local.localId = (await db.messages.add(local)) as number;

    const serverMsg = makeLocalMsg({
      eventId: "$server_evt_3",
      clientId: "txn_789",
      status: "synced",
      serverTs: Date.now(),
    });

    // localBlobUrl present + status not failed → upload in-flight path
    const result = await repo.upsertFromServer(serverMsg);
    expect(result).toBe("updated");

    const updated = await db.messages.get(local.localId!);
    expect(updated!.localBlobUrl).toBe("blob:http://localhost/abc");
  });
});

describe("createLocal — stores linkPreview", () => {
  let db: TestDb;
  let repo: MessageRepository;

  beforeEach(async () => {
    db = new TestDb();
    await db.open();
    repo = new MessageRepository(db as unknown as ChatDatabase);
    // Insert a room so createLocal's room update doesn't fail
    await db.rooms.add({ id: "!room:server", updatedAt: Date.now(), membership: "join", isDeleted: false });
  });

  afterEach(async () => {
    await db.delete();
  });

  it("persists linkPreview in the optimistic message", async () => {
    const msg = await repo.createLocal({
      roomId: "!room:server",
      senderId: "user1",
      content: "Check https://example.com",
      type: MessageType.text,
      linkPreview: PREVIEW,
    });

    const stored = await db.messages.get(msg.localId!);
    expect(stored!.linkPreview).toEqual(PREVIEW);
  });
});
