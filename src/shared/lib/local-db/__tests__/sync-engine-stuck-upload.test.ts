/**
 * Audit W2C-05: a stuck large media upload blocked every later send in its
 * room, and each retry uploaded the whole file again.
 *
 * Part 1 — a retry after the upload finished (the event PUT failed) sends the
 * finished upload instead of encrypting and uploading the file again.
 * Part 2 (owner decision 2026-10-10, changes message order) — new text may go
 * ahead of a stuck upload: one that failed once, or has been in flight past
 * STUCK_UPLOAD_MS. Text behind a healthy upload keeps its place, and edits,
 * deletions and reactions never jump the queue.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Dexie from "dexie";
import "fake-indexeddb/auto";
import { SyncEngine, STUCK_UPLOAD_MS, hasLaneSlot, laneOf, pickClaimableOp, reusableUpload } from "../sync-engine";
import type { PendingOperation, LocalMessage, LocalRoom, LocalAttachment } from "../schema";
import { disposeSyncEngineHarness } from "./sync-engine-test-helpers";

const NOW = 1_800_000_000_000;
let nextId = 1;
function op(partial: Partial<PendingOperation> & Pick<PendingOperation, "type">): PendingOperation {
  return {
    id: nextId++,
    roomId: "!r:s",
    payload: {},
    status: "pending",
    retries: 0,
    maxRetries: 5,
    createdAt: NOW - 60_000,
    clientId: `c${nextId}`,
    nextAttemptAt: 0,
    ...partial,
  };
}

describe("pickClaimableOp (audit W2C-05)", () => {
  beforeEach(() => {
    nextId = 1;
  });

  it("keeps FIFO behind a healthy upload: the file goes first, the text waits", () => {
    const file = op({ type: "send_file" });
    const text = op({ type: "send_message" });
    expect(pickClaimableOp([text, file], NOW, new Set())).toBe(file);
    const inFlight = { ...file, status: "syncing" as const, lastAttemptAt: NOW - STUCK_UPLOAD_MS + 1_000 };
    expect(pickClaimableOp([inFlight, text], NOW, new Set([laneOf(file)]))).toBeNull();
  });

  it("lets text pass an upload in flight past STUCK_UPLOAD_MS", () => {
    const file = op({ type: "send_file", status: "syncing", lastAttemptAt: NOW - STUCK_UPLOAD_MS });
    const text = op({ type: "send_message" });
    expect(pickClaimableOp([file, text], NOW, new Set([laneOf(file)]))).toBe(text);
  });

  it("lets text pass an upload waiting out a retry after a failure", () => {
    const file = op({ type: "send_file", retries: 1, nextAttemptAt: NOW + 30_000 });
    const text = op({ type: "send_message" });
    expect(pickClaimableOp([file, text], NOW, new Set())).toBe(text);
  });

  it("never lets an edit, a deletion or a reaction pass, nor a second text the first one", () => {
    const file = op({ type: "send_file", retries: 1, nextAttemptAt: NOW + 30_000 });
    for (const type of ["edit_message", "delete_message", "send_reaction", "send_file"] as const) {
      expect(pickClaimableOp([file, op({ type })], NOW, new Set())).toBeNull();
    }
    const first = op({ type: "send_message", retries: 1, nextAttemptAt: NOW + 5_000 });
    const second = op({ type: "send_message" });
    expect(pickClaimableOp([file, first, second], NOW, new Set())).toBeNull();
  });

  it("keeps the upload going beside text that passed it", () => {
    const file = op({ type: "send_file", retries: 1, nextAttemptAt: NOW - 1 });
    const text = op({ type: "send_message", status: "syncing", lastAttemptAt: NOW - 100 });
    expect(pickClaimableOp([file, text], NOW, new Set([laneOf(text)]))).toBe(file);
  });

  // Review 2026-10-10: a reaction sent between the stuck upload and the text
  // waited for the upload, and the text waited for the reaction.
  it("lets text pass an edit or reaction that itself waits only for a stuck upload", () => {
    const file = op({ type: "send_file", retries: 1, nextAttemptAt: NOW + 30_000 });
    for (const type of ["send_reaction", "edit_message", "delete_message"] as const) {
      const between = op({ type });
      const text = op({ type: "send_message" });
      expect(pickClaimableOp([file, between, text], NOW, new Set())).toBe(text);
    }
  });

  it("keeps text behind an edit that waits for a healthy upload", () => {
    const file = op({ type: "send_file", status: "syncing", lastAttemptAt: NOW - 1_000 });
    const edit = op({ type: "edit_message" });
    const text = op({ type: "send_message" });
    expect(pickClaimableOp([file, edit, text], NOW, new Set([laneOf(file)]))).toBeNull();
  });

  // Review 2026-10-10: upload lanes counted toward the same three slots as
  // text, so uploads stuck in three rooms stopped text in every room.
  it("gives uploads and other ops three slots each", () => {
    const uploads = ["!a:s", "!b:s", "!c:s"].map((roomId) =>
      op({ type: "send_file", roomId, status: "syncing", lastAttemptAt: NOW - 1_000 }));
    const busyUploads = new Set(uploads.map(laneOf));
    const text = op({ type: "send_message", roomId: "!d:s" });
    const file = op({ type: "send_file", roomId: "!d:s" });
    expect(pickClaimableOp([...uploads, text], NOW, busyUploads)).toBe(text);
    expect(hasLaneSlot(file, busyUploads)).toBe(false);

    const busyText = new Set(["!a:s", "!b:s", "!c:s"]);
    expect(hasLaneSlot(text, busyText)).toBe(false);
    expect(pickClaimableOp([file], NOW, busyText)).toBe(file);
    expect(pickClaimableOp([op({ type: "send_message", roomId: "!e:s" })], NOW, busyText)).toBeNull();
  });

  it("runs other rooms independently", () => {
    const stuck = op({ type: "send_file", status: "syncing", lastAttemptAt: NOW - 1_000 });
    const elsewhere = op({ type: "send_message", roomId: "!other:s" });
    expect(pickClaimableOp([stuck, elsewhere], NOW, new Set([laneOf(stuck)]))).toBe(elsewhere);
  });
});

describe("reusableUpload (audit W2C-05)", () => {
  const encrypting = { canBeEncrypt: () => true };
  const plain = { canBeEncrypt: () => false };

  it("reuses a finished encrypted upload in an encrypting room", () => {
    expect(reusableUpload({ status: "uploaded", remoteUrl: "mxc://s/f", encryptionSecrets: { k: 1 } }, encrypting))
      .toEqual({ url: "mxc://s/f", secrets: { k: 1 } });
  });

  it("reuses a plaintext upload only where the room does not encrypt", () => {
    expect(reusableUpload({ status: "uploaded", remoteUrl: "mxc://s/f" }, plain)).toEqual({ url: "mxc://s/f", secrets: undefined });
    expect(reusableUpload({ status: "uploaded", remoteUrl: "mxc://s/f" }, encrypting)).toBeNull();
  });

  // Review 2026-10-10: the fresh path refuses a plaintext upload into a room
  // that requires encryption while its keys load; the reuse path did not.
  it("does not reuse a plaintext upload where the room requires encryption", () => {
    const noKeysYet = { canBeEncrypt: () => false, requiresEncryption: () => true };
    expect(reusableUpload({ status: "uploaded", remoteUrl: "mxc://s/f" }, noKeysYet)).toBeNull();
  });

  it("does not reuse an unfinished upload", () => {
    expect(reusableUpload({ status: "uploading", encryptionSecrets: { k: 1 } }, encrypting)).toBeNull();
    expect(reusableUpload({ status: "uploaded" }, plain)).toBeNull();
  });
});

// --- Integration: the retry after a failed event PUT ---------------------------

const mockMatrix = {
  sendEncryptedText: vi.fn<(roomId: string, content: unknown, txnId?: string) => Promise<string>>(),
  uploadContent: vi.fn<(blob: Blob, progress?: unknown, signal?: AbortSignal) => Promise<string>>(),
};
vi.mock("@/entities/matrix", () => ({ getMatrixClientService: () => mockMatrix }));

class TestDb extends Dexie {
  messages!: Dexie.Table<LocalMessage, number>;
  rooms!: Dexie.Table<LocalRoom, string>;
  pendingOps!: Dexie.Table<PendingOperation, number>;
  attachments!: Dexie.Table<LocalAttachment, number>;
  users!: Dexie.Table<{ address: string }, string>;
  syncState!: Dexie.Table<{ key: string; value: string | number }, string>;
  decryptionQueue!: Dexie.Table<{ id?: number; status: string }, number>;
  listenedMessages!: Dexie.Table<{ messageId: string }, string>;

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

describe("syncSendFile retry after the upload finished (audit W2C-05)", () => {
  let h: { db: TestDb; engine: SyncEngine } | undefined;

  afterEach(async () => {
    if (h) await disposeSyncEngineHarness(h);
    h = undefined;
  });

  it("sends the finished upload instead of uploading the file again", async () => {
    vi.clearAllMocks();
    const db = new TestDb(`stuck-upload-${Date.now()}-${Math.random()}`);
    await db.open();
    const messageRepo = {
      confirmSent: vi.fn(async () => undefined),
      confirmMediaSent: vi.fn(async () => undefined),
      updateStatus: vi.fn(async () => undefined),
      getByEventId: vi.fn(async () => undefined),
      getByClientId: vi.fn(async () => undefined),
      updateUploadProgress: vi.fn(async () => undefined),
    };
    const roomRepo = { updateRoom: vi.fn(async () => undefined), syncLastMessageLocalStatus: vi.fn(async () => undefined) };
    const engine = new SyncEngine(db as never, messageRepo as never, roomRepo as never, vi.fn(async () => undefined) as never);
    h = { db, engine };

    mockMatrix.uploadContent.mockResolvedValue("mxc://server/uploaded");
    // The first event PUT fails after the upload; the retry succeeds.
    mockMatrix.sendEncryptedText.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValue("$event");

    const attachmentId = await db.attachments.add({
      messageLocalId: 1,
      fileName: "big.mp4",
      mimeType: "video/mp4",
      size: 100,
      localBlob: new Blob(["x".repeat(100)], { type: "video/mp4" }),
      status: "local",
    } as LocalAttachment);
    await db.pendingOps.add({
      type: "send_file",
      roomId: "!room:server",
      payload: { fileName: "big.mp4", mimeType: "video/mp4", msgtype: "m.video", attachmentId },
      status: "pending",
      retries: 0,
      maxRetries: 5,
      createdAt: Date.now(),
      clientId: "cli_big",
      nextAttemptAt: 0,
    } as PendingOperation);

    await engine.processQueue();
    await vi.waitFor(async () => expect(await db.pendingOps.count()).toBe(0), { timeout: 15_000, interval: 50 });

    expect(mockMatrix.uploadContent).toHaveBeenCalledTimes(1);
    expect(mockMatrix.sendEncryptedText).toHaveBeenCalledTimes(2);
    const lastContent = mockMatrix.sendEncryptedText.mock.calls.at(-1)![1] as { url?: string };
    expect(lastContent.url).toBe("mxc://server/uploaded");
  }, 20_000);
});
