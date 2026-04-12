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
const hoveredId = ref<string | null>(null);
const previewGif = ref<TenorGif | null>(null); // fullscreen preview on long-press

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let requestId = 0; // cancel stale requests
let longPressTimer: ReturnType<typeof setTimeout> | null = null;
let longPressTriggered = false;

// Load trending on mount
onMounted(async () => {
  await nextTick();
  searchInputRef.value?.focus();
  await loadTrending();
});

async function loadTrending() {
  const id = ++requestId;
  loading.value = true;
  try {
    const result = await getTrending(24);
    if (id !== requestId) return; // stale
    gifs.value = result.gifs;
    nextPos.value = result.next;
  } catch (e) {
    if (id !== requestId) return;
    console.error("Failed to load trending GIFs:", e);
  } finally {
    if (id === requestId) loading.value = false;
  }
}

async function performSearch(query: string) {
  if (!query.trim()) {
    await loadTrending();
    return;
  }
  const id = ++requestId;
  loading.value = true;
  // Don't clear gifs — keep showing old results until new ones arrive
  try {
    const result = await searchGifs(query.trim(), 24);
    if (id !== requestId) return; // stale
    gifs.value = result.gifs;
    nextPos.value = result.next;
  } catch (e) {
    if (id !== requestId) return;
    console.error("Failed to search GIFs:", e);
  } finally {
    if (id === requestId) loading.value = false;
  }
}

async function loadMore() {
  if (loadingMore.value || !nextPos.value) return;
  const id = requestId; // don't increment — loadMore is continuation
  loadingMore.value = true;
  try {
    const query = search.value.trim();
    const result = query
      ? await searchGifs(query, 24, nextPos.value)
      : await getTrending(24, nextPos.value);
    if (id !== requestId) return;
    gifs.value.push(...result.gifs);
    nextPos.value = result.next;
  } catch (e) {
    if (id !== requestId) return;
    console.error("Failed to load more GIFs:", e);
  } finally {
    if (id === requestId) loadingMore.value = false;
  }
}

// Debounced search — 500ms to avoid spamming API while typing
watch(search, (val) => {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    performSearch(val);
  }, 500);
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
  if (longPressTimer) clearTimeout(longPressTimer);
  requestId++; // cancel any in-flight requests
});

function selectGif(gif: TenorGif) {
  // Don't select if long-press preview was just shown
  if (longPressTriggered) {
    longPressTriggered = false;
    return;
  }
  emit("select", gif);
}

// --- Touch long-press for mobile preview ---
function onTouchStart(gif: TenorGif) {
  longPressTriggered = false;
  longPressTimer = setTimeout(() => {
    longPressTriggered = true;
    previewGif.value = gif;
    hoveredId.value = gif.id; // also animate the grid item
  }, 300);
}

function onTouchEnd() {
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
  previewGif.value = null;
  hoveredId.value = null;
}

function onTouchMove() {
  // Cancel long-press if finger moves (scrolling)
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
  if (previewGif.value) {
    previewGif.value = null;
    hoveredId.value = null;
  }
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
      @scroll.passive="onScroll"
    >
      <!-- Loading state (only when no results yet) -->
      <div v-if="loading && gifs.length === 0" class="flex h-40 items-center justify-center">
        <div class="gif-spinner h-8 w-8 rounded-full border-2 border-neutral-grad-0 border-t-color-bg-ac" />
      </div>

      <!-- Empty state -->
      <div
        v-else-if="!loading && gifs.length === 0"
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

      <!-- Masonry grid: static jpg previews, animate on hover -->
      <div v-else class="gif-masonry">
        <button
          v-for="gif in gifs"
          :key="gif.id"
          class="gif-item group relative mb-1.5 w-full overflow-hidden rounded-lg"
          @mouseenter="hoveredId = gif.id"
          @mouseleave="hoveredId = null"
          @touchstart.passive="onTouchStart(gif)"
          @touchend="onTouchEnd()"
          @touchcancel="onTouchEnd()"
          @touchmove.passive="onTouchMove()"
          @click="selectGif(gif)"
        >
          <img
            :src="hoveredId === gif.id ? gif.animatedPreviewUrl : gif.previewUrl"
            :alt="gif.title"
            loading="lazy"
            class="block w-full rounded-lg"
          />
          <div class="absolute inset-0 rounded-lg bg-black/0 transition-colors group-hover:bg-black/10" />
        </button>
      </div>

      <!-- Fullscreen preview overlay (mobile long-press) -->
      <Teleport to="body">
        <transition name="gif-preview">
          <div
            v-if="previewGif"
            class="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm"
            @touchend="onTouchEnd()"
            @click="onTouchEnd()"
          >
            <div class="gif-preview-card mx-4 max-h-[70vh] max-w-[90vw] overflow-hidden rounded-2xl bg-background-total-theme shadow-2xl">
              <img
                :src="previewGif.animatedPreviewUrl"
                :alt="previewGif.title"
                class="block max-h-[65vh] w-full object-contain"
              />
              <div v-if="previewGif.title" class="px-3 py-2 text-center text-xs text-text-on-main-bg-color/60">
                {{ previewGif.title }}
              </div>
            </div>
          </div>
        </transition>
      </Teleport>

      <!-- Loading more spinner -->
      <div v-if="loadingMore" class="flex justify-center py-3">
        <div class="gif-spinner h-6 w-6 rounded-full border-2 border-neutral-grad-0 border-t-color-bg-ac" />
      </div>
    </div>

    <!-- KLIPY attribution -->
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

.gif-masonry {
  columns: 2;
  column-gap: 6px;
}

.gif-item {
  cursor: pointer;
  background-color: rgba(128, 128, 128, 0.1);
  break-inside: avoid;
}

.gif-item:active {
  transform: scale(0.97);
  transition: transform 0.1s ease;
}

/* Fullscreen preview transition */
.gif-preview-enter-active {
  transition: opacity 0.15s ease, transform 0.15s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.gif-preview-leave-active {
  transition: opacity 0.1s ease-in, transform 0.1s ease-in;
}
.gif-preview-enter-from {
  opacity: 0;
  transform: scale(0.85);
}
.gif-preview-leave-to {
  opacity: 0;
  transform: scale(0.9);
}
.gif-preview-enter-to,
.gif-preview-leave-from {
  opacity: 1;
  transform: scale(1);
}

.gif-preview-card {
  -webkit-user-select: none;
  user-select: none;
  touch-action: none;
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
