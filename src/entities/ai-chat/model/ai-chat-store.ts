import { defineStore } from "pinia";
import { ref, shallowRef } from "vue";
import type { LocalAiClient } from "local-ai";

import { useAuthStore } from "@/entities/auth/model/stores";
import { useLocalAiStore } from "@/entities/local-ai";
import { useLiveQuery } from "@/shared/lib/local-db/use-live-query";
import type { ChatDbKit, LocalAiChat, LocalAiMessage } from "@/shared/lib/local-db";
import { tRaw } from "@/shared/lib/i18n";

function generateId(): string {
  return crypto.randomUUID();
}

/**
 * AI-chat store — Mode B over Dexie (plan §2/§3, roadmap Phase 3). Dexie
 * (`aiChats`/`aiMessages`) is the source of truth the UI renders; `local-ai`
 * only mirrors the same rows (by id) to build prompts/session-cache via
 * `entities/local-ai`'s `useLocalAiStore`. Not part of the Matrix pipeline —
 * no SyncEngine, no encryption.
 *
 * Mirrors `entities/chat`'s `chatDbKitRef`/`setChatDbKit` pattern: the Dexie
 * kit is injected after `initChatDb()` succeeds rather than read via a
 * module-level singleton, so this store stays testable with a fake kit.
 */
