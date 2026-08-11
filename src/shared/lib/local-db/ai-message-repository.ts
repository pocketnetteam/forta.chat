import Dexie from "dexie";
import type { ChatDatabase, LocalAiMessage } from "./schema";

/**
 * Persistence layer for AI-chat messages (`local-ai` Mode B integration).
 * Dexie is the source of truth for what the UI renders — `local-ai`'s
 * internal SQLite only mirrors these same rows (by `id`) to build prompts.
 * No SyncEngine, no encryption, no event-writer — those are Matrix-pipeline
 * concepts this table never touches.
 */
export class AiMessageRepository {
  constructor(private db: ChatDatabase) {}

  /** Messages of a chat in creation order (oldest first). */
  async listByChat(chatId: string): Promise<LocalAiMessage[]> {
    return this.db.aiMessages
      .where("[chatId+createdAt]")
      .between([chatId, Dexie.minKey], [chatId, Dexie.maxKey])
      .toArray();
  }

  async create(message: LocalAiMessage): Promise<void> {
    await this.db.aiMessages.add(message);
  }

  /** Patch a message's content by its `id` (shared with local-ai's
   *  userMessageId/assistantMessageId) — used for streaming checkpoints. */
  async updateContent(id: string, content: string): Promise<void> {
    const row = await this.db.aiMessages.where("id").equals(id).first();
    if (!row?.localId) return;
    await this.db.aiMessages.update(row.localId, { content });
  }

  async updateStatus(
    id: string,
    status: LocalAiMessage["status"],
    patch: Partial<Pick<LocalAiMessage, "content" | "tokenCount">> = {},
  ): Promise<void> {
    const row = await this.db.aiMessages.where("id").equals(id).first();
    if (!row?.localId) return;
    await this.db.aiMessages.update(row.localId, { status, ...patch });
  }

  /** Remove every message of a chat — used for cascade delete when the
   *  chat itself is removed (`AiChatRepository.delete`). */
  async deleteByChat(chatId: string): Promise<void> {
    await this.db.aiMessages.where("chatId").equals(chatId).delete();
  }
}
