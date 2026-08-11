import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
import Dexie from "dexie";
import "fake-indexeddb/auto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LocalAiClient, LocalAiConfig } from "local-ai";
import {
  FakePlatformSupportAdapter,
  FakeDeviceInfoAdapter,
  FakeLlmRuntimeAdapter,
  FakeAppLifecycleAdapter,
  NodeFsAdapter,
  NodeSqliteAdapter,
  NodeRangeDownloadAdapter,
  SystemClockAdapter,
  WebCryptoHashAdapter,
} from "local-ai/adapters/node-testing";

import { useAiChatStore } from "./ai-chat-store";
import { useLocalAiStore } from "@/entities/local-ai";
import { AiChatRepository } from "@/shared/lib/local-db/ai-chat-repository";
import { AiMessageRepository } from "@/shared/lib/local-db/ai-message-repository";
import type { ChatDbKit } from "@/shared/lib/local-db";
import type { LocalAiChat, LocalAiMessage } from "@/shared/lib/local-db/schema";
import { useAuthStore } from "@/entities/auth/model/stores";

vi.mock("@/entities/auth/model/stores", () => ({
  useAuthStore: vi.fn(),
}));

const TEST_ADDRESS = "addr_test";

class TestDb extends Dexie {
  aiChats!: import("dexie").Table<LocalAiChat, string>;
  aiMessages!: import("dexie").Table<LocalAiMessage, number>;
  constructor() {
    super(`test-ai-chat-store-${Math.random().toString(36).slice(2)}`, { indexedDB, IDBKeyRange });
    this.version(1).stores({
      aiChats: "id, updatedAt",
      aiMessages: "++localId, id, [chatId+createdAt]",
    });
  }
}

function makeKit(db: TestDb): ChatDbKit {
  const aiMessages = new AiMessageRepository(db as never);
  const aiChats = new AiChatRepository(db as never, aiMessages);
  return { db, aiChats, aiMessages } as unknown as ChatDbKit;
}

function makeFakeConfig(): LocalAiConfig {
  const dir = mkdtempSync(path.join(tmpdir(), "ai-chat-store-test-"));
  return {
    manifestUrl: "https://test.invalid/manifest.json",
    ports: {
      platformSupport: new FakePlatformSupportAdapter({
        platform: "android",
        isNative: true,
        availablePlugins: ["LlamaCpp", "CapacitorSQLite", "CapacitorDownloader", "DeviceInfo"],
      }),
      deviceInfo: new FakeDeviceInfoAdapter({
        totalRamGb: 8,
        freeRamGb: 6,
        freeDiskBytes: 10e9,
        thermal: "nominal",
        lowPowerMode: false,
      }),
      downloadTransport: new NodeRangeDownloadAdapter(),
      fileSystem: new NodeFsAdapter(dir),
      sqlite: new NodeSqliteAdapter(":memory:"),
      llmRuntime: new FakeLlmRuntimeAdapter(),
      appLifecycle: new FakeAppLifecycleAdapter(),
      hash: new WebCryptoHashAdapter(),
      clock: new SystemClockAdapter(),
    },
  };
}

