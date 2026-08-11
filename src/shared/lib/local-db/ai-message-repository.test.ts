import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Dexie from "dexie";
import "fake-indexeddb/auto";
import { AiMessageRepository } from "./ai-message-repository";
import type { LocalAiMessage } from "./schema";

class TestDb extends Dexie {
  aiMessages!: import("dexie").Table<LocalAiMessage, number>;
  constructor() {
    super("test-ai-message-repo", { indexedDB, IDBKeyRange });
    this.version(1).stores({
      aiMessages: "++localId, id, [chatId+createdAt]",
    });
  }
}

function makeMessage(over: Partial<LocalAiMessage> = {}): LocalAiMessage {
  return {
    id: over.id ?? "msg_default",
    chatId: over.chatId ?? "chat_default",
    role: over.role ?? "user",
    content: over.content ?? "hello",
    status: over.status ?? "complete",
    createdAt: over.createdAt ?? Date.now(),
    ...over,
  };
}

describe("AiMessageRepository", () => {
  let db: TestDb;
  let repo: AiMessageRepository;

  beforeEach(() => {
    db = new TestDb();
    repo = new AiMessageRepository(db as never);
  });

  afterEach(async () => {
    await db.delete();
  });

  it("listByChat returns messages of a chat in creation order", async () => {
    await db.aiMessages.bulkAdd([
      makeMessage({ id: "1", chatId: "a", createdAt: 100 }),
      makeMessage({ id: "2", chatId: "a", createdAt: 300 }),
      makeMessage({ id: "3", chatId: "a", createdAt: 200 }),
      makeMessage({ id: "4", chatId: "b", createdAt: 50 }),
    ]);

    const result = await repo.listByChat("a");

    expect(result.map((m) => m.id)).toEqual(["1", "3", "2"]);
  });

  it("listByChat returns an empty array for a chat with no messages", async () => {
    expect(await repo.listByChat("missing")).toEqual([]);
  });

  it("create persists a new message", async () => {
    await repo.create(makeMessage({ id: "m1", chatId: "a" }));
    const result = await repo.listByChat("a");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("m1");
  });

  it("updateContent patches content of an existing message by id", async () => {
    await repo.create(makeMessage({ id: "m1", chatId: "a", content: "partial" }));

    await repo.updateContent("m1", "partial token stream");

    const [msg] = await repo.listByChat("a");
    expect(msg.content).toBe("partial token stream");
  });

  it("updateContent is a no-op for an unknown id", async () => {
    await expect(repo.updateContent("missing", "x")).resolves.toBeUndefined();
  });

  it("updateStatus patches status and optional fields", async () => {
    await repo.create(makeMessage({ id: "m1", chatId: "a", status: "streaming", content: "" }));

    await repo.updateStatus("m1", "complete", { content: "final answer", tokenCount: 42 });

    const [msg] = await repo.listByChat("a");
    expect(msg.status).toBe("complete");
    expect(msg.content).toBe("final answer");
    expect(msg.tokenCount).toBe(42);
  });

  it("deleteByChat removes only that chat's messages", async () => {
    await db.aiMessages.bulkAdd([
      makeMessage({ id: "1", chatId: "a" }),
      makeMessage({ id: "2", chatId: "a" }),
      makeMessage({ id: "3", chatId: "b" }),
    ]);

    await repo.deleteByChat("a");

    expect(await repo.listByChat("a")).toEqual([]);
    expect(await repo.listByChat("b")).toHaveLength(1);
  });
});
