/**
 * Regression: syncEditMessage copied only body/block/version of the
 * encryptEvent() result into the outer edit content and dropped `hash`.
 * Group ciphertexts are routed by `hash` (decryptEvent → decryptEventGroup),
 * so every group edit fell into the 1:1 path and every reader — Forta
 * included — rendered it as "[encrypted]". bastyon-chat sends the whole
 * encryptEvent() result plus m.relates_to; so must we.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Dexie from "dexie";
import "fake-indexeddb/auto";
import { SyncEngine } from "../sync-engine";
import type { PendingOperation, LocalMessage, LocalRoom } from "../schema";
import { disposeSyncEngineHarness } from "./sync-engine-test-helpers";

const mockMatrix = {
  sendEncryptedText: vi.fn<
    (roomId: string, content: Record<string, unknown>, txnId?: string) => Promise<string>
  >(async () => "$server_event_id"),
};

vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: () => mockMatrix,
}));

class TestDb extends Dexie {
  messages!: Dexie.Table<LocalMessage, number>;
  rooms!: Dexie.Table<LocalRoom, string>;
  pendingOps!: Dexie.Table<PendingOperation, number>;

  constructor(name: string) {
    super(name, { indexedDB, IDBKeyRange });
    this.version(1).stores({
      messages: "++localId, eventId, clientId, [roomId+timestamp], [roomId+status], senderId",
      rooms: "id, updatedAt, membership, isDeleted",
      pendingOps: "++id, [roomId+createdAt], status, clientId, [status+nextAttemptAt]",
      attachments: "++id, messageLocalId, status",
      users: "address, updatedAt",
      syncState: "key",
      decryptionQueue: "++id, status, [status+nextAttemptAt]",
      listenedMessages: "messageId",
    });
  }
}

function makeHarness(encrypted: Record<string, unknown>) {
  const db = new TestDb(`enc-edit-${Date.now()}-${Math.random()}`);
  const messageRepo = {
    confirmSent: vi.fn(async () => undefined),
    updateStatus: vi.fn(async () => undefined),
    getByEventId: vi.fn(async () => undefined),
    getByClientId: vi.fn(async () => undefined),
  };
  const roomRepo = {
    updateRoom: vi.fn(async () => undefined),
    syncLastMessageLocalStatus: vi.fn(async () => undefined),
  };
  const roomCrypto = {
    canBeEncrypt: () => true,
    requiresEncryption: () => true,
    encryptEvent: vi.fn(async () => ({ ...encrypted })),
  };
  const engine = new SyncEngine(
    db as never,
    messageRepo as never,
    roomRepo as never,
    (async () => roomCrypto) as never,
  );
  return { db, engine, roomCrypto };
}

async function runEdit(h: ReturnType<typeof makeHarness>): Promise<Record<string, unknown>> {
  await h.db.open();
  await h.db.pendingOps.add({
    type: "edit_message",
    roomId: "!room:server",
    payload: { eventId: "$orig", newContent: "edited secret text" },
    status: "pending",
    retries: 0,
    maxRetries: 5,
    createdAt: Date.now(),
    clientId: "cli_edit",
    nextAttemptAt: 0,
  } as PendingOperation);
  await h.engine.processQueue();
  const deadline = Date.now() + 1500;
  while ((await h.db.pendingOps.count()) > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(mockMatrix.sendEncryptedText).toHaveBeenCalledTimes(1);
  return mockMatrix.sendEncryptedText.mock.calls[0][1];
}

describe("syncEditMessage — encrypted edit content (bastyon parity)", () => {
  let h: ReturnType<typeof makeHarness>;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await disposeSyncEngineHarness(h);
  });

  it("group edit keeps `hash` at the top level", async () => {
    h = makeHarness({ msgtype: "m.encrypted", body: "a1b2c3", block: 10, hash: "h123" });
    const content = await runEdit(h);

    expect(content.hash).toBe("h123");
    expect(content.body).toBe("a1b2c3");
    expect(content.block).toBe(10);
    expect(content.msgtype).toBe("m.encrypted");
    expect(content["m.relates_to"]).toEqual({ rel_type: "m.replace", event_id: "$orig" });
  });

  it("1:1 edit keeps block and version at the top level", async () => {
    h = makeHarness({ msgtype: "m.encrypted", body: "eyJ9", block: 3500000, version: 2 });
    const content = await runEdit(h);

    expect(content.version).toBe(2);
    expect(content.block).toBe(3500000);
    expect(content.body).toBe("eyJ9");
  });

  it("never ships the edited plaintext", async () => {
    h = makeHarness({ msgtype: "m.encrypted", body: "a1b2c3", block: 10, hash: "h123" });
    const content = await runEdit(h);

    expect(JSON.stringify(content)).not.toContain("edited secret text");
  });
});
