import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Dexie from "dexie";
import "fake-indexeddb/auto";
import { SyncEngine } from "../sync-engine";
import type { PendingOperation, LocalMessage, LocalRoom } from "../schema";

/**
 * Regression coverage for WEE-40: successfully-delivered messages must never
 * end up with status="failed". Two race paths can leak a "failed" badge onto
 * a synced message:
 *
 *   1. matrix-js-sdk throws on the read side after the server accepted the
 *      event. The /sync echo arrives via upsertFromServer and flips the local
 *      row to "synced" with an eventId, but the queue catch-handler later
 *      runs markMessageFailed and downgrades it back to "failed".
 *
 *   2. maxRetries is reached after the echo already confirmed the message.
 *      Same problem — the bookkeeping in processTick must yield to the row's
 *      current state.
 *
 * Both paths are covered here. The fix lives in
 * `sync-engine.ts:isMessageAlreadyConfirmed` and the catch branch of
 * processTick that drops the op when the message is already confirmed.
 */

const mockMatrix = {
  sendEncryptedText: vi.fn<
    (roomId: string, content: unknown, clientId?: string) => Promise<string>
  >(async () => "$server_event_id"),
  sendText: vi.fn<(roomId: string, body: string) => Promise<string>>(async () => "$server_event_id"),
  sendReaction: vi.fn<(roomId: string, eventId: string, emoji: string) => Promise<string>>(
    async () => "$reaction_id",
  ),
  redactEvent: vi.fn<(roomId: string, eventId: string) => Promise<void>>(async () => undefined),
  sendPollStart: vi.fn<(roomId: string, content: unknown) => Promise<string>>(
    async () => "$poll_id",
  ),
  sendPollResponse: vi.fn<(roomId: string, content: unknown) => Promise<void>>(
    async () => undefined,
  ),
  uploadContentMxc: vi.fn<(blob: Blob) => Promise<string>>(async () => "mxc://server/file"),
  // syncSendFile streams uploads through uploadContent (progress + AbortSignal
  // path). The false-failed scenario covered below is about the *send-event*
  // step failing after a successful upload, so we resolve the upload happily
  // and let `sendEncryptedText` carry the simulated failure. Without this
  // mock, the WEE-50 in-attempt upload retry would wait through its budget
  // before the catch branch ever runs and the test would race its timeout.
  uploadContent: vi.fn<
    (
      blob: Blob,
      progress?: (p: { loaded: number; total: number }) => void,
      signal?: AbortSignal,
    ) => Promise<string>
  >(async () => "https://server/_matrix/media/r0/download/server/file"),
};

vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: () => mockMatrix,
}));

class TestDb extends Dexie {
  messages!: Dexie.Table<LocalMessage, number>;
  rooms!: Dexie.Table<LocalRoom, string>;
  pendingOps!: Dexie.Table<PendingOperation, number>;
  attachments!: Dexie.Table<{ id?: number; localBlob?: Blob; size?: number }, number>;
  users!: Dexie.Table<{ address: string }, string>;
  syncState!: Dexie.Table<{ key: string; value: string | number }, string>;
  decryptionQueue!: Dexie.Table<{ id?: number; status: string }, number>;
  listenedMessages!: Dexie.Table<{ messageId: string }, string>;

  constructor(name: string) {
    super(name, { indexedDB, IDBKeyRange });
    this.version(1).stores({
      messages:
        "++localId, eventId, clientId, [roomId+timestamp], [roomId+status], senderId",
      rooms: "id, updatedAt, membership, isDeleted",
      pendingOps:
        "++id, [roomId+createdAt], status, clientId, [status+nextAttemptAt]",
      attachments: "++id, messageLocalId, status",
      users: "address, updatedAt",
      syncState: "key",
      decryptionQueue: "++id, status, [status+nextAttemptAt]",
      listenedMessages: "messageId",
    });
  }
}

