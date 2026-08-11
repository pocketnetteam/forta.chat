import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Dexie from "dexie";
import "fake-indexeddb/auto";
import { AiChatRepository } from "./ai-chat-repository";
import { AiMessageRepository } from "./ai-message-repository";
import type { LocalAiChat, LocalAiMessage } from "./schema";

class TestDb extends Dexie {
  aiChats!: import("dexie").Table<LocalAiChat, string>;
  aiMessages!: import("dexie").Table<LocalAiMessage, number>;
  constructor() {
    super("test-ai-chat-repo", { indexedDB, IDBKeyRange });
    this.version(1).stores({
      aiChats: "id, updatedAt",
      aiMessages: "++localId, id, [chatId+createdAt]",
    });
  }
}

function makeChat(over: Partial<LocalAiChat> = {}): LocalAiChat {
  return {
    id: over.id ?? "chat_default",
    title: over.title ?? "New chat",
    createdAt: over.createdAt ?? Date.now(),
    updatedAt: over.updatedAt ?? Date.now(),
    ...over,
  };
}

describe("AiChatRepository", () => {
  let db: TestDb;
  let messages: AiMessageRepository;
  let repo: AiChatRepository;

  beforeEach(() => {
    db = new TestDb();
    messages = new AiMessageRepository(db as never);
    repo = new AiChatRepository(db as never, messages);
  });

  afterEach(async () => {
    await db.delete();
  });

  it("getAll returns chats sorted by updatedAt, most recent first", async () => {
    await db.aiChats.bulkAdd([
      makeChat({ id: "a", updatedAt: 100 }),
      makeChat({ id: "b", updatedAt: 300 }),
      makeChat({ id: "c", updatedAt: 200 }),
    ]);

    const result = await repo.getAll();

    expect(result.map((c) => c.id)).toEqual(["b", "c", "a"]);
  });

  it("getAll returns an empty array when no chats are persisted", async () => {
    expect(await repo.getAll()).toEqual([]);
  });

  it("get returns a single chat by id", async () => {
    await db.aiChats.add(makeChat({ id: "a", title: "Hello" }));
    expect((await repo.get("a"))?.title).toBe("Hello");
  });

  it("get returns undefined for an unknown id", async () => {
    expect(await repo.get("missing")).toBeUndefined();
  });

  it("create persists a new chat", async () => {
    await repo.create(makeChat({ id: "a", title: "First chat" }));
    expect((await repo.get("a"))?.title).toBe("First chat");
  });

  it("rename updates title and bumps updatedAt", async () => {
    await repo.create(makeChat({ id: "a", title: "Old", updatedAt: 1 }));

    await repo.rename("a", "New title");

    const chat = await repo.get("a");
    expect(chat?.title).toBe("New title");
    expect(chat?.updatedAt).toBeGreaterThan(1);
  });

  it("touch bumps updatedAt and applies preview patch", async () => {
    await repo.create(makeChat({ id: "a", updatedAt: 1 }));

    await repo.touch("a", { lastMessagePreview: "Hi there", lastMessageTimestamp: 12345 });

    const chat = await repo.get("a");
    expect(chat?.lastMessagePreview).toBe("Hi there");
    expect(chat?.lastMessageTimestamp).toBe(12345);
    expect(chat?.updatedAt).toBeGreaterThan(1);
  });

  it("touch with no patch still bumps updatedAt", async () => {
    await repo.create(makeChat({ id: "a", updatedAt: 1 }));
    await repo.touch("a");
    expect((await repo.get("a"))!.updatedAt).toBeGreaterThan(1);
  });

  it("delete removes the chat and cascades to its messages (no orphans)", async () => {
    await repo.create(makeChat({ id: "a" }));
    await repo.create(makeChat({ id: "b" }));
    await messages.create({ id: "m1", chatId: "a", role: "user", content: "hi", status: "complete", createdAt: 1 });
    await messages.create({ id: "m2", chatId: "a", role: "assistant", content: "hello", status: "complete", createdAt: 2 });
    await messages.create({ id: "m3", chatId: "b", role: "user", content: "unrelated", status: "complete", createdAt: 3 });

    await repo.delete("a");

    expect(await repo.get("a")).toBeUndefined();
    expect(await messages.listByChat("a")).toEqual([]);
    // Sibling chat's messages are untouched
    expect(await messages.listByChat("b")).toHaveLength(1);
  });

  it("delete of a chat with no messages does not throw", async () => {
    await repo.create(makeChat({ id: "a" }));
    await expect(repo.delete("a")).resolves.toBeUndefined();
  });
});
