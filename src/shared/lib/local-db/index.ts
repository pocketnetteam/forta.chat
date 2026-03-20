// ---------------------------------------------------------------------------
// Local-first chat database — barrel export
// ---------------------------------------------------------------------------

export { ChatDatabase } from "./schema";
export { useLiveQuery } from "./use-live-query";
export type {
  LocalRoom,
  LocalMessage,
  LocalMessageStatus,
  LocalUser,
  PendingOperation,
  OperationType,
  SyncStateEntry,
  LocalAttachment,
  DecryptionJob,
  ListenedMessage,
} from "./schema";
export { DecryptionWorker } from "./decryption-worker";
export { ListenedRepository } from "./listened-repository";

export { localToMessage, localToMessages, localStatusToMessageStatus, deriveOutboundStatus } from "./mappers";
export { MessageRepository } from "./message-repository";
export { RoomRepository } from "./room-repository";
export { UserRepository } from "./user-repository";
export { SyncEngine } from "./sync-engine";
export { EventWriter } from "./event-writer";
export type {
  ParsedMessage,
  ParsedReaction,
  ParsedEdit,
  ParsedRedaction,
  ParsedReceipt,
} from "./event-writer";

// ---------------------------------------------------------------------------
// Singleton management — one ChatDatabase instance per logged-in user
// ---------------------------------------------------------------------------

import { ChatDatabase } from "./schema";
import { MessageRepository } from "./message-repository";
import { RoomRepository } from "./room-repository";
import { UserRepository } from "./user-repository";
import { SyncEngine } from "./sync-engine";
import { EventWriter } from "./event-writer";
import { DecryptionWorker } from "./decryption-worker";
import { ListenedRepository } from "./listened-repository";
import type { PcryptoRoomInstance } from "@/entities/matrix/model/matrix-crypto";

export interface ChatDbKit {
  db: ChatDatabase;
  messages: MessageRepository;
  rooms: RoomRepository;
  users: UserRepository;
  syncEngine: SyncEngine;
  eventWriter: EventWriter;
  decryptionWorker: DecryptionWorker;
  listened: ListenedRepository;
}

let currentKit: ChatDbKit | null = null;
let currentUserId: string | null = null;

/**
 * Initialize (or re-initialize) the local-first chat database for a user.
 *
 * Call this after login, when `authStore.address` is available.
 * If the userId changes, the previous database is closed and a new one opened.
 *
 * @param userId  Bastyon hex address (used to namespace the DB: `bastyon-chat-{userId}`)
 * @param getRoomCrypto  Function to get Pcrypto room instance for encryption
 * @param onChange  Optional callback invoked when a room's data changes
 */
export function initChatDb(
  userId: string,
  getRoomCrypto: (roomId: string) => Promise<PcryptoRoomInstance | undefined>,
  onChange?: (roomId: string) => void,
): ChatDbKit {
  // If same user, return existing kit
  if (currentKit && currentUserId === userId) {
    return currentKit;
  }

  // Close previous DB if switching users
  if (currentKit) {
    currentKit.db.close();
    currentKit = null;
    currentUserId = null;
  }

  const db = new ChatDatabase(userId);
  const messages = new MessageRepository(db);
  const rooms = new RoomRepository(db);
  const users = new UserRepository(db);
  const listened = new ListenedRepository(db);
  const syncEngine = new SyncEngine(db, messages, rooms, getRoomCrypto, onChange);
  const eventWriter = new EventWriter(db, messages, rooms, users, onChange);
  const decryptionWorker = new DecryptionWorker(db, async (roomId: string) => {
    const crypto = await getRoomCrypto(roomId);
    if (!crypto) return undefined;
    return { decryptEvent: (raw: unknown) => crypto.decryptEvent(raw as Record<string, unknown>) };
  }, rooms);

  // Start processing any pending decryption jobs from previous session
  decryptionWorker.tick().catch(() => {});

  // Post-migration: re-fetch and enqueue cross-device messages marked by v5 migration.
  // These have content="[encrypted]", decryptionStatus="pending", but no encryptedBody.
  // We need to fetch the raw event from the server to enable DecryptionWorker to process them.
  healCrossDeviceMessages(db, messages, decryptionWorker, getRoomCrypto).catch((e) => {
    console.warn("[local-db] Cross-device heal sweep failed:", e);
  });

  // Garbage-collect tombstoned rooms older than 30 days (non-blocking)
  rooms.garbageCollectTombstones().catch((e) => {
    console.warn("[local-db] Tombstone GC failed:", e);
  });

  currentKit = { db, messages, rooms, users, syncEngine, eventWriter, decryptionWorker, listened };
  currentUserId = userId;

  return currentKit;
}

/**
 * Get the current ChatDbKit. Throws if not initialized.
 * Use this in composables/stores after login.
 */
export function getChatDb(): ChatDbKit {
  if (!currentKit) {
    throw new Error("[local-db] ChatDatabase not initialized. Call initChatDb() after login.");
  }
  return currentKit;
}