interface MessageRepoStub {
  confirmSent: ReturnType<typeof vi.fn>;
  updateStatus: ReturnType<typeof vi.fn>;
  getByEventId: ReturnType<typeof vi.fn>;
  updateReactions: ReturnType<typeof vi.fn>;
  getByClientId: ReturnType<typeof vi.fn>;
}

interface Harness {
  db: TestDb;
  engine: SyncEngine;
  messageRepo: MessageRepoStub;
  roomRepo: { updateRoom: ReturnType<typeof vi.fn>; syncLastMessageLocalStatus: ReturnType<typeof vi.fn> };
  /** Backing store the messageRepo stub reads from. Tests mutate this to
   *  simulate Matrix /sync echoes arriving mid-flight. */
  rows: Map<string, Partial<LocalMessage>>;
}

function makeHarness(name: string): Harness {
  const db = new TestDb(name);
  const rows = new Map<string, Partial<LocalMessage>>();
  const messageRepo: MessageRepoStub = {
    confirmSent: vi.fn(async (clientId: string, eventId: string) => {
      const current = rows.get(clientId) ?? {};
      rows.set(clientId, { ...current, eventId, status: "synced" });
    }),
    updateStatus: vi.fn(async (id: { clientId?: string; eventId?: string }, status: string) => {
      const key = id.clientId ?? id.eventId;
      if (!key) return;
      const current = rows.get(key) ?? {};
      rows.set(key, { ...current, status: status as LocalMessage["status"] });
    }),
    getByEventId: vi.fn(async () => undefined),
    updateReactions: vi.fn(async () => undefined),
    getByClientId: vi.fn(async (clientId: string) => rows.get(clientId)),
  };
  const roomRepo = { updateRoom: vi.fn(async () => undefined), syncLastMessageLocalStatus: vi.fn(async () => undefined) };
  const getRoomCrypto = vi.fn(async () => undefined);
  const engine = new SyncEngine(
    db as never,
    messageRepo as never,
    roomRepo as never,
    getRoomCrypto,
  );
  return { db, engine, messageRepo, roomRepo, rows };
}

async function seedOp(
  db: TestDb,
  overrides: Partial<PendingOperation> = {},
): Promise<number> {
  return db.pendingOps.add({
    type: "send_message",
    roomId: "!room:server",
    payload: { content: "hello" },
    status: "pending",
    retries: 0,
    maxRetries: 2,
    createdAt: Date.now(),
    clientId: `cli_${Math.random().toString(36).slice(2)}`,
    nextAttemptAt: 0,
    ...overrides,
  } as PendingOperation);
}

