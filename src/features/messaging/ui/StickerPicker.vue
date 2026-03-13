<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useStickerPacks, type Sticker } from "@/shared/lib/sticker-packs";

const emit = defineEmits<{ select: [sticker: Sticker] }>();

const { packs, loaded, loadStickerPacks } = useStickerPacks();
const activePackIndex = ref(0);

onMounted(() => {
  loadStickerPacks();
});

const handleSelect = (sticker: Sticker) => {
  emit("select", sticker);
};
</script>

<template>
  <div class="sticker-panel flex h-full flex-col overflow-hidden">
    <!-- Empty state -->
    <div
      v-if="loaded && packs.length === 0"
      class="flex flex-1 flex-col items-center justify-center gap-2 text-text-on-main-bg-color/50"
    >
      <svg
        width="32" height="32" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="1.5" class="opacity-40"
      >
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8.5" cy="9.5" r="1.5" />
        <circle cx="15.5" cy="9.5" r="1.5" />
        <path d="M9 15c.83.67 1.83 1 3 1s2.17-.33 3-1" />
      </svg>
      <span class="text-sm">No sticker packs available</span>
    </div>

    <!-- Loading state -->
    <div
      v-else-if="!loaded"
      class="flex flex-1 items-center justify-center text-text-on-main-bg-color/50"
    >
      <span class="text-sm">Loading stickers...</span>
    </div>

    <template v-else>
      <!-- Pack tabs -->
      <div class="flex shrink-0 gap-0.5 border-b border-neutral-grad-0/50 px-2 pb-1 pt-2">
        <button
          v-for="(pack, i) in packs"
          :key="pack.id"
          class="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-all duration-150"
          :class="activePackIndex === i
            ? 'bg-color-bg-ac/12 scale-110'
            : 'hover:bg-neutral-grad-0 opacity-70 hover:opacity-100'"
          :title="pack.name"
          @click="activePackIndex = i"
        >
          <img
            :src="pack.iconUrl"
            :alt="pack.name"
            class="h-6 w-6 object-contain"
          />
          <div
            v-if="activePackIndex === i"
            class="absolute -bottom-1 left-1/2 h-0.5 w-4 -translate-x-1/2 rounded-full bg-color-bg-ac"
          />
        </button>
      </div>

      <!-- Sticker grid -->
      <div class="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <div
          v-if="packs[activePackIndex]"
          class="grid grid-cols-4 gap-1"
        >
          <button
            v-for="sticker in packs[activePackIndex].stickers"
            :key="sticker.id"
            class="sticker-btn flex items-center justify-center rounded-lg p-1"
            @click="handleSelect(sticker)"
          >
            <img
              :src="sticker.url"
              :alt="sticker.id"
              class="h-16 w-16 object-contain"
              loading="lazy"
            />
          </button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.sticker-btn {
  transition: transform 0.1s ease, background-color 0.15s ease;
  cursor: pointer;
  border-radius: 8px;
}
.sticker-btn:hover {
  background-color: rgba(var(--neutral-grad-0), 0.5);
  transform: scale(1.1);
}
.sticker-btn:active {
  transform: scale(0.95);
}

/* Custom scrollbar */
.sticker-panel ::-webkit-scrollbar {
  width: 6px;
}
.sticker-panel ::-webkit-scrollbar-track {
  background: transparent;
}
.sticker-panel ::-webkit-scrollbar-thumb {
  background: rgba(128, 128, 128, 0.3);
  border-radius: 3px;
}
.sticker-panel ::-webkit-scrollbar-thumb:hover {
  background: rgba(128, 128, 128, 0.5);
}
</style>
