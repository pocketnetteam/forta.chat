import type { ChatDatabase, LocalAiChat } from "./schema";
import type { AiMessageRepository } from "./ai-message-repository";

/**
 * Persistence layer for AI-chat metadata shown in the sidebar's "AI" tab
 * (`local-ai` Mode B integration — see
 * docs/plans/llama2/2026-08-11-local-ai-integration-plan.md §3). Dexie is the
 * source of truth; `local-ai`'s internal SQLite only mirrors the same chat by
 * `id` to build prompts/session-cache.
 */
export class AiChatRepository {
  constructor(
    private db: ChatDatabase,
    private messages: AiMessageRepository,
  ) {}

  /** All AI chats, most recently active first. */
  async getAll(): Promise<LocalAiChat[]> {
    return this.db.aiChats.orderBy("updatedAt").reverse().toArray();
  }

  async get(id: string): Promise<LocalAiChat | undefined> {
    return this.db.aiChats.get(id);
  }

  async create(chat: LocalAiChat): Promise<void> {
    await this.db.aiChats.add(chat);
  }

  async rename(id: string, title: string): Promise<void> {
    await this.db.aiChats.update(id, { title, updatedAt: Date.now() });
  }

  /** Bump `updatedAt` and (optionally) the sidebar preview after a message
   *  is sent/received — mirrors `RoomRepository`'s preview-touch pattern. */
  async touch(
    id: string,
    patch: Partial<Pick<LocalAiChat, "lastMessagePreview" | "lastMessageTimestamp">> = {},
  ): Promise<void> {
    await this.db.aiChats.update(id, { ...patch, updatedAt: Date.now() });
  }

  /** Delete a chat and cascade-delete its messages in one Dexie transaction —
   *  never leaves orphaned rows in `aiMessages`. */
  async delete(id: string): Promise<void> {
    await this.db.transaction("rw", this.db.aiChats, this.db.aiMessages, async () => {
      await this.messages.deleteByChat(id);
      await this.db.aiChats.delete(id);
    });
  }
}
