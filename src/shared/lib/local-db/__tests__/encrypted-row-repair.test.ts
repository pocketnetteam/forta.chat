import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import { ChatDatabase, type LocalMessage } from "../schema";
import { MessageRepository } from "../message-repository";
import { RoomRepository } from "../room-repository";
import { UserRepository } from "../user-repository";
import { EventWriter, type ParsedMessage } from "../event-writer";
import { MessageType } from "@/entities/chat/model/types";

/**
 * Regression (audit A2): bulk write paths (room load, scrollback, prefetch)
 * dropped `encryptedRaw`, so "[encrypted]" history was stored with no
 * ciphertext and decryptionStatus "ok". Every recovery sweep filters on
 * `encryptedBody`, and bulkInsert/upsertFromServer skipped existing
 * eventIds, so such rows could never be repaired short of wiping the DB.
 *
 * Now: EventWriter marks placeholder rows "pending" even without raw, and
 * a later write of the same event that carries the ciphertext or the
 * plaintext repairs the stuck row in place.
 */

const ROOM = "!room:server";
const RAW = { event_id: "$e1", type: "m.room.message", content: { msgtype: "m.encrypted", body: "x" } };

let db: ChatDatabase;
let msgRepo: MessageRepository;
let writer: EventWriter;

function parsed(overrides: Partial<ParsedMessage> = {}): ParsedMessage {
  return {
    eventId: "$e1",
    roomId: ROOM,
    senderId: "peer",
    content: "[encrypted]",
    timestamp: 1000,
    type: MessageType.text,
    ...overrides,
  };
}

/** A row as the buggy scrollback path left it. */
function legacyBrokenRow(overrides: Partial<LocalMessage> = {}): LocalMessage {
  return {
    eventId: "$e1",
    clientId: "srv_$e1",
    roomId: ROOM,
    senderId: "peer",
    content: "[encrypted]",
    timestamp: 1000,
    type: MessageType.text,
    status: "synced",
    version: 1,
    softDeleted: false,
    decryptionStatus: "ok",
    ...overrides,
  };
}

async function row(): Promise<LocalMessage | undefined> {
  return db.messages.where("eventId").equals("$e1").first();
}

beforeEach(async () => {
  db = new ChatDatabase(`test-enc-repair-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await db.open();
  msgRepo = new MessageRepository(db);
  writer = new EventWriter(db, msgRepo, new RoomRepository(db), new UserRepository(db));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.delete();
});

describe("EventWriter.toLocalMessage placeholder status", () => {
  it("stores ciphertext and pending status when encryptedRaw is present", async () => {
    await writer.writeMessages([parsed({ encryptedRaw: RAW })]);
    const r = await row();
    expect(r?.encryptedBody).toBe(JSON.stringify(RAW));
    expect(r?.decryptionStatus).toBe("pending");
  });

  it("marks a placeholder without encryptedRaw as pending (not ok) and warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await writer.writeMessages([parsed()]);
    const r = await row();
    expect(r?.decryptionStatus).toBe("pending");
    expect(r?.encryptedBody).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("without encryptedRaw"), "$e1");
  });
});

describe("repair of stuck \"[encrypted]\" rows (bulkInsert path)", () => {
  it("fills the missing ciphertext when the event is written again with encryptedRaw", async () => {
    await db.messages.add(legacyBrokenRow());
    await writer.writeMessages([parsed({ encryptedRaw: RAW })]);
    const r = await row();
    expect(r?.encryptedBody).toBe(JSON.stringify(RAW));
    expect(r?.decryptionStatus).toBe("pending");
    expect(await db.messages.count()).toBe(1);
  });

  it("replaces the placeholder with plaintext (and its derived type) when the event now decrypts", async () => {
    await db.messages.add(legacyBrokenRow({ encryptedBody: "{}", decryptionStatus: "pending" }));
    const transferInfo = { txId: "tx", amount: 1, from: "a", to: "b" };
    await writer.writeMessages([parsed({ content: "Sent 1 PKOIN", type: MessageType.transfer, transferInfo })]);
    const r = await row();
    expect(r?.content).toBe("Sent 1 PKOIN");
    expect(r?.type).toBe(MessageType.transfer);
    expect(r?.transferInfo).toEqual(transferInfo);
    expect(r?.decryptionStatus).toBe("ok");
    expect(r?.encryptedBody).toBeUndefined();
  });

  it("does not touch rows that are not stuck placeholders", async () => {
    await db.messages.add(legacyBrokenRow({ content: "edited text", edited: true }));
    await writer.writeMessages([parsed({ content: "original text" })]);
    expect((await row())?.content).toBe("edited text");
  });

  it("keeps an existing ciphertext when the new write is still a placeholder", async () => {
    await db.messages.add(legacyBrokenRow({ encryptedBody: "\"orig\"", decryptionStatus: "failed" }));
    await writer.writeMessages([parsed({ encryptedRaw: RAW })]);
    const r = await row();
    expect(r?.encryptedBody).toBe("\"orig\"");
    expect(r?.decryptionStatus).toBe("failed");
  });

  it("never resurrects a deleted row", async () => {
    await db.messages.add(legacyBrokenRow({ softDeleted: true }));
    await writer.writeMessages([parsed({ content: "plain" })]);
    expect((await row())?.content).toBe("[encrypted]");
  });
});

describe("repair of stuck \"[encrypted]\" rows (upsertFromServer path)", () => {
  // Inbound rows carry clientId `srv_<eventId>`, so a re-write of the same
  // event matches by clientId (step 1), not by eventId (step 2) — the live
  // sync path. This was missed by the first version of the fix.
  it("repairs via the clientId match (live sync re-write of an inbound message)", async () => {
    await db.messages.add(legacyBrokenRow());
    const incoming = legacyBrokenRow({ encryptedBody: JSON.stringify(RAW), decryptionStatus: "pending" });
    expect(await msgRepo.upsertFromServer(incoming)).toBe("updated");
    const r = await row();
    expect(r?.encryptedBody).toBe(JSON.stringify(RAW));
    expect(r?.decryptionStatus).toBe("pending");
  });

  it("repairs with plaintext via the full live path (writeMessageBuffered → flush)", async () => {
    await db.messages.add(legacyBrokenRow());
    writer.enableBatching();
    await writer.writeMessageBuffered(parsed({ content: "hello" }), "me", null);
    await writer.flushWriteBuffer();
    const r = await row();
    expect(r?.content).toBe("hello");
    expect(r?.decryptionStatus).toBe("ok");
  });

  it("repairs via the eventId match when clientIds differ", async () => {
    await db.messages.add(legacyBrokenRow());
    const incoming = legacyBrokenRow({ clientId: "other", encryptedBody: JSON.stringify(RAW) });
    expect(await msgRepo.upsertFromServer(incoming)).toBe("updated");
    expect((await row())?.encryptedBody).toBe(JSON.stringify(RAW));
  });

  it("still reports 'duplicate' when there is nothing to repair", async () => {
    await db.messages.add(legacyBrokenRow({ content: "hello" }));
    expect(await msgRepo.upsertFromServer(legacyBrokenRow({ clientId: "other", content: "hello" }))).toBe("duplicate");
  });
});
