<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from "vue";
import type { VideoRecorderState } from "../model/use-video-circle-recorder";

interface Props {
  state: VideoRecorderState;
  duration: number;
  recordedBlob: Blob | null;
  videoStream: MediaStream | null;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  start: [];
  startLocked: [];
  stopAndSend: [];
  stopAndPreview: [];
  sendPreview: [];
  lock: [];
  cancel: [];
}>();

const MAX_DURATION = 60;
const RING_RADIUS = 118;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

const formatDuration = (seconds: number) => {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
};

const progressOffset = computed(() => {
  const progress = Math.min(props.duration / MAX_DURATION, 1);
  return RING_CIRCUMFERENCE * (1 - progress);
});

const isRecordingOrLocked = computed(() => props.state === "recording" || props.state === "locked");

// Touch vs click tracking
let wasTouch = false;

const handleDesktopClick = () => {
  if (wasTouch) { wasTouch = false; return; }
  emit("startLocked");
};

const touchStartY = ref(0);
const touchStartX = ref(0);
const isCancelling = ref(false);

const handleTouchStart = (e: TouchEvent) => {
  wasTouch = true;
  touchStartY.value = e.touches[0].clientY;
  touchStartX.value = e.touches[0].clientX;
  isCancelling.value = false;
  emit("start");
};

const handleTouchMove = (e: TouchEvent) => {
  if (props.state !== "recording") return;
  const dy = touchStartY.value - e.touches[0].clientY;
  const dx = touchStartX.value - e.touches[0].clientX;
  // Swipe up = lock (hands-free)
  if (dy > 80) { emit("lock"); return; }
  // Swipe left = cancel
  if (dx > 130) isCancelling.value = true;
};

const handleTouchEnd = () => {
  if (isCancelling.value) { emit("cancel"); isCancelling.value = false; return; }
  // Release = send
  if (props.state === "recording") emit("stopAndSend");
};

// Live camera preview
const liveVideoRef = ref<HTMLVideoElement | null>(null);

watch(() => props.videoStream, (stream) => {
  if (liveVideoRef.value) liveVideoRef.value.srcObject = stream;
});
watch(liveVideoRef, (el) => {
  if (el && props.videoStream) el.srcObject = props.videoStream;
});

// Preview playback
const previewVideoRef = ref<HTMLVideoElement | null>(null);
const previewUrl = ref<string | null>(null);

watch(() => props.recordedBlob, (blob) => {
  if (previewUrl.value) { URL.revokeObjectURL(previewUrl.value); previewUrl.value = null; }
  if (blob) previewUrl.value = URL.createObjectURL(blob);
});

onBeforeUnmount(() => {
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value);
});

// Cancel on overlay click (locked mode)
const handleOverlayClick = () => {
  if (props.state === "locked") emit("cancel");
};
</script>

<template>
  <!-- Recording state: nothing shown here, overlay is in MessageInput -->
  <div v-if="state === 'recording'" />

  <!-- Locked bar (hands-free) — Telegram style -->
  <div v-else-if="state === 'locked'" class="mx-auto flex max-w-6xl items-center gap-3 px-3 py-2.5">
    <div class="flex items-center gap-2">
      <span class="h-2.5 w-2.5 shrink-0 contain-strict animate-pulse rounded-full bg-color-bad" />
      <span class="text-sm tabular-nums font-medium text-text-color">{{ formatDuration(duration) }}</span>
    </div>
    <span class="flex-1 text-center text-xs text-text-on-main-bg-color/50">Press outside to cancel</span>
    <!-- Send button — big red circle -->
    <button
      class="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-color-bad text-white shadow-lg transition-all hover:brightness-110"
      title="Send"
      @click="emit('stopAndSend')"
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 19V5" /><path d="M5 12l7-7 7 7" />
      </svg>
    </button>
  </div>

  <!-- Preview state -->
  <div v-else-if="state === 'preview'" class="mx-auto flex max-w-6xl items-center gap-3 px-3 py-2.5">
    <button
      class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-color-bad transition-colors hover:bg-neutral-grad-0"
      title="Discard"
      @click="emit('cancel')"
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      </svg>
    </button>
    <!-- Small preview circle -->
    <div class="h-[52px] w-[52px] shrink-0 overflow-hidden rounded-full">
      <video v-if="previewUrl" ref="previewVideoRef" :src="previewUrl" loop autoplay muted playsinline class="h-full w-full object-cover" />
    </div>
    <span class="text-sm tabular-nums text-text-color">{{ formatDuration(duration) }}</span>
    <div class="flex-1" />
    <!-- Send button -->
    <button
      class="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-color-bad text-white shadow-lg transition-all hover:brightness-110"
      title="Send"
      @click="emit('sendPreview')"
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 19V5" /><path d="M5 12l7-7 7 7" />
      </svg>
    </button>
  </div>

  <!-- Idle: camera button -->
  <button
    v-else
    class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-text-on-main-bg-color/60 transition-colors hover:text-text-on-main-bg-color"
    title="Video message"
    @touchstart.prevent="handleTouchStart"
    @touchmove="handleTouchMove"
    @touchend="handleTouchEnd"
    @click="handleDesktopClick"
  >
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
      <path d="M23 7l-7 5 7 5V7z" /><rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
    </svg>
  </button>
</template>

<style scoped>
.progress-ring {
  stroke: rgb(var(--color-bg-ac));
  transition: stroke-dashoffset 0.3s ease;
}

.circle-overlay-enter-active {
  transition: opacity 0.25s ease;
}
.circle-overlay-leave-active {
  transition: opacity 0.2s ease;
}
.circle-overlay-enter-from,
.circle-overlay-leave-to {
  opacity: 0;
}
</style>