async function waitFor(fn: () => boolean | Promise<boolean>, timeout = 2000): Promise<void> {
  const start = Date.now();
  while (!(await fn())) {
    if (Date.now() - start > timeout) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * `client.sendMessage()` requires a genuinely loaded LLM runtime
 * (`ensureModelReady()` — full manifest+download+eligibility flow, out of
 * scope for a Node unit test, see `entities/local-ai`'s tests for that
 * boundary). What THIS store owns is Dexie<->local-ai mirroring — Mode B
 * orchestration, not inference — so this replaces only `sendMessage()`,
 * scripted like `FakeLlmRuntimeAdapter`, while every other call
 * (`upsertChat`/`appendMessages`/`getChat`/`getMessages`/`deleteChat`) stays
 * real against the fake-ported `LocalAiClient`'s real SQLite mirror. It also
 * reproduces `sendMessage()`'s own documented contract — the user message is
 * persisted via `appendMessages` before generation starts, and the final
 * assistant message is persisted the same way — so cross-checks against
 * `client.getMessages()` (roadmap 3.7's dedup test) stay meaningful.
 */
function scriptSendMessage(
  client: LocalAiClient,
  script: { tokens: string[]; outcome: "complete" | "error"; tokenCount?: number },
) {
  return vi.spyOn(client, "sendMessage").mockImplementation((chatId, text, options) => {
    const { userMessageId, assistantMessageId, signal } = options ?? {};
    const buffer: Array<{ token: string; accumulatedContent: string }> = [];
    const signal_: { resolve: (() => void) | null } = { resolve: null };
    let done = false;
    let accumulated = "";

    const produce = (async () => {
      if (userMessageId) {
        await client.appendMessages(chatId, [
          { id: userMessageId, role: "user", content: text, status: "complete", createdAt: new Date().toISOString() },
        ]);
      }
      for (const t of script.tokens) {
        // A few real ms between tokens (not 0) — tests that cancel mid-stream
        // need a genuine window to call cancelMessage() before all tokens
        // have already flushed (0ms timeouts can drain a short token list
        // faster than a `waitFor` poll notices the first one).
        await new Promise((r) => setTimeout(r, 5));
        if (signal?.aborted) break;
        accumulated += t;
        buffer.push({ token: t, accumulatedContent: accumulated });
        signal_.resolve?.();
      }
      done = true;
      signal_.resolve?.();
    })();

    async function* iterate() {
      let idx = 0;
      for (;;) {
        while (idx < buffer.length) yield buffer[idx++];
        if (done) return;
        await new Promise<void>((resolve) => { signal_.resolve = resolve; });
      }
    }

    const result = (async () => {
      await produce;
      const aborted = signal?.aborted ?? false;
      const status = aborted ? "cancelled" as const : script.outcome;
      const createdAt = new Date().toISOString();
      if (assistantMessageId) {
        await client.appendMessages(chatId, [
          { id: assistantMessageId, role: "assistant", content: accumulated, status, createdAt, tokenCount: script.tokenCount },
        ]);
      }
      return {
        id: assistantMessageId ?? "",
        chatId,
        role: "assistant" as const,
        content: accumulated,
        status,
        createdAt,
        tokenCount: script.tokenCount,
      };
    })();

    return { [Symbol.asyncIterator]: iterate, result };
  });
}

describe("useAiChatStore — Mode B over Dexie", () => {
  let db: TestDb;
  let store: ReturnType<typeof useAiChatStore>;
  let localAi: ReturnType<typeof useLocalAiStore>;

  beforeEach(async () => {
    setActivePinia(createTestingPinia({ stubActions: false }));
    vi.mocked(useAuthStore).mockReturnValue({ address: TEST_ADDRESS } as ReturnType<typeof useAuthStore>);

    db = new TestDb();
    store = useAiChatStore();
    store.setChatDbKit(makeKit(db));

    localAi = useLocalAiStore();
    // Pre-warm the client cache with fake ports so store-internal
    // `ensureClient(address)` calls (no override) hit the cached-client fast
    // path instead of trying to build real Capacitor adapters (roadmap 2.2's
    // node-testing-fakes approach, reused here for the Mode B integration).
    // `sendMessage()` itself is scripted per-test — see `scriptSendMessage`.
    await localAi.ensureClient(TEST_ADDRESS, makeFakeConfig());
  });

  it("createChat writes to Dexie immediately without requiring a local-ai client", async () => {
    await localAi.releaseRuntime(); // no client at all
    const chat = await store.createChat("Hello");
    expect(chat.title).toBe("Hello");
    expect((await db.aiChats.get(chat.id))?.title).toBe("Hello");
  });

  it("createChat defaults the title when none is given", async () => {
    const chat = await store.createChat();
    expect(chat.title).toBe("New chat");
  });

  it("selectChat mirrors the chat into local-ai in the background", async () => {
    const chat = await store.createChat("Mirrored");
    store.selectChat(chat.id);
    expect(store.activeChatId).toBe(chat.id);

    await waitFor(async () => (await localAi.client!.getChat(chat.id)) !== null);
    expect((await localAi.client!.getChat(chat.id))?.title).toBe("Mirrored");
  });

  it("sendMessage persists user+assistant messages and streams tokens into streamingContent", async () => {
    scriptSendMessage(localAi.client!, { tokens: ["Hel", "lo"], outcome: "complete", tokenCount: 2 });

    const chat = await store.createChat();
    await store.sendMessage(chat.id, "Hi there");

    const messages = await db.aiMessages.where("chatId").equals(chat.id).sortBy("createdAt");
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "user", content: "Hi there", status: "complete" });
    expect(messages[1]).toMatchObject({ role: "assistant", content: "Hello", status: "complete", tokenCount: 2 });

    // Streaming buffer is cleared once the turn settles.
    expect(store.streamingContent.has(chat.id)).toBe(false);
    expect(localAi.isGenerating).toBe(false);

    const updatedChat = await db.aiChats.get(chat.id);
    expect(updatedChat?.lastMessagePreview).toBe("Hello");
  });

  it("two concurrent sendMessage() calls (different chats) — the second is rejected by our own guard, not the library's RuntimeBusyError", async () => {
    scriptSendMessage(localAi.client!, { tokens: ["ok"], outcome: "complete" });
    const chatA = await store.createChat("A");
    const chatB = await store.createChat("B");

    // Fired back-to-back, no `await` in between — regression for the
    // isGenerating-claimed-too-late race (claimed synchronously now, before
    // any of sendMessage's own awaited setup steps).
    const first = store.sendMessage(chatA.id, "first");
    const second = store.sendMessage(chatB.id, "second");

    await expect(second).rejects.toThrow(/already generating/);
    await first;

    // Chat B never reached the runtime at all — no orphaned "error" message.
    expect(await db.aiMessages.where("chatId").equals(chatB.id).count()).toBe(0);
  });

  it("cancelMessage aborts generation; the assistant message ends 'cancelled' with partial content", async () => {
    scriptSendMessage(localAi.client!, { tokens: ["A", "B", "C", "D"], outcome: "complete" });

    const chat = await store.createChat();
    const sendPromise = store.sendMessage(chat.id, "Cancel me");

    await waitFor(() => (store.streamingContent.get(chat.id)?.length ?? 0) > 0);
    store.cancelMessage(chat.id);
    await sendPromise;

    const messages = await db.aiMessages.where("chatId").equals(chat.id).sortBy("createdAt");
    const assistant = messages[1];
    expect(assistant.status).toBe("cancelled");
    expect(assistant.content.length).toBeGreaterThan(0);
    expect(assistant.content.length).toBeLessThan("ABCD".length + 1);
    expect(localAi.isGenerating).toBe(false);
  });

  it("rejects sendMessage while another chat is generating, without leaving orphaned rows", async () => {
    localAi.isGenerating = true;
    const chat = await store.createChat();

    await expect(store.sendMessage(chat.id, "blocked")).rejects.toThrow();

    expect(await db.aiMessages.where("chatId").equals(chat.id).count()).toBe(0);
  });

  it("two sends in the same session do not duplicate messages in local-ai's mirror (roadmap 3.7)", async () => {
    scriptSendMessage(localAi.client!, { tokens: ["ok"], outcome: "complete" });
    const chat = await store.createChat();
    await store.sendMessage(chat.id, "first");
    await store.sendMessage(chat.id, "second");

    const mirrored = await localAi.client!.getMessages(chat.id);
    const ids = mirrored.map((m) => m.id);
    expect(ids.length).toBe(new Set(ids).size); // no duplicate ids
    expect(mirrored).toHaveLength(4); // 2 user + 2 assistant
  });

  it("switching between two chats does not lose either chat's history", async () => {
    scriptSendMessage(localAi.client!, { tokens: ["ok"], outcome: "complete" });
    const chatA = await store.createChat("A");
    await store.sendMessage(chatA.id, "hello from A");

    const chatB = await store.createChat("B");
    store.selectChat(chatB.id);
    await store.sendMessage(chatB.id, "hello from B");

    store.selectChat(chatA.id);
    expect(store.activeChatId).toBe(chatA.id);

    // Asserted via the repository (Dexie ground truth), not `store.messages`:
    // Dexie's `liveQuery()` — which `messages` is built on — never delivers
    // any emission under happy-dom + fake-indexeddb (verified directly
    // against plain `Dexie.liveQuery` with no app code involved at all) —
    // an environment limitation of this test setup, not a store bug. The
    // repository is what `messages`' querier calls under the hood anyway.
    const kit = makeKit(db);
    const messagesA = await kit.aiMessages.listByChat(chatA.id);
    const messagesB = await kit.aiMessages.listByChat(chatB.id);
    expect(messagesA.map((m) => m.content)).toEqual(["hello from A", "ok"]);
    expect(messagesB.map((m) => m.content)).toEqual(["hello from B", "ok"]);
  });

  it("deleteChat cascades in Dexie and mirrors the deletion to local-ai", async () => {
    scriptSendMessage(localAi.client!, { tokens: ["ok"], outcome: "complete" });
    const chat = await store.createChat();
    await store.sendMessage(chat.id, "to be deleted");
    store.selectChat(chat.id);
    await waitFor(async () => (await localAi.client!.getChat(chat.id)) !== null);

    await store.deleteChat(chat.id);

    expect(await db.aiChats.get(chat.id)).toBeUndefined();
    expect(await db.aiMessages.where("chatId").equals(chat.id).count()).toBe(0);
    await waitFor(async () => (await localAi.client!.getChat(chat.id)) === null);
  });

  it("renameChat updates Dexie and mirrors the title when a client exists", async () => {
    const chat = await store.createChat("Old title");
    store.selectChat(chat.id);
    await waitFor(async () => (await localAi.client!.getChat(chat.id)) !== null);

    await store.renameChat(chat.id, "New title");

    expect((await db.aiChats.get(chat.id))?.title).toBe("New title");
    await waitFor(async () => (await localAi.client!.getChat(chat.id))?.title === "New title");
  });

  it("cleanup() aborts in-flight generations and resets in-memory state", async () => {
    scriptSendMessage(localAi.client!, { tokens: ["A", "B", "C"], outcome: "complete" });
    const chat = await store.createChat();
    const sendPromise = store.sendMessage(chat.id, "abort via cleanup");
    await waitFor(() => (store.streamingContent.get(chat.id)?.length ?? 0) > 0);

    store.cleanup();
    await sendPromise;

    expect(store.activeChatId).toBeNull();
    expect(store.streamingContent.size).toBe(0);
  });

  // Roadmap 7.2 — logout during active generation. Mirrors the real order in
  // entities/auth/model/stores.ts's logout(): aiChatStore.cleanup() (aborts
  // in-flight generations) THEN localAiStore.releaseRuntime() (tears down
  // the client). Must not throw / leave a dangling unhandled rejection.
  it("logout mid-generation (cleanup() + releaseRuntime()) settles cleanly", async () => {
    scriptSendMessage(localAi.client!, { tokens: ["A", "B", "C", "D", "E"], outcome: "complete" });
    const chat = await store.createChat();
    const sendPromise = store.sendMessage(chat.id, "logout during this");
    await waitFor(() => (store.streamingContent.get(chat.id)?.length ?? 0) > 0);

    store.cleanup();
    await expect(localAi.releaseRuntime()).resolves.toBeUndefined();
    await expect(sendPromise).resolves.toBeUndefined();

    expect(localAi.client).toBeNull();
    expect(localAi.isGenerating).toBe(false);
    expect(store.activeChatId).toBeNull();

    // The teardown race is treated as a cancellation, not a generation
    // failure — no "error" status/toast for what was really a logout.
    const messages = await db.aiMessages.where("chatId").equals(chat.id).sortBy("createdAt");
    expect(messages[1].status).toBe("cancelled");
  });
});
