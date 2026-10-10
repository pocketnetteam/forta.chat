<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { getKitchenCombos, loadKitchenRecipes, type KitchenCombo } from "@/shared/lib/emoji-kitchen";

const MAX_COMBOS = 30;

interface Props {
  selectedEmoji: string | null;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  select: [imageUrl: string];
}>();

const combos = ref<KitchenCombo[]>([]);
const visible = ref(false);

watch(
  () => props.selectedEmoji,
  (emoji) => {
    if (!emoji) {
      visible.value = false;
      // Let the leave transition play before clearing data
      setTimeout(() => {
        combos.value = [];
      }, 200);
      return;
    }
    showCombos(emoji);
  },
  { immediate: true },
);

function showCombos(emoji: string) {
  combos.value = getKitchenCombos(emoji).slice(0, MAX_COMBOS);
  visible.value = combos.value.length > 0;
}

// The dataset loads on first mount; an emoji picked before it arrives
// gets its combos once it does.
onMounted(() => {
  void loadKitchenRecipes().then(() => {
    if (props.selectedEmoji) showCombos(props.selectedEmoji);
  });
});
</script>

<template>
  <Transition name="kitchen-bar">
    <div
      v-if="visible && combos.length"
      class="kitchen-bar flex shrink-0 items-center gap-1 overflow-x-auto border-b border-neutral-grad-0 bg-background-total-theme px-2 py-1.5"
    >
      <button
        v-for="(combo, idx) in combos"
        :key="idx"
        class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg transition-all duration-150 hover:scale-110 hover:bg-neutral-grad-0"
        :title="combo.emoji"
        @click="emit('select', combo.imageUrl)"
      >
        <img
          :src="combo.imageUrl"
          :alt="combo.emoji"
          class="h-8 w-8"
          loading="lazy"
        />
      </button>
    </div>
  </Transition>
</template>

<style scoped>
/* Hide scrollbar but keep scrolling */
.kitchen-bar {
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.kitchen-bar::-webkit-scrollbar {
  display: none;
}

/* Slide-in / slide-out transition */
.kitchen-bar-enter-active,
.kitchen-bar-leave-active {
  transition:
    max-height 0.2s ease,
    opacity 0.2s ease;
  overflow: hidden;
}
.kitchen-bar-enter-from,
.kitchen-bar-leave-to {
  max-height: 0;
  opacity: 0;
}
.kitchen-bar-enter-to,
.kitchen-bar-leave-from {
  max-height: 56px;
  opacity: 1;
}
</style>
