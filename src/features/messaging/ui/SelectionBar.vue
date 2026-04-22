<script setup lang="ts">
import { useChatStore } from "@/entities/chat";

const { t } = useI18n();
const chatStore = useChatStore();

const selectedCount = computed(() => chatStore.selectedMessageIds.size);

const emit = defineEmits<{
  copy: [];
  delete: [];
  forward: [];
}>();
</script>

<template>
  <div class="flex h-14 shrink-0 items-center gap-1 border-t border-neutral-grad-0 bg-background-total-theme px-2 sm:gap-2 sm:px-3">
    <button
      class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-text-on-main-bg-color transition-colors hover:bg-neutral-grad-0"
      @click="chatStore.exitSelectionMode()"
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M18 6L6 18" /><path d="M6 6l12 12" />
      </svg>
    </button>

    <span class="min-w-0 flex-1 truncate text-sm font-medium text-text-color">
      {{ t("selection.selected", { count: selectedCount }) }}
    </span>

    <button
      class="flex h-9 shrink-0 items-center gap-1 rounded-lg px-2 text-sm text-text-color transition-colors hover:bg-neutral-grad-0 sm:gap-1.5 sm:px-3"
      :disabled="selectedCount === 0"
      @click="emit('copy')"
      :title="t('selection.copy')"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </svg>
      <span class="hidden sm:inline">{{ t("selection.copy") }}</span>
    </button>

    <button
      class="flex h-9 shrink-0 items-center gap-1 rounded-lg px-2 text-sm text-text-color transition-colors hover:bg-neutral-grad-0 sm:gap-1.5 sm:px-3"
      :disabled="selectedCount === 0"
      @click="emit('forward')"
      :title="t('selection.forward')"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="15 17 20 12 15 7" /><path d="M4 18v-2a4 4 0 0 1 4-4h12" />
      </svg>
      <span class="hidden sm:inline">{{ t("selection.forward") }}</span>
    </button>

    <button
      class="flex h-9 shrink-0 items-center gap-1 rounded-lg px-2 text-sm text-color-bad transition-colors hover:bg-neutral-grad-0 sm:gap-1.5 sm:px-3"
      :disabled="selectedCount === 0"
      @click="emit('delete')"
      :title="t('selection.delete')"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      </svg>
      <span class="hidden sm:inline">{{ t("selection.delete") }}</span>
    </button>
  </div>
</template>