describe("SyncEngine — WEE-40: false-failed status on delivered messages", () => {
  let h: Harness;

  beforeEach(async () => {
    vi.clearAllMocks();
    h = makeHarness(`sync-engine-false-failed-${Date.now()}-${Math.random()}`);
    await h.db.open();
  });

  afterEach(async () => {
    h.engine.dispose();
    // dispose clears scheduled timers but in-flight microtasks (the catch
    // block of processTick) can still race against db.delete() and raise
    // DexieClosedError. Yield a couple of macrotask ticks so any pending
    // .catch settles before tearing down the database.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await h.db.delete();
  });

  it("does not flip a message to 'failed' when /sync echo already confirmed it", async () => {
    // Simulate the server accepting the event and the echo arriving via
    // upsertFromServer before the SDK error propagates back to processTick.
    h.rows.set("op_echo_wins", { eventId: "$server_event_id", status: "synced" });

    // The SDK still throws as if it never saw the response. With only one
    // attempt allowed the retry loop hits markMessageFailed immediately.
    mockMatrix.sendEncryptedText.mockImplementation(async () => {
      throw new Error("network read timeout after server accept");
    });

    await seedOp(h.db, { clientId: "op_echo_wins", maxRetries: 1 });
    h.engine.processQueue();

    await vi.waitFor(
      async () => {
        const remaining = await h.db.pendingOps
          .where("clientId")
          .equals("op_echo_wins")
          .count();
        expect(remaining).toBe(0);
      },
      { timeout: 2000, interval: 10 },
    );

    // The message must still be "synced" — markMessageFailed must respect
    // the echo and not downgrade the row.
    expect(h.rows.get("op_echo_wins")?.status).toBe("synced");
    expect(h.rows.get("op_echo_wins")?.eventId).toBe("$server_event_id");
    // And updateStatus(..., "failed") must never have been called on this id.
    const failedCalls = h.messageRepo.updateStatus.mock.calls.filter(
      ([id, status]) => (id as { clientId?: string }).clientId === "op_echo_wins" && status === "failed",
    );
    expect(failedCalls).toHaveLength(0);
  });

  it("drops the queued op without retry when the message is already synced", async () => {
    // The catch branch in processTick should detect the confirmed row and
    // delete the op straight away — no nextAttemptAt rescheduling needed.
    h.rows.set("op_already_done", { eventId: "$evt", status: "synced" });

    mockMatrix.sendEncryptedText.mockImplementation(async () => {
      throw new Error("read aborted after accept");
    });

    await seedOp(h.db, { clientId: "op_already_done", maxRetries: 5 });
    h.engine.processQueue();

    await vi.waitFor(
      async () => {
        const remaining = await h.db.pendingOps
          .where("clientId")
          .equals("op_already_done")
          .count();
        expect(remaining).toBe(0);
      },
      { timeout: 2000, interval: 10 },
    );

    // The row must keep its synced state — not be downgraded to failed
    // and not be re-scheduled for retry.
    expect(h.rows.get("op_already_done")?.status).toBe("synced");
  });

  it("does not flip a media upload to 'failed' when /sync echo already confirmed it", async () => {
    // Same race for send_file ops: an upload that fails on the read side
    // after the server accepted the message event must not downgrade the
    // confirmed local row. Coverage parity with the text-message case so
    // future refactors don't regress one path while keeping the other.
    h.rows.set("op_media_done", { eventId: "$media_event_id", status: "synced" });
    mockMatrix.sendEncryptedText.mockImplementation(async () => {
      throw new Error("media send-event read timeout after accept");
    });

    await h.db.attachments.add({ id: 1, localBlob: new Blob(["x"]), size: 1 });
    await seedOp(h.db, {
      clientId: "op_media_done",
      type: "send_file",
      payload: {
        fileName: "x.png",
        mimeType: "image/png",
        msgtype: "m.image",
        attachmentId: 1,
      },
      maxRetries: 1,
    });
    h.engine.processQueue();

    await vi.waitFor(
      async () => {
        const remaining = await h.db.pendingOps
          .where("clientId")
          .equals("op_media_done")
          .count();
        expect(remaining).toBe(0);
      },
      { timeout: 3000, interval: 10 },
    );

    expect(h.rows.get("op_media_done")?.status).toBe("synced");
    const failedCalls = h.messageRepo.updateStatus.mock.calls.filter(
      ([id, status]) => (id as { clientId?: string }).clientId === "op_media_done" && status === "failed",
    );
    expect(failedCalls).toHaveLength(0);
  });

  it("still marks truly-failed sends as failed when no eventId arrived", async () => {
    // Baseline: when the server never accepted the event there is no echo,
    // the local row stays "pending", and markMessageFailed must run.
    h.rows.set("op_real_fail", { status: "pending" });

    mockMatrix.sendEncryptedText.mockImplementation(async () => {
      throw new Error("permanent network failure");
    });

    await seedOp(h.db, { clientId: "op_real_fail", maxRetries: 1 });
    h.engine.processQueue();

    await vi.waitFor(
      async () => {
        const op = await h.db.pendingOps.where("clientId").equals("op_real_fail").first();
        expect(op?.status).toBe("failed");
      },
      { timeout: 2000, interval: 10 },
    );

    expect(h.rows.get("op_real_fail")?.status).toBe("failed");
  });
});
