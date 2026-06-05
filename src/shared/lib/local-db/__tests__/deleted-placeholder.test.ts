import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Dexie from "dexie";
import "fake-indexeddb/auto";
import { MessageRepository } from "../message-repository";
import type { ChatDatabase, LocalMessage } from "../schema";
import { localToMessage } from "../mappers";
import { MessageType } from "@/entities/chat/model/types";

// WEE-81 — regression guard: a redacted (server-confirmed) message must stay
// in the timeline as a "Сообщение удалено" placeholder. Only a local-only
// phantom (pending message with no eventId, deleted before it was ever sent —
// WEE-66 #864) is allowed to vanish without a trace.

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
    super("TestDb_deleted_placeholder", { indexedDB, IDBKeyRange });
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

describe("WEE-81 — getMessages keeps redacted placeholder, drops local-only phantom", () => {
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

  it("returns server-redacted message (softDeleted + eventId) so the placeholder renders", async () => {
    await db.messages.add(
      makeLocal({
        eventId: "$redacted",
        content: "",
        timestamp: 1000,
        softDeleted: true,
        deletedAt: 1500,
      }),
    );

    const msgs = await repo.getMessages(roomId);

    expect(msgs.map((m) => m.eventId)).toContain("$redacted");
    expect(msgs.find((m) => m.eventId === "$redacted")!.softDeleted).toBe(true);
  });

  it("keeps the redacted placeholder alongside normal messages (A1/A2)", async () => {
    await db.messages.bulkAdd([
      makeLocal({ eventId: "$m1", content: "first", timestamp: 1000 }),
      makeLocal({ eventId: "$m2", content: "", timestamp: 2000, softDeleted: true }),
      makeLocal({ eventId: "$m3", content: "third", timestamp: 3000 }),
    ]);

    const msgs = await repo.getMessages(roomId);

    expect(msgs.map((m) => m.eventId)).toEqual(["$m1", "$m2", "$m3"]);
  });

  it("excludes a local-only phantom (eventId null + softDeleted) — WEE-66 #864 kept", async () => {
    await db.messages.bulkAdd([
      makeLocal({ eventId: "$real", content: "kept", timestamp: 1000 }),
      makeLocal({
        eventId: null,
        clientId: "phantom-1",
        content: "",
        timestamp: 2000,
        status: "pending",
        softDeleted: true,
      }),
    ]);

    const msgs = await repo.getMessages(roomId);

    expect(msgs.map((m) => m.clientId)).not.toContain("phantom-1");
    expect(msgs.map((m) => m.eventId)).toEqual(["$real"]);
  });

  it("filter runs before limit — a phantom in the page does not steal a slot", async () => {
    // limit=2 over [real1, phantom, real2]: the phantom must be skipped so both
    // real messages survive, rather than returning [real1, phantom].
    await db.messages.bulkAdd([
      makeLocal({ eventId: "$r1", content: "one", timestamp: 1000 }),
      makeLocal({ eventId: null, clientId: "ph", content: "", timestamp: 2000, status: "pending", softDeleted: true }),
      makeLocal({ eventId: "$r2", content: "two", timestamp: 3000 }),
    ]);

    const msgs = await repo.getMessages(roomId, 2);

    expect(msgs.map((m) => m.eventId)).toEqual(["$r1", "$r2"]);
  });

  it("getMessagesAfter (detached forward-pagination) also drops the local-only phantom", async () => {
    await db.messages.bulkAdd([
      makeLocal({ eventId: "$base", content: "base", timestamp: 1000 }),
      makeLocal({ eventId: "$redacted", content: "", timestamp: 2000, softDeleted: true }),
      makeLocal({ eventId: null, clientId: "ph2", content: "", timestamp: 3000, status: "pending", softDeleted: true }),
    ]);

    const msgs = await repo.getMessagesAfter(roomId, 1000);

    // server-redacted kept (placeholder), phantom dropped
    expect(msgs.map((m) => m.clientId)).not.toContain("ph2");
    expect(msgs.map((m) => m.eventId)).toContain("$redacted");
  });

  it("still returns a pending (not-yet-sent, NOT deleted) message with eventId null", async () => {
    // Guard: the phantom exclusion must only target softDeleted local-only rows,
    // never a normal optimistic message that simply hasn't been confirmed yet.
    await db.messages.add(
      makeLocal({
        eventId: null,
        clientId: "pending-1",
        content: "sending…",
        timestamp: 1000,
        status: "pending",
        softDeleted: false,
      }),
    );

    const msgs = await repo.getMessages(roomId);

    expect(msgs.map((m) => m.clientId)).toContain("pending-1");
  });
});

describe("WEE-81 — mappers: softDeleted/redacted maps to deleted placeholder", () => {
  function base(overrides: Partial<LocalMessage> = {}): LocalMessage {
    return {
      eventId: "$ev",
      clientId: "c1",
      roomId: "!r:s",
      senderId: "alice",
      content: "secret",
      timestamp: 1000,
      type: MessageType.text,
      status: "synced",
      version: 1,
      softDeleted: false,
      deleted: false,
      ...overrides,
    } as LocalMessage;
  }

  it("softDeleted (server-redacted) → Message.deleted=true and content blanked", () => {
    const msg = localToMessage(base({ softDeleted: true }));
    expect(msg.deleted).toBe(true);
    expect(msg.content).toBe("");
  });

  it("deleted flag (parsed redacted echo) → Message.deleted=true", () => {
    const msg = localToMessage(base({ deleted: true, content: "" }));
    expect(msg.deleted).toBe(true);
  });

  it("a normal message stays visible (deleted=false, content preserved)", () => {
    const msg = localToMessage(base());
    expect(msg.deleted).toBe(false);
    expect(msg.content).toBe("secret");
  });
});
