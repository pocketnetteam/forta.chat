import type { ChatDatabase } from "./schema";

/**
 * Repository for persisting voice message "listened" state.
 * Uses the listenedMessages Dexie table (messageId as PK).
 */
export class ListenedRepository {
  constructor(private db: ChatDatabase) {}

  /** Mark a voice message as listened */
  async markListened(messageId: string): Promise<void> {
    await this.db.listenedMessages.put({ messageId });
  }

  /** Check if a single message has been listened to */
  async isListened(messageId: string): Promise<boolean> {
    const entry = await this.db.listenedMessages.get(messageId);
    return entry !== undefined;
  }

  /** Batch check: returns a Set of messageIds that have been listened to */
  async getListenedSet(messageIds: string[]): Promise<Set<string>> {
    if (messageIds.length === 0) return new Set();
    const found = await this.db.listenedMessages
      .where("messageId")
      .anyOf(messageIds)
      .toArray();
    return new Set(found.map((entry) => entry.messageId));
  }
}
