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
} from "./schema";

export { localToMessage, localToMessages, messageStatusToLocal } from "./mappers";
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
import type { PcryptoRoomInstance } from "@/entities/matrix/model/matrix-crypto";

export interface ChatDbKit {
  db: ChatDatabase;
  messages: MessageRepository;
  rooms: RoomRepository;
  users: UserRepository;
  syncEngine: SyncEngine;
  eventWriter: EventWriter;
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
  const syncEngine = new SyncEngine(db, messages, rooms, getRoomCrypto, onChange);
  const eventWriter = new EventWriter(db, messages, rooms, users, onChange);

  currentKit = { db, messages, rooms, users, syncEngine, eventWriter };
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
