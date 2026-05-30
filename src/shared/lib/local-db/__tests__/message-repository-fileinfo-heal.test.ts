import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Dexie from "dexie";
import "fake-indexeddb/auto";
import { MessageRepository } from "../message-repository";
import type { ChatDatabase, LocalMessage } from "../schema";
import { MessageType } from "@/entities/chat/model/types";

/**
 * Regression coverage for WEE-40 (second wave): the optimistic path in
 * `use-messages.ts` writes `fileInfo.url = localBlobUrl` (a `blob:` URL)
 * into Dexie at send time. If the Matrix `/sync` echo wins the race
 * against `confirmMediaSent` — or the queue's catch branch drops the op
 * because the row is already "synced" (the WEE-40 race guard) —
 * `confirmMediaSent` never runs and `fileInfo.url` stays `blob:` forever.
 * After a page reload the bubble fast-fails through `downloadAndDecrypt`'s
 * blob-guard and the user sees a misleading "Файл повреждён или не пришёл
 * с источника" toast on a message that actually reached the peer.
 *
 * Fix: `upsertFromServer` and `bulkInsert` self-heal — they accept the
 * server-side `fileInfo` (carrying `mxc://` or `http(s)://`) whenever the
 * local copy still holds a `blob:`/`data:` URL.
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

describe("MessageRepository.upsertFromServer — fileInfo self-heal (WEE-40)", () => {
  let db: TestDb;
  let repo: MessageRepository;

  beforeEach(async () => {
    db = new TestDb(`heal-${Date.now()}-${Math.random()}`);
    await db.open();
    repo = new MessageRepository(db as unknown as ChatDatabase);
  });

  afterEach(async () => {
    await db.delete();
  });

  it("replaces optimistic blob: fileInfo URL with the server mxc:// URL from /sync echo", async () => {
    // Local optimistic insert (mimics createLocal in use-messages.ts)
    const clientId = "client_abc";
    await db.messages.add(
      makeLocalMsg({
        clientId,
        status: "synced", // echo already flipped the row to synced
        eventId: null,
        fileInfo: {
          name: "photo.jpg",
          type: "image/jpeg",
          size: 2048,
          url: "blob:http://localhost:5173/optimistic-photo",
        },
      }),
    );

    // /sync echo carries the server-side fileInfo
    const echo = makeLocalMsg({
      clientId,
      eventId: "$server_event",
      status: "synced",
      fileInfo: {
        name: "photo.jpg",
        type: "image/jpeg",
        size: 2048,
        url: "mxc://server/abc123",
        secrets: { block: 1, keys: "deadbeef", v: 1 },
      },
    });

    const result = await repo.upsertFromServer(echo);
    expect(result).toBe("updated");

    const updated = await repo.getByClientId(clientId);
    expect(updated?.fileInfo?.url).toBe("mxc://server/abc123");
    expect(updated?.fileInfo?.secrets).toEqual({ block: 1, keys: "deadbeef", v: 1 });
    expect(updated?.eventId).toBe("$server_event");
    expect(updated?.status).toBe("synced");
  });

  it("does NOT overwrite a healthy mxc:// fileInfo URL on subsequent echoes", async () => {
    // After confirmMediaSent has already written the real URL.
    const clientId = "client_def";
    await db.messages.add(
      makeLocalMsg({
        clientId,
        status: "synced",
        eventId: "$server_event",
        fileInfo: {
          name: "doc.pdf",
          type: "application/pdf",
          size: 4096,
          url: "mxc://server/realurl",
          secrets: { block: 1, keys: "originalkey", v: 1 },
        },
      }),
    );

    // A re-delivery of the same echo (or a slightly stale snapshot).
    const reEcho = makeLocalMsg({
      clientId,
      eventId: "$server_event",
      status: "synced",
      fileInfo: {
        name: "doc.pdf",
        type: "application/pdf",
        size: 4096,
        url: "mxc://server/realurl",
        secrets: { block: 1, keys: "shouldNotReplace", v: 1 },
      },
    });

    await repo.upsertFromServer(reEcho);
    const after = await repo.getByClientId(clientId);
    // Existing fileInfo with a real URL is the source of truth — must not
    // be rewritten on every echo.
    expect(after?.fileInfo?.secrets).toEqual({ block: 1, keys: "originalkey", v: 1 });
  });

  it("heals fileInfo even when the upload is still in flight (localBlobUrl present)", async () => {
    // Mid-upload state: localBlobUrl still set, status=pending. The
    // existing in-flight branch must NOT lose the chance to heal — if
    // the echo arrives with a real URL, store it now so any later
    // reload sees a server URL.
    const clientId = "client_inflight";
    await db.messages.add(
      makeLocalMsg({
        clientId,
        status: "pending",
        eventId: null,
        localBlobUrl: "blob:http://localhost:5173/inflight",
        fileInfo: {
          name: "video.mp4",
          type: "video/mp4",
          size: 8192,
          url: "blob:http://localhost:5173/inflight",
        },
      }),
    );

    const echo = makeLocalMsg({
      clientId,
      eventId: "$inflight_evt",
      status: "synced",
      fileInfo: {
        name: "video.mp4",
        type: "video/mp4",
        size: 8192,
        url: "mxc://server/video123",
        secrets: { block: 2, keys: "vidkey", v: 1 },
      },
    });

    await repo.upsertFromServer(echo);
    const after = await repo.getByClientId(clientId);
    expect(after?.fileInfo?.url).toBe("mxc://server/video123");
    expect(after?.fileInfo?.secrets).toEqual({ block: 2, keys: "vidkey", v: 1 });
    // Status path for in-flight uploads stays as it was — confirmMediaSent
    // owns the pending → synced transition, the heal only touches fileInfo.
    expect(after?.status).toBe("pending");
    // localBlobUrl is preserved while the upload is still in flight (the
    // in-flight branch does not touch it).
    expect(after?.localBlobUrl).toBe("blob:http://localhost:5173/inflight");
  });

  it("heals when the local row has no fileInfo at all (defence in depth)", async () => {
    // An old row that somehow lost its fileInfo (legacy migration, corrupt
    // write) must still pick up the echo's server fileInfo — otherwise it
    // would render as a placeholder forever even though the server has
    // the real media.
    const clientId = "client_no_fileinfo";
    await db.messages.add(
      makeLocalMsg({
        clientId,
        status: "synced",
        eventId: "$prev",
        fileInfo: undefined,
      }),
    );

    const echo = makeLocalMsg({
      clientId,
      eventId: "$prev",
      status: "synced",
      fileInfo: {
        name: "recovered.jpg",
        type: "image/jpeg",
        size: 512,
        url: "mxc://server/recover",
      },
    });

    await repo.upsertFromServer(echo);
    const after = await repo.getByClientId(clientId);
    expect(after?.fileInfo?.url).toBe("mxc://server/recover");
    expect(after?.fileInfo?.name).toBe("recovered.jpg");
  });

  it("does not invent fileInfo when the echo carries no media payload", async () => {
    // Defence: a text echo with no fileInfo must not wipe out a media row's
    // existing fileInfo, and must not write `undefined` into the column.
    const clientId = "client_text_echo";
    await db.messages.add(
      makeLocalMsg({
        clientId,
        status: "synced",
        eventId: "$old",
        fileInfo: {
          name: "img.png",
          type: "image/png",
          size: 1024,
          url: "blob:http://localhost:5173/orphan",
        },
      }),
    );

    const echo = makeLocalMsg({
      clientId,
      eventId: "$old",
      status: "synced",
      // no fileInfo on the echo
    });

    await repo.upsertFromServer(echo);
    const after = await repo.getByClientId(clientId);
    // fileInfo stays exactly as it was — no overwrite with undefined.
    expect(after?.fileInfo?.name).toBe("img.png");
    expect(after?.fileInfo?.url).toBe("blob:http://localhost:5173/orphan");
  });
});

describe("MessageRepository.updateFileInfo — clears localBlobUrl (WEE-40)", () => {
  let db: TestDb;
  let repo: MessageRepository;

  beforeEach(async () => {
    db = new TestDb(`heal-update-${Date.now()}-${Math.random()}`);
    await db.open();
    repo = new MessageRepository(db as unknown as ChatDatabase);
  });

  afterEach(async () => {
    await db.delete();
  });

  it("nulls localBlobUrl so the mapper does not re-mask the healed url on next render", async () => {
    // Without clearing localBlobUrl, mappers.ts:33 (`url: local.localBlobUrl ||
    // local.fileInfo.url`) would resurface the dead blob: URL on every reload,
    // defeating the heal. The clear ensures the heal persists across renders.
    await db.messages.add(
      makeLocalMsg({
        clientId: "cli_clear",
        eventId: "$clear_evt",
        status: "synced",
        localBlobUrl: "blob:http://localhost:5173/zombie",
        fileInfo: {
          name: "photo.jpg",
          type: "image/jpeg",
          size: 2048,
          url: "blob:http://localhost:5173/zombie",
        },
      }),
    );

    await repo.updateFileInfo("$clear_evt", {
      name: "photo.jpg",
      type: "image/jpeg",
      size: 2048,
      url: "mxc://server/healed",
      secrets: { block: 1, keys: "healedkey", v: 1 },
    });

    const after = await repo.getByClientId("cli_clear");
    expect(after?.fileInfo?.url).toBe("mxc://server/healed");
    expect(after?.localBlobUrl).toBeUndefined();
  });
});

describe("MessageRepository.bulkInsert — fileInfo self-heal (WEE-40)", () => {
  let db: TestDb;
  let repo: MessageRepository;

  beforeEach(async () => {
    db = new TestDb(`heal-bulk-${Date.now()}-${Math.random()}`);
    await db.open();
    repo = new MessageRepository(db as unknown as ChatDatabase);
  });

  afterEach(async () => {
    await db.delete();
  });

  it("upgrades a pending local row's fileInfo from blob: to mxc:// on timeline replay", async () => {
    const clientId = "client_bulk";
    await db.messages.add(
      makeLocalMsg({
        clientId,
        status: "pending",
        eventId: null,
        fileInfo: {
          name: "photo.jpg",
          type: "image/jpeg",
          size: 2048,
          url: "blob:http://localhost:5173/bulk-photo",
        },
      }),
    );

    const incoming = makeLocalMsg({
      clientId,
      eventId: "$bulk_evt",
      status: "synced",
      fileInfo: {
        name: "photo.jpg",
        type: "image/jpeg",
        size: 2048,
        url: "mxc://server/bulkphoto",
        secrets: { block: 1, keys: "bulkkey", v: 1 },
      },
    });

    await repo.bulkInsert([incoming]);

    const after = await repo.getByClientId(clientId);
    expect(after?.fileInfo?.url).toBe("mxc://server/bulkphoto");
    expect(after?.fileInfo?.secrets).toEqual({ block: 1, keys: "bulkkey", v: 1 });
    expect(after?.eventId).toBe("$bulk_evt");
    expect(after?.status).toBe("synced");
  });
});
