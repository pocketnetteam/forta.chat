import { describe, it, expect, afterEach } from "vitest";
import "fake-indexeddb/auto";
import Dexie from "dexie";
import { ChatDatabase } from "../schema";
import { MessageType } from "@/entities/chat/model/types";

/**
 * Regression: version(19) migration (schema.ts) re-queues group messages
 * permanently stuck "[encrypted]" because of the aeskeys cache-collision bug
 * (matrix-crypto.ts — a stale derived AES key could get reused for the rest
 * of a room's session). Those messages exhausted MAX_ATTEMPTS and reached
 * the terminal decryptionStatus "failed", which the normal recovery sweeps
 * deliberately never resurrect on their own (see DecryptionWorker docs) —
 * only this one-time migration gives them another chance now that the
 * underlying cache bug is fixed.
 *
 * This seeds a real IndexedDB at the pre-migration (version 18) schema via
 * fake-indexeddb, then opens ChatDatabase (which declares versions through
 * 19) against the same database name so Dexie actually runs the upgrade —
 * a behavioral test, not just a source-shape check, since the migration
 * only runs once and a bug in it silently strands the exact users it's
 * meant to recover.
 */

const VERSION_18_STORES = {
  rooms: "id, updatedAt, membership, isDeleted",
  messages: "++localId, eventId, clientId, [roomId+timestamp], [roomId+status], senderId",
  users: "address, updatedAt, aliasUpdatedAt",
  pendingOps: "++id, [roomId+createdAt], status, clientId, [status+nextAttemptAt]",
  syncState: "key",
  attachments: "++id, messageLocalId, status",
  decryptionQueue: "++id, eventId, roomId, status, [status+nextAttemptAt]",
  listenedMessages: "messageId",
  searchCache: "query, expiresAt",
  channels: "address, syncOrder, updatedAt",
  mediaCacheIndex: "mxc, accessedAt, roomId, category",
  mediaCacheBlobs: "mxc",
  callProviders: "++id",
  aiChats: "id, updatedAt",
  aiMessages: "++localId, id, [chatId+createdAt]",
};

function makeMinimalRoom(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: "Room",
    isGroup: true,
    members: [],
    membership: "join",
    unreadCount: 0,
    lastReadInboundTs: 0,
    lastReadOutboundTs: 0,
    updatedAt: Date.now(),
    syncedAt: Date.now(),
    hasMoreHistory: true,
    isDeleted: false,
    deletedAt: null,
    deleteReason: null,
    ...overrides,
  };
}

function makeMinimalMessage(roomId: string, overrides: Record<string, unknown> = {}) {
  return {
    eventId: `$${Math.random().toString(36).slice(2)}`,
    clientId: Math.random().toString(36).slice(2),
    roomId,
    senderId: "addr1",
    content: "[encrypted]",
    timestamp: Date.now(),
    type: MessageType.text,
    status: "synced",
    softDeleted: false,
    version: 1,
    ...overrides,
  };
}

describe("schema.ts version(19) migration — heal aeskeys-cache-collision decrypt failures", () => {
  let dbName: string;

  afterEach(async () => {
    if (dbName) {
      await new Dexie(dbName).delete();
    }
  });

  it("resets terminal 'failed' messages with a preserved ciphertext back to 'pending', and clears the room's stale decryption flag", async () => {
    dbName = `bastyon-chat-aeskeys-heal-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // Seed a pre-migration (version 18) database directly with Dexie.
    const legacy = new Dexie(dbName);
    legacy.version(18).stores(VERSION_18_STORES);
    await legacy.open();

    await legacy.table("rooms").put(
      makeMinimalRoom("!group:test", { lastMessageDecryptionStatus: "failed" }),
    );

    const deadMsg = makeMinimalMessage("!group:test", {
      decryptionStatus: "failed",
      encryptedBody: JSON.stringify({ content: { hash: "abc", body: "cipher" } }),
    });
    const deadLocalId = await legacy.table("messages").add(deadMsg);

    // Control row: also "failed", but no encryptedBody left (nothing to
    // retry with) — must be left untouched.
    const noBodyMsg = makeMinimalMessage("!group:test", {
      decryptionStatus: "failed",
    });
    const noBodyLocalId = await legacy.table("messages").add(noBodyMsg);

    // Control row: "failed" + has encryptedBody, but soft-deleted — must be
    // left untouched (matches the version(5) precedent of excluding these).
    const deletedMsg = makeMinimalMessage("!group:test", {
      decryptionStatus: "failed",
      encryptedBody: JSON.stringify({ content: { hash: "abc", body: "cipher" } }),
      softDeleted: true,
    });
    const deletedLocalId = await legacy.table("messages").add(deletedMsg);

    // Control row: already "ok" — untouched.
    const okMsg = makeMinimalMessage("!group:test", {
      decryptionStatus: "ok",
      content: "hello",
    });
    const okLocalId = await legacy.table("messages").add(okMsg);

    legacy.close();

    // Extract the userId ChatDatabase's constructor would prefix onto
    // "bastyon-chat-" so it opens the exact same underlying database.
    const userId = dbName.replace(/^bastyon-chat-/, "");
    const db = new ChatDatabase(userId);
    await db.open();

    const healedMsg = await db.messages.get(deadLocalId as number);
    expect(healedMsg?.decryptionStatus).toBe("pending");

    const untouchedNoBody = await db.messages.get(noBodyLocalId as number);
    expect(untouchedNoBody?.decryptionStatus).toBe("failed");

    const untouchedDeleted = await db.messages.get(deletedLocalId as number);
    expect(untouchedDeleted?.decryptionStatus).toBe("failed");

    const untouchedOk = await db.messages.get(okLocalId as number);
    expect(untouchedOk?.decryptionStatus).toBe("ok");

    const healedRoom = await db.rooms.get("!group:test");
    expect(healedRoom?.lastMessageDecryptionStatus).toBeUndefined();

    db.close();
  });

  it("is a no-op when there are no terminally-failed messages with a preserved ciphertext", async () => {
    dbName = `bastyon-chat-aeskeys-heal-noop-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const legacy = new Dexie(dbName);
    legacy.version(18).stores(VERSION_18_STORES);
    await legacy.open();

    await legacy.table("rooms").put(makeMinimalRoom("!fine:test"));
    const okLocalId = await legacy.table("messages").add(
      makeMinimalMessage("!fine:test", { decryptionStatus: "ok", content: "hi" }),
    );
    legacy.close();

    const userId = dbName.replace(/^bastyon-chat-/, "");
    const db = new ChatDatabase(userId);
    await db.open();

    const msg = await db.messages.get(okLocalId as number);
    expect(msg?.decryptionStatus).toBe("ok");

    db.close();
  });
});
