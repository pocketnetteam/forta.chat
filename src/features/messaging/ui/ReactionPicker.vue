<script setup lang="ts">
import { ref } from "vue";
import { useThemeStore } from "@/entities/theme";

const emit = defineEmits<{ select: [emoji: string] }>();

const themeStore = useThemeStore();

// Anti-double-fire guard: ignore repeated clicks on the same emoji within
// a short window. Protects against rapid taps / double-tap duplicating
// reactions before the parent can close the picker. Instance-scoped so
// multiple pickers in the DOM don't cross-cancel each other's clicks.
const DOUBLE_FIRE_WINDOW_MS = 400;
const lastEmoji = ref<string | null>(null);
const lastAt = ref(0);

const handleSelect = (emoji: string) => {
  const now = Date.now();
  if (lastEmoji.value === emoji && now - lastAt.value < DOUBLE_FIRE_WINDOW_MS) return;
  lastEmoji.value = emoji;
  lastAt.value = now;
  emit("select", emoji);
};
</script>

<template>
  <div class="flex items-center gap-1 rounded-full bg-background-total-theme px-2 py-1 shadow-lg">
    <button
      v-for="emoji in themeStore.quickReactions"
      :key="emoji"
      type="button"
      class="flex h-8 w-8 items-center justify-center rounded-full text-lg transition-transform hover:scale-125 hover:bg-neutral-grad-0"
      @click="handleSelect(emoji)"
    >
      {{ emoji }}
    </button>
  </div>
</template>
