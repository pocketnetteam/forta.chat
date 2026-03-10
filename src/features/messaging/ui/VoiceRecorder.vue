<script setup lang="ts">
import { ref, computed, watch } from "vue";
import type { RecorderState } from "../model/use-voice-recorder";

const { t } = useI18n();

interface Props {
  state: RecorderState;
  duration: number;
  waveformData: number[];
  recordedBlob: Blob | null;
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

const formatDuration = (seconds: number) => {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
};

// Track whether interaction came from touch (to prevent click firing after touch)
let wasTouch = false;

// Desktop click: start recording and immediately go to locked (hands-free) mode
const handleDesktopClick = () => {
  if (wasTouch) { wasTouch = false; return; }
  emit("startLocked");
};

// Gesture tracking for mic button
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

  // Swipe up > 80px = lock
  if (dy > 80) {
    emit("lock");
    return;
  }
  // Swipe left > 130px = cancel
  if (dx > 130) {
    isCancelling.value = true;
  }
};

const handleTouchEnd = () => {
  if (isCancelling.value) {
    emit("cancel");
    isCancelling.value = false;
    return;
  }
  if (props.state === "recording") {
    emit("stopAndSend");
  }
};

// Preview playback
const previewAudio = ref<HTMLAudioElement | null>(null);
const isPlaying = ref(false);

watch(() => props.recordedBlob, (blob) => {
  if (blob) {
    previewAudio.value = new Audio(URL.createObjectURL(blob));
    previewAudio.value.onended = () => { isPlaying.value = false; };
  } else {
    previewAudio.value = null;
    isPlaying.value = false;
  }
});

const togglePreviewPlay = () => {
  if (!previewAudio.value) return;
  if (isPlaying.value) {
    previewAudio.value.pause();
    isPlaying.value = false;
  } else {
    previewAudio.value.play();
    isPlaying.value = true;
  }
};

// Waveform bars for display
const waveformBars = computed(() => {
  const data = props.waveformData;
  if (data.length === 0) return Array(30).fill(0.05);
  const last = data.slice(-30);
  while (last.length < 30) last.unshift(0.05);
  return last;
});
</script>

<template>
  <!-- Recording state (hold-to-record on mobile) -->
  <div v-if="state === 'recording'" class="flex items-center gap-2 px-2 py-2">
    <span class="text-xs text-text-on-main-bg-color/60">&lt; Slide to cancel</span>
    <div class="flex flex-1 items-center gap-2">
      <span class="h-2.5 w-2.5 animate-pulse rounded-full bg-color-bad" />
      <span class="text-sm tabular-nums font-medium text-text-color">{{ formatDuration(duration) }}</span>
    </div>
    <!-- Live waveform -->
    <div class="flex h-8 items-end gap-px">
      <div
        v-for="(v, i) in waveformBars"
        :key="i"
        class="w-1 rounded-full bg-color-bg-ac transition-all"
        :style="{ height: `${Math.max(3, v * 32)}px` }"
      />
    </div>
    <!-- Lock hint -->
    <div class="flex flex-col items-center text-text-on-main-bg-color/40">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>
    </div>
  </div>

  <!-- Locked state (hands-free) -->
  <div v-else-if="state === 'locked'" class="flex items-center gap-2 px-2 py-2">
    <button
      class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-color-bad transition-colors hover:bg-neutral-grad-0"
      :title="t('voice.cancel')"
      @click="emit('cancel')"
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      </svg>
    </button>
    <div class="flex flex-1 items-center gap-2">
      <span class="h-2.5 w-2.5 animate-pulse rounded-full bg-color-bad" />
      <span class="text-sm tabular-nums font-medium text-text-color">{{ formatDuration(duration) }}</span>
    </div>
    <div class="flex h-8 items-end gap-px">
      <div
        v-for="(v, i) in waveformBars"
        :key="i"
        class="w-1 rounded-full bg-color-bg-ac transition-all"
        :style="{ height: `${Math.max(3, v * 32)}px` }"
      />
    </div>
    <button
      class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neutral-grad-0 text-text-color transition-all hover:bg-neutral-grad-1"
      :title="t('voice.stopAndPreview')"
      @click="emit('stopAndPreview')"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
    </button>
    <button
      class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-color-bg-ac text-white transition-all hover:brightness-110"
      title="Send"
      @click="emit('stopAndSend')"
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
        <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
      </svg>
    </button>
  </div>

  <!-- Preview state -->
  <div v-else-if="state === 'preview'" class="flex items-center gap-2 px-2 py-2">
    <button
      class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-color-bad transition-colors hover:bg-neutral-grad-0"
      title="Discard"
      @click="emit('cancel')"
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      </svg>
    </button>
    <button
      class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-color-bg-ac/10 text-color-bg-ac transition-colors hover:bg-color-bg-ac/20"
      @click="togglePreviewPlay"
    >
      <svg v-if="!isPlaying" width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>
      <svg v-else width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>
    </button>
    <span class="text-sm tabular-nums text-text-color">{{ formatDuration(duration) }}</span>
    <div class="flex-1" />
    <button
      class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-color-bg-ac text-white transition-all hover:brightness-110"
      title="Send"
      @click="emit('sendPreview')"
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
        <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
      </svg>
    </button>
  </div>

  <!-- Idle: mic button (to be placed in MessageInput) -->
  <button
    v-else
    class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-text-on-main-bg-color/60 transition-colors hover:text-text-on-main-bg-color"
    title="Voice message"
    @touchstart.prevent="handleTouchStart"
    @touchmove="handleTouchMove"
    @touchend="handleTouchEnd"
    @click="handleDesktopClick"
  >
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" /><line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  </button>
</template>
