<script setup lang="ts">
import { ref, computed, toRef } from "vue";
import { useFeedVideoPlayer } from "@/shared/lib/use-feed-video-player";

interface Props {
  src: string | null;
  poster?: string;
  aspectRatio?: string;
  autoplay?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  aspectRatio: "16/9",
  autoplay: false,
});

const containerRef = ref<HTMLElement | null>(null);
const videoRef = ref<HTMLVideoElement | null>(null);

const {
  state,
  currentTime,
  duration,
  isMuted,
  togglePlay,
  toggleMute,
} = useFeedVideoPlayer({
  videoRef,
  containerRef,
  src: toRef(props, "src"),
  poster: props.poster,
  autoplay: props.autoplay,
});

const progress = computed(() =>
  duration.value > 0 ? (currentTime.value / duration.value) * 100 : 0,
);

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
</script>

<template>
  <div
    ref="containerRef"
    class="relative w-full cursor-pointer overflow-hidden rounded-lg bg-black"
    :style="{ aspectRatio }"
    @click="togglePlay"
  >
    <!-- Poster (idle state) -->
    <img
      v-if="state === 'idle' && poster"
      :src="poster"
      class="absolute inset-0 h-full w-full object-cover"
      alt=""
    />

    <!-- Video element -->
    <video
      ref="videoRef"
      class="absolute inset-0 h-full w-full object-cover"
      playsinline
      :muted="isMuted"
      preload="none"
    />

    <!-- Loading overlay -->
    <div v-if="state === 'loading'" class="absolute inset-0 flex items-center justify-center bg-black/30">
      <div class="h-10 w-10 shrink-0 contain-strict animate-spin rounded-full border-[3px] border-white/30 border-t-white" />
    </div>

    <!-- Play button (paused/ready/idle) -->
    <div
      v-if="state === 'ready' || state === 'paused' || (state === 'idle' && !poster)"
      class="absolute inset-0 flex items-center justify-center bg-black/30"
    >
      <button
        class="flex h-16 w-16 items-center justify-center rounded-full bg-black/50"
        aria-label="Play"
      >
        <svg viewBox="0 0 24 24" fill="white" class="ml-1 h-8 w-8">
          <path d="M8 5v14l11-7z" />
        </svg>
      </button>
    </div>

    <!-- Error overlay -->
    <div
      v-if="state === 'error'"
      class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/60"
      @click.stop
    >
      <svg viewBox="0 0 24 24" fill="none" class="h-8 w-8 text-white/70" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <span class="text-sm text-white/70">Ошибка воспроизведения</span>
      <button
        class="rounded-md bg-white/20 px-4 py-1.5 text-sm text-white hover:bg-white/30"
        @click.stop="togglePlay"
      >
        Повторить
      </button>
    </div>

    <!-- Controls bar (playing/paused with progress) -->
    <div
      v-if="state === 'playing' || (state === 'paused' && duration > 0)"
      class="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent p-2"
      @click.stop
    >
      <!-- Progress bar -->
      <div class="mb-1 h-[3px] rounded-full bg-white/30">
        <div
          class="h-full rounded-full bg-white transition-[width] duration-[250ms] ease-linear"
          :style="{ width: `${progress}%` }"
        />
      </div>

      <div class="flex items-center justify-between">
        <span class="text-xs tabular-nums text-white">
          {{ formatTime(currentTime) }} / {{ formatTime(duration) }}
        </span>
        <button
          class="flex h-6 w-6 items-center justify-center text-white"
          aria-label="Toggle mute"
          @click.stop="toggleMute"
        >
          <!-- Unmuted icon -->
          <svg v-if="!isMuted" viewBox="0 0 24 24" fill="white" class="h-4 w-4">
            <path d="M11 5L6 9H2v6h4l5 4V5z" />
            <path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" />
          </svg>
          <!-- Muted icon -->
          <svg v-else viewBox="0 0 24 24" fill="white" class="h-4 w-4">
            <path d="M11 5L6 9H2v6h4l5 4V5z" />
            <line x1="23" y1="9" x2="17" y2="15" stroke="white" stroke-width="2" stroke-linecap="round" />
            <line x1="17" y1="9" x2="23" y2="15" stroke="white" stroke-width="2" stroke-linecap="round" />
          </svg>
        </button>
      </div>
    </div>
  </div>
</template>