/**
 * Check if the local DB is initialized.
 */
export function isChatDbReady(): boolean {
  return currentKit !== null;
}

/**
 * Destroy the local DB instance (on logout).
 * Closes the Dexie connection but does NOT delete data.
 * Call `deleteChatDb()` to also wipe all local data.
 */
export function closeChatDb(): void {
  if (currentKit) {
    currentKit.decryptionWorker.dispose();
    currentKit.db.close();
    currentKit = null;
    currentUserId = null;
  }
}

/**
 * Delete all local data for the current user (GDPR, "clear data" button).
 * Also closes the connection.
 */
export async function deleteChatDb(): Promise<void> {
  if (currentKit) {
    await currentKit.db.delete();
    currentKit = null;
    currentUserId = null;
  }
}

// ---------------------------------------------------------------------------
// Post-migration self-healing for cross-device sync bug
// ---------------------------------------------------------------------------

const HEAL_BATCH_SIZE = 50;
const HEAL_CONCURRENCY = 5;

/**
 * After v5 migration marks broken messages as "[encrypted]" + "pending",
 * this function tries to re-decrypt them by fetching raw events from the server.
 * Runs once per session, non-blocking.
 */
async function healCrossDeviceMessages(
  db: ChatDatabase,
  messageRepo: MessageRepository,
  decryptionWorker: DecryptionWorker,
  getRoomCrypto: (roomId: string) => Promise<PcryptoRoomInstance | undefined>,
): Promise<void> {
  // Check if we already ran this heal in this session (use syncState as flag)
  const healKey = "cross_device_heal_v5";
  const healFlag = await db.syncState.get(healKey);
  if (healFlag) return;

  // Find messages that were marked by v5 migration:
  // content="[encrypted]", decryptionStatus="pending", no encryptedBody
  const brokenMessages = await db.messages
    .filter((m) =>
      m.content === "[encrypted]" &&
      m.decryptionStatus === "pending" &&
      !m.encryptedBody &&
      m.eventId !== null &&
      m.eventId.startsWith("$") &&
      !m.softDeleted
    )
    .limit(HEAL_BATCH_SIZE)
    .toArray();

  if (brokenMessages.length === 0) {
    await db.syncState.put({ key: healKey, value: Date.now() });
    return;
  }

  console.log(`[local-db] Healing ${brokenMessages.length} cross-device messages...`);

  let healed = 0;
  let enqueued = 0;

  // Process in small concurrent batches
  for (let i = 0; i < brokenMessages.length; i += HEAL_CONCURRENCY) {
    const batch = brokenMessages.slice(i, i + HEAL_CONCURRENCY);
    await Promise.allSettled(batch.map(async (msg) => {
      try {
        const roomCrypto = await getRoomCrypto(msg.roomId);
        if (!roomCrypto) {
          // Can't decrypt now — enqueue for DecryptionWorker retry later
          // We need raw event body, but don't have it. Skip for now.
          return;
        }

        // Try to fetch the raw event from Matrix server via the SDK
        // The roomCrypto object has access to the Matrix client
        // We'll try to decrypt using the event ID lookup
        const rawEvent = await fetchRawEventFromServer(msg.roomId, msg.eventId!);
        if (!rawEvent) return;

        try {
          const result = await roomCrypto.decryptEvent(rawEvent);
          // Success — update the message directly
          await db.messages.update(msg.localId!, {
            content: result.body,
            decryptionStatus: "ok",
            encryptedBody: undefined,
          });
          healed++;
        } catch {
          // Decryption failed — enqueue for retry with raw body
          await decryptionWorker.enqueue(
            msg.eventId!,
            msg.roomId,
            JSON.stringify(rawEvent),
          );
          // Also store encryptedBody on the message for future retries
          await db.messages.update(msg.localId!, {
            encryptedBody: JSON.stringify(rawEvent),
          });
          enqueued++;
        }
      } catch {
        // Non-critical — skip this message
      }
    }));
  }

  const unprocessed = brokenMessages.length - (healed + enqueued);
  console.log(`[local-db] Cross-device heal: ${healed} decrypted, ${enqueued} enqueued, ${unprocessed} skipped`);

  // Only mark as done if all messages were processed (or none needed processing).
  // If crypto/server was unavailable, leave the flag unset so we retry next session.
  if (unprocessed === 0) {
    await db.syncState.put({ key: healKey, value: Date.now() });
  }
}

/**
 * Fetch a raw event from the Matrix server by room ID and event ID.
 * Uses fetchEventContext to get timeline events, then finds the target.
 */
async function fetchRawEventFromServer(
  roomId: string,
  eventId: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const { getMatrixClientService } = await import("@/entities/matrix/model/matrix-client");
    const matrixService = getMatrixClientService();

    const events = await matrixService.fetchEventContext(roomId, eventId, 5);
    // Find the target event in the returned timeline
    for (const evt of events) {
      const raw = (evt as any)?.event ?? evt;
      if (raw?.event_id === eventId) {
        return raw as Record<string, unknown>;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}
