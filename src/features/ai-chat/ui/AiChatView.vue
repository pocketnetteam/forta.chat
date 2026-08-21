<script setup lang="ts">
/**
 * AI-chat window (roadmap 5.2-5.5) — a separate component, not a
 * `ChatWindow.vue` extension (plan §7.3): only text, only user/assistant,
 * streaming instead of instant delivery, no reactions/forwards/media in v1.
 */
import { computed, watch } from "vue";
import { useAiChatStore, parseThinking } from "@/entities/ai-chat";
import { useLocalAiStore } from "@/entities/local-ai";
import ChatVirtualScroller from "@/shared/ui/ChatVirtualScroller.vue";
import AiModelGate from "./AiModelGate.vue";
import AiComposer from "./AiComposer.vue";
import type { AiMessage } from "@/entities/ai-chat";

const props = defineProps<{ chatId: string }>();
const emit = defineEmits<{ back: [] }>();

const aiChatStore = useAiChatStore();
const localAiStore = useLocalAiStore();
const { t } = useI18n();

watch(
  () => props.chatId,
  (id) => aiChatStore.selectChat(id),
  { immediate: true },
);

const chat = computed(() => aiChatStore.chats.find((c) => c.id === props.chatId));

/** Satisfies `ChatVirtualScroller`'s `ChatVirtualItem` index signature —
 *  same pattern as `MessageList.vue`'s own `VirtualItem`. */
interface VirtualAiMessage extends AiMessage {
  [key: string]: unknown;
}

// ChatVirtualScroller expects [newest, …, oldest] (column-reverse) — Dexie
// returns oldest-first (createdAt asc).
const reversedItems = computed<VirtualAiMessage[]>(() =>
  [...aiChatStore.messages].reverse() as VirtualAiMessage[],
);

const isGeneratingHere = computed(
  () => localAiStore.isGenerating && aiChatStore.streamingContent.has(props.chatId),
);

function bubbleContent(message: AiMessage): string {
  if (message.status === "streaming") {
    return aiChatStore.streamingContent.get(props.chatId) ?? message.content;
  }
  return message.content;
}

/**
 * `local-ai` only strips `<think>...</think>` from the *final*, persisted
 * message — while streaming, `bubbleContent()` reads the raw, still-growing
 * token accumulation, so a reasoning model's tags render literally unless
 * parsed here too (see `parseThinking()`'s own doc comment, live bug
 * 2026-08-19). Applied uniformly to both streaming and settled messages —
 * settled content should already be clean, but this stays correct even if
 * it isn't.
 */
function parsedBubble(message: AiMessage) {
  return parseThinking(bubbleContent(message));
}

async function handleSend(text: string): Promise<void> {
  try {
    await aiChatStore.sendMessage(props.chatId, text);
  } catch (e) {
    console.warn("[AiChatView] sendMessage failed:", e);
  }
}

function handleStop(): void {
  aiChatStore.cancelMessage(props.chatId);
}
</script>

<template>
  <div class="relative flex h-full flex-col bg-background-total-theme">
    <!-- Header -->
    <div class="flex h-14 shrink-0 items-center gap-2 border-b border-neutral-grad-0 px-3">
      <button
        class="btn-press flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-text-on-main-bg-color hover:bg-neutral-grad-0"
        @click="emit('back')"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="15 18 9 12 15 6" />
        </svg>
      </button>
      <span class="truncate text-[15px] font-medium text-text-color">{{ chat?.title }}</span>
    </div>

    <!-- Model-not-ready banner (roadmap 5.4) — reuses AiModelGate, no duplicated logic -->
    <AiModelGate v-if="!localAiStore.modelReady" class="flex-1 overflow-y-auto" />

    <template v-else>
      <ChatVirtualScroller
        v-if="reversedItems.length > 0"
        :items="reversedItems"
        class="flex-1"
      >
        <template #default="{ item: message }">
          <div
            class="flex px-3 py-1"
            :class="message.role === 'user' ? 'justify-end' : 'justify-start'"
          >
            <div
              class="max-w-[80%] select-text rounded-2xl px-3.5 py-2 text-[15px] whitespace-pre-wrap break-words"
              :class="[
                message.role === 'user'
                  ? 'rounded-br-sm bg-chat-bubble-own text-text-on-bg-ac-color'
                  : 'rounded-bl-sm bg-chat-bubble-other text-text-color',
                message.status === 'error' ? 'opacity-60' : '',
              ]"
            >
              <span v-if="message.status === 'error'" class="flex items-center gap-1.5 text-xs italic">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                {{ t("ai.messageError") }}
              </span>
              <template v-else-if="message.status === 'streaming' && parsedBubble(message).isThinking">
                <!-- Only while genuinely live — a *settled* message with an
                     unclosed <think> tag is truncated historical data (e.g.
                     the old n_predict=50 bug), not something still
                     generating; falls through to the reasoning <details>
                     below instead of claiming to still be thinking forever. -->
                <span class="flex items-center gap-1.5 text-xs italic opacity-70">
                  <span class="inline-flex gap-0.5">
                    <span class="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:-0.3s]" />
                    <span class="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:-0.15s]" />
                    <span class="h-1 w-1 animate-bounce rounded-full bg-current" />
                  </span>
                  {{ t("ai.thinking") }}
                </span>
              </template>
              <template v-else>
                <details v-if="parsedBubble(message).thinking" class="mb-1.5 text-xs opacity-70">
                  <summary class="cursor-pointer select-none">{{ t("ai.reasoning") }}</summary>
                  <p class="mt-1 whitespace-pre-wrap italic">{{ parsedBubble(message).thinking }}</p>
                </details>
                {{ parsedBubble(message).answer }}
                <span
                  v-if="message.status === 'streaming'"
                  class="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-current align-middle"
                />
              </template>
            </div>
          </div>
        </template>
      </ChatVirtualScroller>
      <div v-else class="flex flex-1 items-center justify-center px-6 text-center text-sm text-text-on-main-bg-color">
        {{ t("ai.sendPlaceholder") }}
      </div>

      <p
        v-if="localAiStore.isGenerating && !isGeneratingHere"
        class="shrink-0 px-3 py-1 text-center text-xs text-text-on-main-bg-color"
      >
        {{ t("ai.busyOtherChat") }}
      </p>

      <AiComposer
        :disabled="localAiStore.isGenerating && !isGeneratingHere"
        :is-generating="isGeneratingHere"
        @send="handleSend"
        @stop="handleStop"
      />
    </template>
  </div>
</template>
