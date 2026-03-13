<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from "vue";
import { searchGifs, getTrending, type TenorGif } from "@/shared/lib/tenor";

const emit = defineEmits<{ select: [gif: TenorGif]; close: [] }>();

const search = ref("");
const gifs = ref<TenorGif[]>([]);
const nextPos = ref("");
const loading = ref(false);
const loadingMore = ref(false);
const searchInputRef = ref<HTMLInputElement>();
const scrollContainerRef = ref<HTMLElement>();

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

// Load trending on mount
onMounted(async () => {
  await nextTick();
  searchInputRef.value?.focus();
  await loadTrending();
});

async function loadTrending() {
  loading.value = true;
  try {
    const result = await getTrending(20);
    gifs.value = result.gifs;
    nextPos.value = result.next;
  } catch (e) {
    console.error("Failed to load trending GIFs:", e);
  } finally {
    loading.value = false;
  }
}

async function performSearch(query: string) {
  if (!query.trim()) {
    await loadTrending();
    return;
  }
  loading.value = true;
  gifs.value = [];
  nextPos.value = "";
  try {
    const result = await searchGifs(query.trim(), 20);
    gifs.value = result.gifs;
    nextPos.value = result.next;
  } catch (e) {
    console.error("Failed to search GIFs:", e);
  } finally {
    loading.value = false;
  }
}

async function loadMore() {
  if (loadingMore.value || !nextPos.value) return;
  loadingMore.value = true;
  try {
    const query = search.value.trim();
    const result = query
      ? await searchGifs(query, 20, nextPos.value)
      : await getTrending(20, nextPos.value);
    gifs.value.push(...result.gifs);
    nextPos.value = result.next;
  } catch (e) {
    console.error("Failed to load more GIFs:", e);
  } finally {
    loadingMore.value = false;
  }
}

// Debounced search
watch(search, (val) => {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    performSearch(val);
  }, 300);
});

// Infinite scroll
function onScroll() {
  const el = scrollContainerRef.value;
  if (!el) return;
  const threshold = 200;
  if (el.scrollHeight - el.scrollTop - el.clientHeight < threshold) {
    loadMore();
  }
}

onBeforeUnmount(() => {
  if (debounceTimer) clearTimeout(debounceTimer);
});

function selectGif(gif: TenorGif) {
  emit("select", gif);
}
</script>

<template>
  <div class="gif-panel flex h-full flex-col overflow-hidden">
    <!-- Search -->
    <div class="shrink-0 px-3 pt-3 pb-2">
      <div class="relative">
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          class="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-grad-2"
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          ref="searchInputRef"
          v-model="search"
          type="text"
          placeholder="Search GIFs..."
          class="w-full rounded-xl bg-chat-input-bg py-2 pl-9 pr-3 text-sm text-text-color outline-none placeholder:text-neutral-grad-2 focus:ring-2 focus:ring-color-bg-ac/20"
        />
        <button
          v-if="search"
          class="absolute right-2 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full text-neutral-grad-2 hover:bg-neutral-grad-0 hover:text-text-color"
          @click="search = ''"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
          >
            <path d="M18 6L6 18" />
            <path d="M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>

    <!-- GIF grid -->
    <div
      ref="scrollContainerRef"
      class="min-h-0 flex-1 overflow-y-auto px-2 py-1"
      @scroll="onScroll"
    >
      <!-- Loading state -->
      <div v-if="loading" class="flex h-40 items-center justify-center">
        <div class="gif-spinner h-8 w-8 rounded-full border-2 border-neutral-grad-0 border-t-color-bg-ac" />
      </div>

      <!-- Empty state -->
      <div
        v-else-if="gifs.length === 0"
        class="flex h-40 flex-col items-center justify-center gap-2 text-text-on-main-bg-color/50"
      >
        <svg
          width="32"
          height="32"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          class="opacity-40"
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <span class="text-sm">No GIFs found</span>
      </div>

      <!-- Grid -->
      <div v-else class="grid grid-cols-2 gap-1.5">
        <button
          v-for="gif in gifs"
          :key="gif.id"
          class="gif-item group relative overflow-hidden rounded-lg"
          :style="{
            aspectRatio: `${gif.width} / ${gif.height}`,
          }"
          @click="selectGif(gif)"
        >
          <img
            :src="gif.previewUrl"
            :alt="gif.title"
            loading="lazy"
            class="h-full w-full object-cover transition-transform duration-150 group-hover:scale-105"
          />
          <div class="absolute inset-0 bg-black/0 transition-colors group-hover:bg-black/10" />
        </button>
      </div>

      <!-- Loading more spinner -->
      <div v-if="loadingMore" class="flex justify-center py-3">
        <div class="gif-spinner h-6 w-6 rounded-full border-2 border-neutral-grad-0 border-t-color-bg-ac" />
      </div>
    </div>

    <!-- Tenor attribution -->
    <div class="shrink-0 border-t border-neutral-grad-0/50 px-3 py-1.5 text-center">
      <span class="text-[10px] text-text-on-main-bg-color/40">Powered by KLIPY</span>
    </div>
  </div>
</template>

<style scoped>
.gif-spinner {
  animation: gif-spin 0.7s linear infinite;
}

@keyframes gif-spin {
  to {
    transform: rotate(360deg);
  }
}

.gif-item {
  cursor: pointer;
  background-color: rgba(128, 128, 128, 0.1);
}

.gif-item:active {
  transform: scale(0.97);
  transition: transform 0.1s ease;
}

/* Custom scrollbar */
.gif-panel ::-webkit-scrollbar {
  width: 6px;
}
.gif-panel ::-webkit-scrollbar-track {
  background: transparent;
}
.gif-panel ::-webkit-scrollbar-thumb {
  background: rgba(128, 128, 128, 0.3);
  border-radius: 3px;
}
.gif-panel ::-webkit-scrollbar-thumb:hover {
  background: rgba(128, 128, 128, 0.5);
}
</style>
