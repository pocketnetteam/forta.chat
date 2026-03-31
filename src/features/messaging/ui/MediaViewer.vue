<script setup lang="ts">
import { ref, computed, watch } from "vue";
import type { Message } from "@/entities/chat";
import { useChatStore, MessageType } from "@/entities/chat";
import { useFileDownload } from "../model/use-file-download";
import { useAndroidBackHandler } from "@/shared/lib/composables/use-android-back-handler";

interface Props {
  show: boolean;
  messageId: string | null;
}

const props = defineProps<Props>();
const emit = defineEmits<{ close: [] }>();

const chatStore = useChatStore();
const { getState, download } = useFileDownload();

// Android back: close media viewer (highest overlay priority)
useAndroidBackHandler("media-viewer", 100, () => {
  if (!props.show) return false;
  emit("close");
  return true;
});

const currentIndex = ref(0);
const scale = ref(1);
const translateX = ref(0);
const translateY = ref(0);

const mediaMessages = computed(() => chatStore.activeMediaMessages);

watch(() => props.messageId, (id) => {
  if (id) {
    const idx = mediaMessages.value.findIndex(m => m.id === id);
    currentIndex.value = idx >= 0 ? idx : 0;
    resetTransform();
  }
});

const currentMessage = computed(() => mediaMessages.value[currentIndex.value] ?? null);
const currentUrl = computed(() => {
  if (!currentMessage.value) return null;
  const key = currentMessage.value._key || currentMessage.value.id;
  return getState(key).objectUrl;
});

const resetTransform = () => {
  scale.value = 1;
  translateX.value = 0;
  translateY.value = 0;
};

const goNext = () => {
  if (currentIndex.value < mediaMessages.value.length - 1) {
    currentIndex.value++;
    resetTransform();
  }
};

const goPrev = () => {
  if (currentIndex.value > 0) {
    currentIndex.value--;
    resetTransform();
  }
};

// Swipe navigation
let touchStartX = 0;
let touchStartY = 0;
let touchDeltaX = 0;

const onTouchstart = (e: TouchEvent) => {
  if (scale.value > 1) return; // Don't swipe when zoomed
  touchStartX = e.touches[0].clientX;
  touchStartY = e.touches[0].clientY;
  touchDeltaX = 0;
};

const onTouchmove = (e: TouchEvent) => {
  if (scale.value > 1) return;
  touchDeltaX = e.touches[0].clientX - touchStartX;
  const deltaY = e.touches[0].clientY - touchStartY;

  // Swipe down to dismiss
  if (Math.abs(deltaY) > 80 && Math.abs(deltaY) > Math.abs(touchDeltaX)) {
    emit("close");
    return;
  }
};

const onTouchend = () => {
  if (scale.value > 1) return;
  if (touchDeltaX > 60) goPrev();
  else if (touchDeltaX < -60) goNext();
  touchDeltaX = 0;
};

// Double-tap zoom
let lastTapTime = 0;
const handleDoubleTap = () => {
  const now = Date.now();
  if (now - lastTapTime < 300) {
    if (scale.value > 1) {
      resetTransform();
    } else {
      scale.value = 2;
    }
  }
  lastTapTime = now;
};

// Keyboard navigation
const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === "ArrowLeft") goPrev();
  else if (e.key === "ArrowRight") goNext();
  else if (e.key === "Escape") emit("close");
};

// Ensure media is downloaded
watch(currentMessage, async (msg) => {
  if (msg && msg.type === MessageType.image && msg.fileInfo && !getState(msg._key || msg.id).objectUrl) {
    await download(msg);
  }
});
</script>

<template>
  <Teleport to="body">
    <transition name="media-fade">
      <div
        v-if="props.show && currentMessage"
        class="fixed inset-0 z-50 flex flex-col bg-black safe-all"
        tabindex="0"
        @keydown="handleKeydown"
        @touchstart="onTouchstart"
        @touchmove="onTouchmove"
        @touchend="onTouchend"
      >
        <!-- Top bar -->
        <div class="flex h-12 shrink-0 items-center justify-between px-4">
          <button class="text-white/80 hover:text-white" @click="emit('close')">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 6L6 18" /><path d="M6 6l12 12" />
            </svg>
          </button>
          <span class="text-sm text-white/60">
            {{ currentIndex + 1 }} / {{ mediaMessages.length }}
          </span>
          <div class="w-6" />
        </div>

        <!-- Media content -->
        <div class="flex flex-1 items-center justify-center overflow-hidden" @click="handleDoubleTap">
          <img
            v-if="currentUrl && currentMessage.type === 'image'"
            :src="currentUrl"
            :alt="currentMessage.fileInfo?.name"
            class="max-h-full max-w-full object-contain transition-transform duration-200"
            :style="{ transform: `scale(${scale}) translate(${translateX}px, ${translateY}px)` }"
            draggable="false"
          />
          <video
            v-else-if="currentUrl && currentMessage.type === 'video'"
            :src="currentUrl"
            controls
            class="max-h-full max-w-full"
          />
          <div v-else class="flex items-center justify-center">
            <div class="h-8 w-8 animate-spin rounded-full border-2 border-white border-t-transparent" />
          </div>
        </div>

        <!-- Caption -->
        <div
          v-if="currentMessage.fileInfo?.caption"
          class="shrink-0 px-4 py-3 text-center text-sm text-white/90"
        >
          {{ currentMessage.fileInfo.caption }}
        </div>

        <!-- Navigation arrows (desktop) -->
        <button
          v-if="currentIndex > 0"
          class="absolute left-4 top-1/2 hidden -translate-y-1/2 rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20 md:flex"
          @click="goPrev"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <button
          v-if="currentIndex < mediaMessages.length - 1"
          class="absolute right-4 top-1/2 hidden -translate-y-1/2 rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20 md:flex"
          @click="goNext"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      </div>
    </transition>
  </Teleport>
</template>

<style scoped>
.media-fade-enter-active,
.media-fade-leave-active {
  transition: opacity 0.2s ease;
}
.media-fade-enter-from,
.media-fade-leave-to {
  opacity: 0;
}
</style>
