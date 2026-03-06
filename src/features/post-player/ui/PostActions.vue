<script setup lang="ts">
interface Props {
  totalComments: number;
  isOwnPost: boolean;
}

defineProps<Props>();

const emit = defineEmits<{
  boost: [];
  share: [];
  scrollToComments: [];
}>();

const { t } = useI18n();
</script>

<template>
  <div class="flex items-center gap-3 border-t border-gray-200/10 pt-3">
    <button
      v-if="!isOwnPost"
      class="flex items-center gap-1.5 rounded-lg bg-color-bg-ac/10 px-3 py-1.5 text-xs font-medium text-color-bg-ac transition-colors hover:bg-color-bg-ac/20"
      @click="emit('boost')"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
      </svg>
      {{ t("postPlayer.boost") }}
    </button>

    <button
      class="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-gray-400 transition-colors hover:bg-gray-500/10 hover:text-gray-300"
      @click="emit('scrollToComments')"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
      {{ totalComments }}
    </button>

    <button
      class="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-gray-400 transition-colors hover:bg-gray-500/10 hover:text-gray-300"
      @click="emit('share')"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
        <polyline points="16 6 12 2 8 6" />
        <line x1="12" y1="2" x2="12" y2="15" />
      </svg>
      {{ t("postPlayer.share") }}
    </button>
  </div>
</template>
