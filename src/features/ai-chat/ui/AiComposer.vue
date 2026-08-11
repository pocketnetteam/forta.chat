<script setup lang="ts">
/**
 * Minimal text-only composer for AI chats. Deliberately NOT `MessageInput.vue`
 * (plan §7.3 anticipates either reusing it or "extracting/parametrizing the
 * send callback, not copying the whole component" — but `MessageInput.vue`
 * is a 1300+-line component hardwired to `useMessages()`/Matrix send, media
 * upload, voice/video recording, polls and GIFs, with no send-callback prop
 * to redirect, and it's under active parallel work per `CLAUDE.md`'s
 * keyboard-task constraint. Rather than risk a merge conflict by adding an
 * override seam to that file, or bloating it with an "AI mode" that hides
 * every Matrix-only affordance, this is a small dedicated component —
 * genuinely "not copying the whole component". It reuses the SAME shared,
 * global keyboard-safety mechanism `MessageInput.vue`'s own parent
 * (`ChatWindow.vue`) uses — the `safe-bottom` CSS class + `--keyboardheight`
 * custom property set by the app-wide keyboard composable — so it stays in
 * sync with the parallel keyboard work without touching any of its files. */
import { ref, computed } from "vue";
import { shouldSendOnEnter } from "@/features/messaging/model/enter-key-behavior";
import { isNative } from "@/shared/lib/platform";
import { useMobile } from "@/shared/lib/composables/use-media-query";

const isMobile = useMobile();

const props = defineProps<{
  disabled?: boolean;
  isGenerating?: boolean;
}>();

const emit = defineEmits<{
  send: [text: string];
  stop: [];
}>();

const { t } = useI18n();

const text = ref("");
const canSend = computed(() => text.value.trim().length > 0 && !props.disabled && !props.isGenerating);

function handleSend(): void {
  const value = text.value.trim();
  if (!value || props.disabled || props.isGenerating) return;
  text.value = "";
  emit("send", value);
}

function handleKeydown(e: KeyboardEvent): void {
  // Same rule as MessageInput.vue's composer (`shouldSendOnEnter`): IME
  // composition (CJK/swipe-confirm) never sends, mobile/native always
  // treats Enter as a newline (send only via the button).
  if (shouldSendOnEnter({ key: e.key, shiftKey: e.shiftKey, isComposing: e.isComposing, isMobile: isMobile.value, isNative })) {
    e.preventDefault();
    handleSend();
  }
}
</script>

<template>
  <div class="safe-bottom flex shrink-0 items-end gap-2 border-t border-neutral-grad-0 bg-background-total-theme px-3 py-2">
    <textarea
      v-model="text"
      rows="1"
      class="max-h-32 min-h-[40px] flex-1 resize-none rounded-2xl border border-neutral-grad-0 bg-neutral-grad-0 px-3.5 py-2 text-[15px] text-text-color outline-none placeholder:text-text-on-main-bg-color focus:border-color-bg-ac"
      :placeholder="t('ai.sendPlaceholder')"
      :disabled="props.disabled"
      @keydown="handleKeydown"
    />
    <button
      v-if="props.isGenerating"
      class="btn-press flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-color-bad text-white"
      :title="t('ai.stop')"
      :aria-label="t('ai.stop')"
      @click="emit('stop')"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <rect x="6" y="6" width="12" height="12" rx="2" />
      </svg>
    </button>
    <button
      v-else
      class="btn-press flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-color-bg-ac text-white transition-opacity disabled:opacity-40"
      :disabled="!canSend"
      :title="t('ai.send')"
      @click="handleSend"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="22" y1="2" x2="11" y2="13" />
        <polygon points="22 2 15 22 11 13 2 9 22 2" />
      </svg>
    </button>
  </div>
</template>
