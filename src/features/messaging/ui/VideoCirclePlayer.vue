<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import type { Message } from "@/entities/chat";
import { useFileDownload } from "../model/use-file-download";

interface Props {
  message: Message;
  isOwn: boolean;
}

const props = defineProps<Props>();

const { getState, download } = useFileDownload();
const fileCacheKey = computed(() => props.message._key || props.message.id);
const fileState = computed(() => getState(fileCacheKey.value));

const videoEl = ref<HTMLVideoElement | null>(null);
const containerEl = ref<HTMLDivElement | null>(null);
const isPlaying = ref(false);
const isMuted = ref(true);
const currentTime = ref(0);
const isLoaded = ref(false);
const showPlayIcon = ref(true);

const totalDuration = computed(() => props.message.fileInfo?.duration ?? 0);

const RING_RADIUS = 73;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

const progressOffset = computed(() => {
  if (totalDuration.value === 0) return RING_CIRCUMFERENCE;
  const ratio = currentTime.value / totalDuration.value;
  return RING_CIRCUMFERENCE * (1 - ratio);
});

const formatTime = (seconds: number) => {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
};

const displayTime = computed(() => {
  if (isPlaying.value || currentTime.value > 0) {
    return formatTime(totalDuration.value - currentTime.value);
  }
  return formatTime(totalDuration.value);
});

const videoSrc = computed(() => fileState.value.objectUrl);

let observer: IntersectionObserver | null = null;

const setupObserver = () => {
  if (!containerEl.value) return;
  observer = new IntersectionObserver(
    (entries) => {
      const entry = entries[0];
      if (!entry || !videoEl.value || !isLoaded.value) return;
      if (entry.isIntersecting) {
        videoEl.value.play().then(() => { isPlaying.value = true; showPlayIcon.value = false; }).catch(() => {});
      } else {
        videoEl.value.pause();
        isPlaying.value = false;
        showPlayIcon.value = true;
      }
    },
    { threshold: 0.5 },
  );
  observer.observe(containerEl.value);
};

const handleClick = () => {
  if (!videoEl.value || !isLoaded.value) return;
  if (isMuted.value) {
    isMuted.value = false;
    videoEl.value.muted = false;
    if (!isPlaying.value) {
      videoEl.value.play().then(() => { isPlaying.value = true; showPlayIcon.value = false; }).catch(() => {});
    }
    return;
  }
  if (isPlaying.value) {
    videoEl.value.pause();
    isPlaying.value = false;
    showPlayIcon.value = true;
  } else {
    videoEl.value.play().then(() => { isPlaying.value = true; showPlayIcon.value = false; }).catch(() => {});
  }
};

const onTimeUpdate = () => { if (videoEl.value) currentTime.value = videoEl.value.currentTime; };

const onEnded = () => {
  if (videoEl.value) {
    videoEl.value.currentTime = 0;
    videoEl.value.play().then(() => { isPlaying.value = true; }).catch(() => {});
  }
};

const onCanPlay = () => { isLoaded.value = true; };

watch(videoSrc, (url) => {
  if (url && videoEl.value) { videoEl.value.src = url; videoEl.value.load(); }
});

onMounted(() => {
  if (props.message.fileInfo?.url) download(props.message);
  setupObserver();
});

onUnmounted(() => {
  if (observer) { observer.disconnect(); observer = null; }
  if (videoEl.value) videoEl.value.pause();
});
</script>

<template>
  <div ref="containerEl" class="video-circle-container relative inline-block cursor-pointer" @click="handleClick">
    <video
      ref="videoEl"
      class="video-circle block h-[150px] w-[150px] object-cover sm:h-[200px] sm:w-[200px]"
      :src="videoSrc ?? undefined"
      muted
      playsinline
      preload="auto"
      @timeupdate="onTimeUpdate"
      @ended="onEnded"
      @canplay="onCanPlay"
    />

    <!-- SVG progress ring -->
    <svg class="pointer-events-none absolute left-0 top-0 h-[150px] w-[150px] -rotate-90 sm:h-[200px] sm:w-[200px]" viewBox="0 0 150 150">
      <circle cx="75" cy="75" :r="RING_RADIUS" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="3" />
      <circle class="progress-ring__circle" cx="75" cy="75" :r="RING_RADIUS" fill="none" stroke-width="3" stroke-linecap="round"
        :stroke-dasharray="RING_CIRCUMFERENCE" :stroke-dashoffset="progressOffset" />
    </svg>

    <!-- Loading spinner -->
    <div v-if="fileState.loading || (!isLoaded && videoSrc)" class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
      <div class="contain-strict h-8 w-8 animate-spin rounded-full border-[3px] border-white/50 border-t-white" />
    </div>

    <!-- Play icon -->
    <div v-else-if="showPlayIcon && isLoaded" class="absolute left-1/2 top-1/2 flex h-10 w-10 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/40">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="white"><polygon points="6 3 20 12 6 21 6 3" /></svg>
    </div>

    <!-- Duration badge -->
    <div class="absolute bottom-1.5 right-1.5 rounded-full bg-black/50 px-1.5 py-0.5 text-[10px] text-white tabular-nums">
      {{ displayTime }}
    </div>

    <!-- Muted indicator -->
    <div v-if="isPlaying && isMuted" class="absolute bottom-1.5 left-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/50">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="white">
        <path d="M11 5L6 9H2v6h4l5 4V5z" />
        <line x1="23" y1="9" x2="17" y2="15" stroke="white" stroke-width="2" stroke-linecap="round" />
        <line x1="17" y1="9" x2="23" y2="15" stroke="white" stroke-width="2" stroke-linecap="round" />
      </svg>
    </div>
  </div>
</template>

<style scoped>
.video-circle {
  clip-path: circle(50%);
}
.progress-ring__circle {
  stroke: rgb(var(--color-bg-ac));
  transition: stroke-dashoffset 0.1s linear;
}
</style>
