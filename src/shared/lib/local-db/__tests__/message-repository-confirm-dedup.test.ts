import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Dexie from "dexie";
import "fake-indexeddb/auto";
import { MessageRepository } from "../message-repository";
import type { ChatDatabase, LocalMessage } from "../schema";
import { MessageType } from "@/entities/chat/model/types";

/**
 * Regression: a send lands server-side but the SDK throws (timeout), so the
 * local row goes "failed". Bastyon's /sync echo has no transaction_id, so it
 * is inserted as a separate `srv_<eventId>` row. The retry reuses clientId as
 * txnId; the server dedupes and returns the same eventId. confirmSent /
 * confirmMediaSent must drop the echo row so the sender sees one message.
 */

class TestDb extends Dexie {
  messages!: Dexie.Table<LocalMessage, number>;
  rooms!: Dexie.Table<unknown, string>;
  decryptionQueue!: Dexie.Table<unknown, number>;
  listenedMessages!: Dexie.Table<unknown, string>;
  pendingOps!: Dexie.Table<unknown, number>;
  users!: Dexie.Table<unknown, string>;
  syncState!: Dexie.Table<unknown, string>;
  attachments!: Dexie.Table<unknown, number>;

  constructor(name: string) {
    super(name, { indexedDB, IDBKeyRange });
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
    eventId: overrides.eventId ?? null,
    clientId:
      overrides.clientId ?? `cli_${Math.random().toString(36).slice(2)}`,
    roomId: overrides.roomId ?? "!room:server",
    senderId: overrides.senderId ?? "@me:server",
    content: overrides.content ?? "Image",
    timestamp: overrides.timestamp ?? Date.now(),
    type: overrides.type ?? MessageType.image,
    status: overrides.status ?? "pending",
    version: 1,
    softDeleted: false,
    ...overrides,
  } as LocalMessage;
}

describe("MessageRepository.confirmSent — drops server-echo duplicate on retry", () => {
  let db: TestDb;
  let repo: MessageRepository;

  beforeEach(async () => {
    db = new TestDb(`confirm-dedup-${Date.now()}-${Math.random()}`);
    await db.open();
    repo = new MessageRepository(db as unknown as ChatDatabase);
  });

  afterEach(async () => {
    await db.delete();
  });

  it("removes the echo row and keeps the retried local row", async () => {
    await db.messages.add(makeLocalMsg({ clientId: "cli_1", content: "Я на улице", type: MessageType.text, status: "failed" }));
    const echo = makeLocalMsg({ clientId: "srv_$evt1", eventId: "$evt1", content: "Я на улице", type: MessageType.text, status: "synced" });
    expect(await repo.upsertFromServer(echo)).toBe("inserted");

    await repo.confirmSent("cli_1", "$evt1");

    const rows = await db.messages.where("eventId").equals("$evt1").toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].clientId).toBe("cli_1");
    expect(rows[0].status).toBe("synced");
  });

  it("carries reactions from the echo row over to the kept row", async () => {
    await db.messages.add(makeLocalMsg({ clientId: "cli_2", type: MessageType.text, status: "failed" }));
    await db.messages.add(makeLocalMsg({
      clientId: "srv_$evt2",
      eventId: "$evt2",
      type: MessageType.text,
      status: "synced",
      reactions: { "👍": { count: 1, users: ["@peer:server"] } },
    }));

    await repo.confirmSent("cli_2", "$evt2");

    const rows = await db.messages.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].reactions?.["👍"]?.count).toBe(1);
  });

  it("leaves unrelated rows alone on a normal confirm", async () => {
    await db.messages.add(makeLocalMsg({ clientId: "cli_3", type: MessageType.text }));
    await db.messages.add(makeLocalMsg({ clientId: "srv_$other", eventId: "$other", type: MessageType.text, status: "synced" }));

    await repo.confirmSent("cli_3", "$evt3");

    expect(await db.messages.count()).toBe(2);
    expect((await repo.getByClientId("cli_3"))?.eventId).toBe("$evt3");
  });

  it("keeps the echo row when the local row is already gone", async () => {
    await db.messages.add(makeLocalMsg({ clientId: "srv_$evt5", eventId: "$evt5", type: MessageType.text, status: "synced" }));

    await repo.confirmSent("cli_gone", "$evt5");

    expect(await db.messages.count()).toBe(1);
  });

  it("confirmMediaSent drops the echo row too", async () => {
    await db.messages.add(makeLocalMsg({ clientId: "cli_4", status: "failed" }));
    await db.messages.add(makeLocalMsg({ clientId: "srv_$evt4", eventId: "$evt4", status: "synced" }));

    await repo.confirmMediaSent("cli_4", "$evt4", { name: "a.jpg", type: "image/jpeg", size: 1, url: "mxc://s/a" }, "!room:server");

    const rows = await db.messages.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].clientId).toBe("cli_4");
  });
});
