<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useChatStore } from "@/entities/chat";
import type { Message } from "@/entities/chat";

const props = defineProps<{ message: Message; isOwn?: boolean }>();
const chatStore = useChatStore();
const { t } = useI18n();

const isRetrying = ref(false);
let autoAttempted = false;

async function retry(): Promise<void> {
  if (isRetrying.value) return;
  // A stable Matrix eventId ($...) is required to look up the stored ciphertext.
  const eventId = props.message.id;
  if (!eventId || !eventId.startsWith("$")) return;
  isRetrying.value = true;
  try {
    // On success the parent liveQuery swaps this bubble for the decrypted
    // content and this component unmounts; on failure we drop back to idle.
    await chatStore.retryMessageDecryption(eventId);
  } finally {
    isRetrying.value = false;
  }
}

// Auto-attempt once when the undecrypted bubble appears.
onMounted(() => {
  if (autoAttempted) return;
  autoAttempted = true;
  void retry();
});
</script>

<template>
  <div
    class="flex items-center gap-1.5 text-sm italic"
    :class="props.isOwn ? 'text-white/70' : 'text-text-on-main-bg-color'"
  >
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="shrink-0">
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
    <span>{{ t('message.encryptedNotice') }}</span>
    <button
      type="button"
      class="ml-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-100"
      :class="props.isOwn ? 'hover:bg-white/15' : 'hover:bg-black/10'"
      :disabled="isRetrying"
      :aria-label="t('message.retryDecrypt')"
      :title="t('message.retryDecrypt')"
      @click.stop="retry"
    >
      <svg v-if="isRetrying" class="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2" stroke-opacity="0.25" />
        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      </svg>
      <svg v-else class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="23 4 23 10 17 10" />
        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
      </svg>
    </button>
  </div>
</template>