export const useAiChatStore = defineStore("ai-chat", () => {
  const chatDbKitRef = shallowRef<ChatDbKit | null>(null);
  const activeChatId = ref<string | null>(null);

  /** Live token buffer per chat — updated on every stream token, NOT written
   *  to Dexie per-token (plan §7.3's IndexedDB-write-frequency tradeoff).
   *  `AiChatView` overlays this on top of the (periodically checkpointed)
   *  Dexie row while the message's `status` is `'streaming'`. */
  const streamingContent = ref(new Map<string, string>());

  const abortControllers = new Map<string, AbortController>();
  /** Chats whose full history has been mirrored into local-ai this session —
   *  avoids re-sending the whole history before every `sendMessage` (plan
   *  §2's high-water-mark note, roadmap 3.3). In-memory only: local-ai's own
   *  mirror is gone too once the runtime is released (logout/account
   *  switch), so there is nothing to persist here. */
  const historySyncedChatIds = new Set<string>();

  function setChatDbKit(kit: ChatDbKit): void {
    chatDbKitRef.value = kit;
  }

  function getDbKit(): ChatDbKit {
    if (!chatDbKitRef.value) throw new Error("[ai-chat-store] ChatDatabase not initialized");
    return chatDbKitRef.value;
  }

  const { data: chats } = useLiveQuery(
    () => (chatDbKitRef.value ? chatDbKitRef.value.aiChats.getAll() : []),
    () => [chatDbKitRef.value] as const,
    [] as LocalAiChat[],
  );

  // Scoped to activeChatId — one live subscription for the open chat, not
  // one per chat in the list, mirroring `entities/chat`'s chat-store.
  const { data: messages, reset: resetMessages } = useLiveQuery(
    () => {
      if (!activeChatId.value || !chatDbKitRef.value) return [] as LocalAiMessage[];
      return chatDbKitRef.value.aiMessages.listByChat(activeChatId.value);
    },
    () => [activeChatId.value, chatDbKitRef.value] as const,
    [] as LocalAiMessage[],
  );

  /** Creates the chat in Dexie immediately — never waits on the model/network
   *  (plan §4.1 p.1). The local-ai mirror is created lazily by
   *  `ensureHistorySynced()` the first time the chat is opened or sent to. */
  async function createChat(title?: string): Promise<LocalAiChat> {
    const kit = getDbKit();
    const now = Date.now();
    const chat: LocalAiChat = {
      id: generateId(),
      title: title?.trim() || tRaw("ai.defaultChatTitle"),
      createdAt: now,
      updatedAt: now,
    };
    await kit.aiChats.create(chat);
    return chat;
  }

  /** Opens a chat and kicks off its local-ai history mirror in the
   *  background (roadmap 2.1 — chat-open is one of the two sanctioned
   *  `ensureClient()` triggers, alongside Settings → Local AI). Never
   *  blocks the UI switch on it. */
  function selectChat(chatId: string | null): void {
    if (activeChatId.value === chatId) return;
    resetMessages([]);
    activeChatId.value = chatId;
    if (chatId) {
      ensureHistorySynced(chatId).catch((e) => {
        console.warn("[ai-chat-store] ensureHistorySynced (select) failed:", e);
      });
    }
  }

  async function renameChat(chatId: string, title: string): Promise<void> {
    const kit = getDbKit();
    await kit.aiChats.rename(chatId, title);
    const localAi = useLocalAiStore();
    if (localAi.client) {
      localAi.client.upsertChat({ id: chatId, title }).catch((e) => {
        console.warn("[ai-chat-store] upsertChat (rename) failed:", e);
      });
    }
  }

  async function deleteChat(chatId: string): Promise<void> {
    const kit = getDbKit();
    if (activeChatId.value === chatId) selectChat(null);
    abortControllers.get(chatId)?.abort();
    abortControllers.delete(chatId);
    streamingContent.value.delete(chatId);
    historySyncedChatIds.delete(chatId);
    await kit.aiChats.delete(chatId);

    const localAi = useLocalAiStore();
    if (localAi.client) {
      localAi.client.deleteChat(chatId).catch((e) => {
        console.warn("[ai-chat-store] deleteChat (mirror) failed:", e);
      });
    }
  }

  /** Mirrors a chat's PRIOR Dexie history into local-ai once per session —
   *  one full `appendMessages`, subsequent turns only add the new pair
   *  (plan §2's high-water-mark note). Must run before this turn's new
   *  Dexie rows exist, or the in-flight assistant placeholder would get
   *  synced as if it were already-settled content. Safe to call repeatedly —
   *  a no-op once synced this session. */
  async function ensureHistorySynced(chatId: string): Promise<void> {
    if (historySyncedChatIds.has(chatId)) return;
    const kit = getDbKit();
    const localAi = useLocalAiStore();
    const address = useAuthStore().address;
    if (!address) return;

    const client = await localAi.ensureClient(address);
    const chat = await kit.aiChats.get(chatId);
    await client.upsertChat({ id: chatId, title: chat?.title ?? tRaw("ai.defaultChatTitle") });

    const history = await kit.aiMessages.listByChat(chatId);
    if (history.length > 0) {
      await client.appendMessages(
        chatId,
        history.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          status: m.status === "streaming" ? "complete" : (m.status as "complete" | "cancelled" | "error"),
          createdAt: new Date(m.createdAt).toISOString(),
          tokenCount: m.tokenCount,
        })),
      );
    }
    historySyncedChatIds.add(chatId);
  }

  /** Mode B send (plan §2): mirrors prior history first, THEN writes the new
   *  user/assistant pair to Dexie optimistically, streams tokens into
   *  `streamingContent` (not Dexie), checkpoints periodically, final write
   *  on `stream.result` (roadmap 3.3). `client.sendMessage()` persists the
   *  user message into local-ai's own store internally via `userMessageId` —
   *  no separate `appendMessages` call needed for it. */
  async function sendMessage(chatId: string, text: string): Promise<void> {
    const kit = getDbKit();
    const localAi = useLocalAiStore();
    if (localAi.isGenerating) {
      throw new Error("[ai-chat-store] Another AI chat is already generating a response");
    }
    // Claim the single-generation slot synchronously — no `await` between
    // the check above and this assignment. Two `sendMessage()` calls (e.g.
    // from two different open AI chats) racing through several awaited
    // steps (ensureClient/ensureHistorySynced/Dexie writes) before either
    // set the flag could otherwise both pass the check and both reach
    // `client.sendMessage()`, tripping the library's own `RuntimeBusyError`
    // for the loser instead of this store's `ai.busyOtherChat` UX.
    localAi.isGenerating = true;
    const controller = new AbortController();
    abortControllers.set(chatId, controller);

    try {
      const address = useAuthStore().address;
      if (!address) throw new Error("[ai-chat-store] No active account");

      const client = await localAi.ensureClient(address);
      await ensureHistorySynced(chatId);

      const now = Date.now();
      const userMessageId = generateId();
      const assistantMessageId = generateId();

      await kit.aiMessages.create({
        id: userMessageId,
        chatId,
        role: "user",
        content: text,
        status: "complete",
        createdAt: now,
      });
      await kit.aiMessages.create({
        id: assistantMessageId,
        chatId,
        role: "assistant",
        content: "",
        status: "streaming",
        createdAt: now + 1,
      });
      await kit.aiChats.touch(chatId, { lastMessagePreview: text.slice(0, 200), lastMessageTimestamp: now });

      streamingContent.value.set(chatId, "");
      streamingContent.value = new Map(streamingContent.value);

      await sendToRuntime(kit, client, chatId, text, userMessageId, assistantMessageId, controller);
    } finally {
      streamingContent.value.delete(chatId);
      streamingContent.value = new Map(streamingContent.value);
      abortControllers.delete(chatId);
      localAi.isGenerating = false;
    }
  }

  /** The actual streamed generation + Dexie settlement — split out of
   *  `sendMessage()` only so its own try/catch (cancel-vs-error semantics)
   *  doesn't nest inside `sendMessage()`'s claim/release try/finally. */
  async function sendToRuntime(
    kit: ChatDbKit,
    client: LocalAiClient,
    chatId: string,
    text: string,
    userMessageId: string,
    assistantMessageId: string,
    controller: AbortController,
  ): Promise<void> {
    let lastCheckpointAt = 0;
    const CHECKPOINT_INTERVAL_MS = 1000;

    try {
      const stream = client.sendMessage(chatId, text, {
        userMessageId,
        assistantMessageId,
        signal: controller.signal,
      });

      for await (const token of stream) {
        streamingContent.value.set(chatId, token.accumulatedContent);
        streamingContent.value = new Map(streamingContent.value);

        const nowMs = Date.now();
        if (nowMs - lastCheckpointAt >= CHECKPOINT_INTERVAL_MS) {
          lastCheckpointAt = nowMs;
          kit.aiMessages.updateContent(assistantMessageId, token.accumulatedContent).catch(() => {});
        }
      }

      const result = await stream.result;
      await kit.aiMessages.updateStatus(assistantMessageId, result.status, {
        content: result.content,
        tokenCount: result.tokenCount,
      });
      await kit.aiChats.touch(chatId, {
        lastMessagePreview: (result.content || text).slice(0, 200),
        lastMessageTimestamp: Date.now(),
      });
    } catch (e) {
      if (controller.signal.aborted) {
        // Our own AbortSignal was already tripped before this rejected —
        // either `cancelMessage()` or a logout/account-switch teardown
        // (`cleanup()` aborts in-flight controllers before
        // `releaseRuntime()` closes the client, roadmap 7.2). local-ai's own
        // cancel semantics keep partial content, but a same-tick teardown
        // race (e.g. its SQLite connection closing under it) can throw
        // before it gets to persist that partial content itself — fall back
        // to whatever we already streamed into `streamingContent`, and
        // treat this as a normal cancellation, not a generation error.
        await kit.aiMessages.updateStatus(assistantMessageId, "cancelled", {
          content: streamingContent.value.get(chatId) ?? "",
        }).catch(() => {});
      } else {
        // RuntimeBusyError/ContextWindowExceededError — generation never
        // started; the user's message stays as persisted above, only the
        // empty assistant placeholder needs an error status (roadmap 5.5).
        await kit.aiMessages.updateStatus(assistantMessageId, "error", { content: "" });
        console.warn("[ai-chat-store] sendMessage failed:", e);
        throw e;
      }
    }
  }

  /** Aborts an in-flight generation for `chatId` — local-ai resolves
   *  `stream.result` with `status: 'cancelled'` and the partial content kept
   *  as-is (ТЗ §9.8), no special handling needed on our side beyond what
   *  `sendMessage`'s `finally` already does. */
  function cancelMessage(chatId: string): void {
    abortControllers.get(chatId)?.abort();
  }

  /** Drops in-memory-only state on logout/account switch. Dexie rows are
   *  handled by `deleteChatDb()`/`closeChatDb()` at the call site, same as
   *  `chat-store`/`channel-store`'s `cleanup()`. */
  function cleanup(): void {
    for (const controller of abortControllers.values()) controller.abort();
    abortControllers.clear();
    streamingContent.value = new Map();
    historySyncedChatIds.clear();
    activeChatId.value = null;
    chatDbKitRef.value = null;
  }

  return {
    chats,
    activeChatId,
    messages,
    streamingContent,
    setChatDbKit,
    selectChat,
    createChat,
    renameChat,
    deleteChat,
    sendMessage,
    cancelMessage,
    ensureHistorySynced,
    cleanup,
  };
});
